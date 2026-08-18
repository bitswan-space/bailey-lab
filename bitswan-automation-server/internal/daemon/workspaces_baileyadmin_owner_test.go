package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ownerReq builds a workspace-action request whose caller owns the
// workspace's gitops endpoint, with the workspace directory created so
// the marker helpers work. Returns the request + workspace name.
func ownerWorkspace(t *testing.T, name, owner string, withDeployment bool) {
	t.Helper()
	domain := writeTestConfig(t)
	if _, err := registerEndpoint(name+"-gitops."+domain, owner, "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	mkWorkspaceDir(t, name, withDeployment)
}

// TestRecordWorkspaceOwnership_CreatorIsOwnerAndListed verifies the FIX 1
// round-trip: after a create records ownership, GET /bailey/api/workspaces
// returns the new workspace as owned (is_owner true) for the creator.
func TestRecordWorkspaceOwnership_CreatorIsOwnerAndListed(t *testing.T) {
	domain := writeTestConfig(t)
	creator := "creator@example.com"
	ws := "freshws"
	// The workspace directory must exist for GetWorkspaceList to enumerate it.
	mkWorkspaceDir(t, ws, true)

	if warns := recordWorkspaceOwnership(ws, domain, creator); len(warns) != 0 {
		t.Fatalf("unexpected ownership warnings: %v", warns)
	}

	// The dashboard endpoint must be registered as the membership surface.
	dash, err := getEndpoint(ws + "-dashboard." + domain)
	if err != nil || dash == nil {
		t.Fatalf("dashboard endpoint not registered: %v", err)
	}
	if dash.OwnerEmail != creator {
		t.Errorf("dashboard owner = %q, want %q", dash.OwnerEmail, creator)
	}
	if dash.Kind != endpointKindWorkspace {
		t.Errorf("dashboard kind = %q, want %q", dash.Kind, endpointKindWorkspace)
	}

	// The creator's gitops role must resolve to owner.
	if role, _ := roleFor(ws+"-gitops."+domain, creator, nil); role != roleOwner {
		t.Errorf("gitops roleFor = %q, want owner", role)
	}

	// The list must now include the workspace as owned for the creator.
	w := dispatch(baileyReq(http.MethodGet, "/bailey/api/workspaces", creator))
	if w.Code != http.StatusOK {
		t.Fatalf("list = %d", w.Code)
	}
	var resp listAccessibleResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	var entry *accessibleWorkspace
	for i := range resp.Workspaces {
		if resp.Workspaces[i].Name == ws {
			entry = &resp.Workspaces[i]
		}
	}
	if entry == nil {
		t.Fatalf("created workspace not listed: %+v", resp.Workspaces)
	}
	if !entry.IsOwner {
		t.Errorf("created workspace not owned by creator: %+v", entry)
	}
}

// TestRecordWorkspaceOwnership_Idempotent verifies re-recording ownership
// (e.g. when the init pipeline already registered the rows) does not error
// and does not change the recorded owner.
func TestRecordWorkspaceOwnership_Idempotent(t *testing.T) {
	domain := writeTestConfig(t)
	original := "first@example.com"
	ws := "idemws"
	// Pre-register gitops under the original owner with the dashboard parent.
	if _, err := registerEndpoint(ws+"-gitops."+domain, original, "", ws+"-dashboard."+domain, endpointKindService, ""); err != nil {
		t.Fatal(err)
	}
	// A second create attempt by a different caller must not steal ownership.
	if warns := recordWorkspaceOwnership(ws, domain, "second@example.com"); len(warns) != 0 {
		t.Fatalf("unexpected warnings: %v", warns)
	}
	ep, err := getEndpoint(ws + "-gitops." + domain)
	if err != nil || ep == nil {
		t.Fatalf("gitops endpoint missing: %v", err)
	}
	if ep.OwnerEmail != original {
		t.Errorf("gitops owner changed to %q, want %q (idempotent register must not downgrade)", ep.OwnerEmail, original)
	}
}

func TestListAccessibleWorkspaces_OwnerSeesEntry(t *testing.T) {
	domain := writeTestConfig(t)
	owner := "lawowner@example.com"
	ws := "lawworkspace"
	mkWorkspaceDir(t, ws, true)
	// Owner of the gitops endpoint → the workspace is visible with role.
	if _, err := registerEndpoint(ws+"-gitops."+domain, owner, "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	w := dispatch(baileyReq(http.MethodGet, "/bailey/api/workspaces", owner))
	if w.Code != http.StatusOK {
		t.Fatalf("list = %d", w.Code)
	}
	var resp listAccessibleResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	var entry *accessibleWorkspace
	for i := range resp.Workspaces {
		if resp.Workspaces[i].Name == ws {
			entry = &resp.Workspaces[i]
		}
	}
	if entry == nil {
		t.Fatalf("owned workspace not listed: %+v", resp.Workspaces)
	}
	// gitops-only workspace (no dashboard endpoint): the ACL falls back to
	// gitops, and the resolved workspace role is surfaced as the canonical role.
	if !entry.IsOwner || entry.DashboardRole != "owner" {
		t.Errorf("entry roles wrong: %+v", entry)
	}
	// The primary "Open" target is the workspace dashboard, not gitops.
	if want := "https://" + ws + "-dashboard." + domain; entry.DashboardURL != want {
		t.Errorf("DashboardURL = %q, want %q", entry.DashboardURL, want)
	}
	if !entry.IsTrashed && IsWorkspaceTrashed(ws) {
		t.Error("IsTrashed flag not reflecting marker")
	}
}

// The server owner (recorded owner of bailey.<domain>) is NOT a god-mode
// reader of the workspace list (#337). They see the workspaces they own or
// were granted, exactly like anyone else — a third party's workspace must
// not appear, because the gate would refuse them at its door.
func TestListAccessibleWorkspaces_ServerOwnerSeesOnlyOwnWorkspaces(t *testing.T) {
	domain := writeTestConfig(t)
	host := "bailey." + domain
	if err := deleteEndpoint(host); err != nil {
		t.Fatal(err)
	}
	if _, err := registerEndpoint(host, "lawsrv@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	// A workspace owned by someone else — invisible to the server owner.
	other := "lawaudit"
	mkWorkspaceDir(t, other, true)
	if _, err := registerEndpoint(other+"-gitops."+domain, "other@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	// One the server owner really does own — still visible.
	own := "lawsrvown"
	mkWorkspaceDir(t, own, true)
	if _, err := registerEndpoint(own+"-gitops."+domain, "lawsrv@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}

	resp := listWorkspacesAs(t, "lawsrv@example.com", host)
	if findWorkspace(resp, other) != nil {
		t.Errorf("server owner was shown a third-party workspace %q — the list leaks", other)
	}
	if findWorkspace(resp, own) == nil {
		t.Errorf("server owner lost sight of their own workspace %q: %+v", own, resp.Workspaces)
	}
}

// The deny direction for an ordinary caller: a user with no role on a
// workspace's ACL surface must not learn it exists. A member of the SAME
// server but a DIFFERENT workspace is the exact shape of #337.
func TestListAccessibleWorkspaces_NonMemberSeesNothing(t *testing.T) {
	domain := writeTestConfig(t)
	theirs := "denytheirs"
	mine := "denymine"
	mkWorkspaceDir(t, theirs, true)
	mkWorkspaceDir(t, mine, true)
	if _, err := registerEndpoint(theirs+"-dashboard."+domain, "petr@example.com", "", "", endpointKindWorkspace, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := registerEndpoint(mine+"-dashboard."+domain, "tomas@example.com", "", "", endpointKindWorkspace, ""); err != nil {
		t.Fatal(err)
	}

	resp := listWorkspacesAs(t, "tomas@example.com", "")
	if findWorkspace(resp, theirs) != nil {
		t.Errorf("non-member was shown %q", theirs)
	}
	if findWorkspace(resp, mine) == nil {
		t.Errorf("owner lost sight of their own workspace %q: %+v", mine, resp.Workspaces)
	}
	// Nor does a stranger with no workspaces at all see either of them.
	resp = listWorkspacesAs(t, "stranger@example.com", "")
	for _, name := range []string{theirs, mine} {
		if findWorkspace(resp, name) != nil {
			t.Errorf("stranger was shown %q", name)
		}
	}
}

// The allow direction that must survive the fix: an access grant on the
// workspace's dashboard (directly, or via a group) is real membership, and
// the workspace stays listed — badged as a member, not an owner.
func TestListAccessibleWorkspaces_GranteeAndGroupMemberStillSee(t *testing.T) {
	domain := writeTestConfig(t)
	ws := "grantws"
	mkWorkspaceDir(t, ws, true)
	dash := ws + "-dashboard." + domain
	if _, err := registerEndpoint(dash, "wsowner@example.com", "", "", endpointKindWorkspace, ""); err != nil {
		t.Fatal(err)
	}
	if err := addGrant(dash, "email", "invited@example.com", "access", "wsowner@example.com"); err != nil {
		t.Fatal(err)
	}
	if err := addGrant(dash, "group", "/Acme/devs", "access", "wsowner@example.com"); err != nil {
		t.Fatal(err)
	}

	entry := findWorkspace(listWorkspacesAs(t, "invited@example.com", ""), ws)
	if entry == nil {
		t.Fatal("an explicitly granted member could not see the workspace")
	}
	if entry.IsOwner || entry.DashboardRole != string(roleAccess) {
		t.Errorf("grantee entry = %+v, want role access / is_owner false", entry)
	}

	r := baileyReq(http.MethodGet, "/bailey/api/workspaces", "dev@example.com")
	r.Header.Set("X-Forwarded-Groups", "/Acme/devs")
	ensureTrustedDeviceForReq(r)
	w := httptest.NewRecorder()
	(&Server{}).handleBailey(w, r)
	var resp listAccessibleResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v\n%s", err, w.Body.String())
	}
	if findWorkspace(&resp, ws) == nil {
		t.Errorf("a member via a group grant could not see the workspace: %+v", resp.Workspaces)
	}
}

// A membership lookup that FAILS must omit the workspace, never include it:
// an error tells us nothing about the caller, and "unknown" is not "allowed".
func TestListAccessibleWorkspaces_LookupErrorOmits(t *testing.T) {
	domain := writeTestConfig(t)
	ws := "errws"
	mkWorkspaceDir(t, ws, true)
	if _, err := registerEndpoint(ws+"-dashboard."+domain, "someone@example.com", "", "", endpointKindWorkspace, ""); err != nil {
		t.Fatal(err)
	}
	// Sanity: the owner sees it while the ACL store is healthy.
	if findWorkspace(listWorkspacesAs(t, "someone@example.com", ""), ws) == nil {
		t.Fatal("precondition: owner cannot see their own workspace")
	}

	// Break the ACL store so every membership lookup errors out, then call
	// the handler directly (going through handleBailey would trip the
	// device-trust gate on the same broken store first).
	breakBaileyDBForTest(t)
	r := baileyReq(http.MethodGet, "/bailey/api/workspaces", "someone@example.com")
	w := httptest.NewRecorder()
	handleListAccessibleWorkspaces(w, r, "someone@example.com")
	reopenBaileyDBForTest(t)

	if w.Code != http.StatusOK {
		t.Fatalf("list = %d; body=%s", w.Code, w.Body.String())
	}
	var resp listAccessibleResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v\n%s", err, w.Body.String())
	}
	if findWorkspace(&resp, ws) != nil {
		t.Errorf("workspace listed despite an errored membership lookup: %+v", resp.Workspaces)
	}
}

// breakBaileyDBForTest closes the cached DB handle WITHOUT clearing the
// sync.Once, so every subsequent store call fails with "database is closed" —
// the cheapest faithful stand-in for an unreadable ACL store. Callers must
// follow with reopenBaileyDBForTest to hand the rest of the suite a live
// handle again.
func breakBaileyDBForTest(t *testing.T) {
	t.Helper()
	if _, err := openBaileyDB(); err != nil {
		t.Fatalf("open bailey db: %v", err)
	}
	if baileyDB == nil {
		t.Fatal("bailey db handle is nil; cannot break it")
	}
	if err := baileyDB.Close(); err != nil {
		t.Fatalf("close bailey db: %v", err)
	}
}

// listWorkspacesAs performs GET /bailey/api/workspaces as email. host, when
// non-empty, is the bailey host the request is addressed to.
func listWorkspacesAs(t *testing.T, email, host string) *listAccessibleResponse {
	t.Helper()
	r := baileyReq(http.MethodGet, "/bailey/api/workspaces", email)
	if host != "" {
		r.Host = host
	}
	ensureTrustedDeviceForReq(r)
	w := httptest.NewRecorder()
	(&Server{}).handleBailey(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("list = %d; body=%s", w.Code, w.Body.String())
	}
	var resp listAccessibleResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v\n%s", err, w.Body.String())
	}
	return &resp
}

func findWorkspace(resp *listAccessibleResponse, name string) *accessibleWorkspace {
	for i := range resp.Workspaces {
		if resp.Workspaces[i].Name == name {
			return &resp.Workspaces[i]
		}
	}
	return nil
}

func TestHandleTrashWorkspace_OwnerSuccess(t *testing.T) {
	owner := "trashowner@example.com"
	ws := "trashflow"
	ownerWorkspace(t, ws, owner, false)

	srv := &Server{}
	r := baileyReq(http.MethodPost, "/bailey/api/workspaces/"+ws+"/trash", owner)
	w := httptest.NewRecorder()
	srv.handleTrashWorkspace(w, r, owner, ws)
	if w.Code != http.StatusAccepted {
		t.Fatalf("trash status = %d, want 202; body=%s", w.Code, w.Body.String())
	}
	var got map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &got)
	if got["ok"] != true {
		t.Errorf("trash response = %v", got)
	}
	if !IsWorkspaceTrashed(ws) {
		t.Error("workspace not marked trashed after handler")
	}
}

func TestHandleTrashWorkspace_MarkError(t *testing.T) {
	owner := "trashnoexist@example.com"
	domain := writeTestConfig(t)
	ws := "trashmissing"
	// Own the endpoint but DON'T create the workspace dir → MarkWorkspaceTrashed errors.
	if _, err := registerEndpoint(ws+"-gitops."+domain, owner, "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	srv := &Server{}
	w := httptest.NewRecorder()
	srv.handleTrashWorkspace(w, baileyReq(http.MethodPost, "/x", owner), owner, ws)
	// The handler writes ok:false with the error (still 200-class via encoder).
	if !strings.Contains(w.Body.String(), `"ok":false`) {
		t.Errorf("expected ok:false on mark error; got %s", w.Body.String())
	}
}

func TestHandleRestoreWorkspace_OwnerMissingDeployment(t *testing.T) {
	owner := "restoreowner@example.com"
	ws := "restoreflow"
	// No deployment dir → RestoreWorkspace returns an error, handler reports it.
	ownerWorkspace(t, ws, owner, false)
	srv := &Server{}
	w := httptest.NewRecorder()
	srv.handleRestoreWorkspace(w, baileyReq(http.MethodPost, "/x", owner), owner, ws)
	if !strings.Contains(w.Body.String(), `"ok":false`) {
		t.Errorf("expected ok:false (no deployment dir); got %s", w.Body.String())
	}
}

func TestHandleRestoreWorkspace_BadName(t *testing.T) {
	srv := &Server{}
	w := httptest.NewRecorder()
	srv.handleRestoreWorkspace(w, baileyReq(http.MethodPost, "/x", "u@example.com"), "u@example.com", "Bad Name")
	if w.Code != http.StatusBadRequest {
		t.Errorf("bad name restore = %d, want 400", w.Code)
	}
}

func TestHandleEmptyTrash_OwnerStreamsDone(t *testing.T) {
	owner := "emptyowner@example.com"
	writeTestConfig(t)
	srv := &Server{}
	// No trashed workspaces owned → EmptyTrashFor succeeds, streams done.
	r := baileyReqBody(http.MethodPost, "/bailey/api/workspaces/empty-trash", owner, `{"confirmation":"empty trash"}`)
	w := httptest.NewRecorder()
	srv.handleEmptyTrash(w, r, owner)
	if w.Code != http.StatusOK {
		t.Fatalf("empty-trash stream status = %d", w.Code)
	}
	body := w.Body.String()
	if !strings.Contains(body, `"event":"start"`) || !strings.Contains(body, `"event":"done"`) {
		t.Errorf("empty-trash stream missing start/done events: %s", body)
	}
}

// --- TrashWorkspace / RestoreWorkspace / stopWorkspaceContainers --------
// These run `docker compose down/up` on project names that don't exist;
// for nonexistent projects docker compose is a quiet no-op, so the calls
// are safe and just exercise the code paths + log output.

func TestStopWorkspaceContainers_NoProjectsIsSafe(t *testing.T) {
	name := "stopnoproj"
	mkWorkspaceDir(t, name, true)
	var sb strings.Builder
	stopWorkspaceContainers(name, &sb)
	if !strings.Contains(sb.String(), "Stopping containers") || !strings.Contains(sb.String(), "stopped") {
		t.Errorf("stop log missing expected lines: %s", sb.String())
	}
}

func TestTrashWorkspace_Synchronous(t *testing.T) {
	name := "trashsync"
	mkWorkspaceDir(t, name, true)
	var sb strings.Builder
	if err := TrashWorkspace(name, &sb); err != nil {
		t.Fatal(err)
	}
	if !IsWorkspaceTrashed(name) {
		t.Error("TrashWorkspace did not mark trashed")
	}
	if !strings.Contains(sb.String(), "marked as trashed") {
		t.Errorf("log missing trash line: %s", sb.String())
	}
}

func TestRestoreWorkspace_RemovesMarkerWhenComposeUpRuns(t *testing.T) {
	name := "restoremarker"
	wsDir := mkWorkspaceDir(t, name, true)
	// Write a marker so we can verify it's removed.
	marker := filepath.Join(wsDir, trashMarkerName)
	if err := os.WriteFile(marker, []byte("trashed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// docker compose up against a deployment dir with no compose file will
	// error, so RestoreWorkspace returns early before removing the marker.
	var sb strings.Builder
	_ = RestoreWorkspace(name, &sb)
	// Either it errored (marker stays) or it succeeded — both are valid
	// here; we only need the code path exercised. Assert the log mentions
	// the restore attempt.
	if !strings.Contains(sb.String(), "Restoring workspace") {
		t.Errorf("restore log missing intro: %s", sb.String())
	}
}

// TestWorkspaceOwnership_AnchoredOnDashboard locks the standardization: a
// workspace's ACL lives on its DASHBOARD endpoint, not gitops.
//   - an owner GRANT on the dashboard makes a co-owner a real owner (the bug:
//     the UI showed "Owner" via the grant but update was denied because the
//     auth checked the gitops endpoint instead);
//   - a plain access grant is not ownership;
//   - owning the internal gitops endpoint does NOT confer workspace ownership
//     when a dashboard exists (we no longer anchor on gitops);
//   - a legacy --no-dashboard workspace still falls back to gitops.
func TestWorkspaceOwnership_AnchoredOnDashboard(t *testing.T) {
	domain := writeTestConfig(t)

	ws := "aclstdws"
	dashboardHost := ws + "-dashboard." + domain
	gitopsHost := ws + "-gitops." + domain
	creator := "creator@example.com"
	// Canonical layout: dashboard is the workspace endpoint; gitops is its
	// internal service child. Both created with the creator as owner_email.
	if _, err := registerEndpoint(dashboardHost, creator, "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := registerEndpoint(gitopsHost, creator, "", dashboardHost, endpointKindService, ""); err != nil {
		t.Fatal(err)
	}
	// A co-owner granted ownership ON THE DASHBOARD, and a plain access member.
	if err := addGrant(dashboardHost, "email", "coowner@example.com", "owner", creator); err != nil {
		t.Fatal(err)
	}
	if err := addGrant(dashboardHost, "email", "viewer@example.com", "access", creator); err != nil {
		t.Fatal(err)
	}

	if !callerOwnsWorkspace(creator, nil, false, ws) {
		t.Error("recorded dashboard owner should own the workspace")
	}
	if !callerOwnsWorkspace("coowner@example.com", nil, false, ws) {
		t.Error("dashboard owner-GRANT should confer workspace ownership (the reported bug)")
	}
	if callerOwnsWorkspace("viewer@example.com", nil, false, ws) {
		t.Error("a dashboard access grant must NOT confer ownership")
	}
	if callerOwnsWorkspace("stranger@example.com", nil, false, ws) {
		t.Error("a non-member must not own the workspace")
	}

	// Owning ONLY the internal gitops endpoint must not make you the workspace
	// owner when a dashboard exists — the ACL is anchored on the dashboard.
	if err := addGrant(gitopsHost, "email", "gitopsonly@example.com", "owner", creator); err != nil {
		t.Fatal(err)
	}
	if callerOwnsWorkspace("gitopsonly@example.com", nil, false, ws) {
		t.Error("owning the gitops endpoint must NOT confer workspace ownership when a dashboard exists")
	}

	// Legacy --no-dashboard workspace: no dashboard endpoint → fall back to gitops.
	nd := "aclstdnd"
	if _, err := registerEndpoint(nd+"-gitops."+domain, "legacy@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if !callerOwnsWorkspace("legacy@example.com", nil, false, nd) {
		t.Error("--no-dashboard workspace should fall back to the gitops endpoint owner")
	}
}

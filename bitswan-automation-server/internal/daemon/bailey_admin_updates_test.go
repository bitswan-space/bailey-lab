package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newRecorder() *httptest.ResponseRecorder { return httptest.NewRecorder() }

// stubStaleWorkspaces installs a fixed workspace inventory for the
// ACL-filtered views and makes every named workspace look STALE, so a view
// that lists "workspaces with an update available" actually has rows to list.
//
// Without it those loops run zero times (#367): GetWorkspaceList walks the
// real machine, which under test has no workspaces, and staleness is decided
// against Docker Hub, which a test must not reach. A handler whose loop never
// runs cannot prove that it lists what the caller owns — or that it withholds
// what it doesn't — so every assertion inside the loop is vacuously true.
//
// Both halves are asserted here, loudly: the inventory the handler reads, and
// the "an update is available" verdict for each entry.
func stubStaleWorkspaces(t *testing.T, names ...string) {
	t.Helper()

	// Pin the latest tags so staleness is a local decision (resolveLatestVersions
	// otherwise queries Docker Hub).
	latestVerMu.Lock()
	prevLatest := latestVerCache
	latestVerCache = latestVersions{gitops: "2026.08.10-latest", dashboard: "2026.08.10-latest", at: time.Now()}
	latestVerMu.Unlock()
	t.Cleanup(func() {
		latestVerMu.Lock()
		latestVerCache = prevLatest
		latestVerMu.Unlock()
	})

	list := &WorkspaceListResponse{}
	for _, name := range names {
		wsDir := mkWorkspaceDir(t, name, true)
		compose := filepath.Join(wsDir, "deployment", "docker-compose.yml")
		body := "services:\n  bitswan-gitops:\n    image: bitswan/bitswan-gitops:2026.01.01-old\n"
		if err := os.WriteFile(compose, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		list.Workspaces = append(list.Workspaces, WorkspaceInfo{Name: name})
	}

	prevInventory := workspaceInventory
	workspaceInventory = func() (*WorkspaceListResponse, error) { return list, nil }
	t.Cleanup(func() { workspaceInventory = prevInventory })

	for _, name := range names {
		if wv := detectWorkspaceVersions(name); !wv.UpdateAvailable {
			t.Fatalf("test setup: workspace %q does not look stale (%+v); the view would list nothing", name, wv)
		}
	}
}

func TestAdminDefaultImages_NonAdminForbidden(t *testing.T) {
	if w := dispatch(baileyReq(http.MethodGet, "/bailey/api/admin/default-images", "user@example.com")); w.Code != http.StatusForbidden {
		t.Errorf("GET non-admin = %d, want 403", w.Code)
	}
	if w := dispatch(baileyReqBody(http.MethodPost, "/bailey/api/admin/default-images", "user@example.com", "{}")); w.Code != http.StatusForbidden {
		t.Errorf("POST non-admin = %d, want 403", w.Code)
	}
}

func TestAdminDefaultImages_GetReturnsBothKeys(t *testing.T) {
	// Seed a configured override for gitops so the Configured branch runs.
	if err := dbSetSetting(settingDefaultGitopsImage, "bitswan/gitops:custom", "admin@example.com"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dbDeleteSetting(settingDefaultGitopsImage) })

	w := dispatchSrv(baileyReq(http.MethodGet, "/bailey/api/admin/default-images", "boss@example.com", adminGrp))
	if w.Code != http.StatusOK {
		t.Fatalf("GET status = %d; body=%s", w.Code, w.Body.String())
	}
	var out map[string]imageSettingResponse
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v\n%s", err, w.Body.String())
	}
	gitops, ok := out[settingDefaultGitopsImage]
	if !ok {
		t.Fatal("gitops key missing from response")
	}
	if gitops.Configured == nil || gitops.Configured.Value != "bitswan/gitops:custom" {
		t.Errorf("configured gitops = %+v", gitops.Configured)
	}
	if gitops.Effective != "bitswan/gitops:custom" {
		t.Errorf("effective = %q, want the override", gitops.Effective)
	}
	if _, ok := out[settingDefaultDashboardImage]; !ok {
		t.Error("dashboard key missing from response")
	}
}

func TestAdminDefaultImages_PostSetAndClear_DirectHandler(t *testing.T) {
	_ = dbDeleteSetting(settingDefaultGitopsImage)
	srv := &Server{}

	// Set.
	r := baileyReqBody(http.MethodPost, "/bailey/api/admin/default-images", "admin@example.com",
		`{"gitops_image":"bitswan/gitops:v9"}`)
	w := newRecorder()
	srv.handleAdminDefaultImagesPost(w, r, "admin@example.com")
	if w.Code != http.StatusOK {
		t.Fatalf("set status = %d; body=%s", w.Code, w.Body.String())
	}
	if v, _ := dbGetSetting(settingDefaultGitopsImage); v != "bitswan/gitops:v9" {
		t.Errorf("setting not written: %q", v)
	}

	// Clear with empty string.
	r2 := baileyReqBody(http.MethodPost, "/bailey/api/admin/default-images", "admin@example.com",
		`{"gitops_image":""}`)
	w2 := newRecorder()
	srv.handleAdminDefaultImagesPost(w2, r2, "admin@example.com")
	if w2.Code != http.StatusOK {
		t.Fatalf("clear status = %d", w2.Code)
	}
	if v, _ := dbGetSetting(settingDefaultGitopsImage); v != "" {
		t.Errorf("setting not cleared: %q", v)
	}

	// Bad body → 400.
	rBad := baileyReqBody(http.MethodPost, "/bailey/api/admin/default-images", "admin@example.com", "{")
	wBad := newRecorder()
	srv.handleAdminDefaultImagesPost(wBad, rBad, "admin@example.com")
	if wBad.Code != http.StatusBadRequest {
		t.Errorf("bad body = %d, want 400", wBad.Code)
	}
}

func TestImageKindToRepoMapping(t *testing.T) {
	if imageKindToRepo[settingDefaultGitopsImage] != "bitswan/gitops" {
		t.Error("gitops repo mapping wrong")
	}
	if imageKindToRepo[settingDefaultDashboardImage] != "bitswan/workspace-dashboard" {
		t.Error("dashboard repo mapping wrong")
	}
}

func TestUpdateWorkspace_ValidationAndAuthz(t *testing.T) {
	domain := writeTestConfig(t)
	srv := &Server{}

	// Invalid name → 400 (direct handler call).
	wBad := newRecorder()
	srv.handleUpdateWorkspace(wBad, baileyReq(http.MethodPost, "/x", "u@example.com"), "u@example.com", "Bad Name")
	if wBad.Code != http.StatusBadRequest {
		t.Errorf("invalid name = %d, want 400", wBad.Code)
	}

	// Non-owner → 403.
	ws := "updws"
	if _, err := registerEndpoint(ws+"-gitops."+domain, "real@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	wForbid := newRecorder()
	r := baileyReq(http.MethodPost, "/x", "intruder@example.com")
	srv.handleUpdateWorkspace(wForbid, r, "intruder@example.com", ws)
	if wForbid.Code != http.StatusForbidden {
		t.Errorf("non-owner update = %d, want 403", wForbid.Code)
	}

	// Owner but missing deployment dir → NDJSON stream with an error event.
	wsOwned := "updwsowned"
	if _, err := registerEndpoint(wsOwned+"-gitops."+domain, "owner2@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	wErr := newRecorder()
	srv.handleUpdateWorkspace(wErr, baileyReq(http.MethodPost, "/x", "owner2@example.com"), "owner2@example.com", wsOwned)
	if wErr.Code != http.StatusOK {
		t.Fatalf("owner update stream status = %d", wErr.Code)
	}
	if !strings.Contains(wErr.Body.String(), "deployment directory not found") {
		t.Errorf("expected missing-deployment error event; got: %s", wErr.Body.String())
	}
}

func TestUpdateWorkspace_OwnerWithDeploymentStreams(t *testing.T) {
	domain := writeTestConfig(t)
	owner := "updownerdep@example.com"
	ws := "updwsdep"
	// Own the gitops endpoint + create a deployment dir (no compose file,
	// so `docker compose pull/up` fails fast — best-effort, safe).
	if _, err := registerEndpoint(ws+"-gitops."+domain, owner, "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	mkWorkspaceDir(t, ws, true)
	srv := &Server{}
	w := newRecorder()
	srv.handleUpdateWorkspace(w, baileyReq(http.MethodPost, "/x", owner), owner, ws)
	if w.Code != http.StatusOK {
		t.Fatalf("update stream status = %d", w.Code)
	}
	body := w.Body.String()
	if !strings.Contains(body, `"event":"start"`) {
		t.Errorf("update stream missing start event: %s", body)
	}
	// Either a done or an error event must terminate the stream.
	if !strings.Contains(body, `"event":"done"`) && !strings.Contains(body, `"event":"error"`) {
		t.Errorf("update stream did not terminate: %s", body)
	}
}

func TestFetchDockerHubTags_BadRepo(t *testing.T) {
	// A clearly bogus repo path should surface an error (HTTP non-200 or a
	// network failure), never a panic.
	if _, err := fetchDockerHubTags("definitely/not-a-real-repo-xyz-123456", 1); err == nil {
		t.Skip("docker hub reachable and returned a result for the bogus repo")
	}
}

// TestUpgradeWorkspace_ValidationAndAuthz covers the version-bump upgrade handler
// (owner-gated) the console's Update button calls.
func TestUpgradeWorkspace_ValidationAndAuthz(t *testing.T) {
	domain := writeTestConfig(t)
	srv := &Server{}

	// Invalid name → 400.
	wBad := newRecorder()
	srv.handleUpgradeWorkspace(wBad, baileyReq(http.MethodPost, "/x", "u@example.com"), "u@example.com", "Bad Name")
	if wBad.Code != http.StatusBadRequest {
		t.Errorf("invalid name = %d, want 400", wBad.Code)
	}

	// Non-owner → 403.
	ws := "upgradews"
	if _, err := registerEndpoint(ws+"-gitops."+domain, "real@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	wForbid := newRecorder()
	srv.handleUpgradeWorkspace(wForbid, baileyReq(http.MethodPost, "/x", "intruder@example.com"), "intruder@example.com", ws)
	if wForbid.Code != http.StatusForbidden {
		t.Errorf("non-owner upgrade = %d, want 403", wForbid.Code)
	}

	// Owner but missing deployment → 500 (runWorkspaceUpdate fails; JSON error, not a stream).
	wsOwned := "upgradewsowned"
	if _, err := registerEndpoint(wsOwned+"-gitops."+domain, "owner3@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	// The upgrade now streams a determinate progress bar as NDJSON, so a
	// mid-run failure (missing deployment) is a 200 stream carrying an error
	// event rather than a 500 status.
	wErr := newRecorder()
	srv.handleUpgradeWorkspace(wErr, baileyReq(http.MethodPost, "/x", "owner3@example.com"), "owner3@example.com", wsOwned)
	if wErr.Code != http.StatusOK {
		t.Fatalf("owner upgrade stream status = %d, want 200", wErr.Code)
	}
	if !strings.Contains(wErr.Body.String(), `"event":"error"`) {
		t.Errorf("expected a streamed error event for a missing deployment; got: %s", wErr.Body.String())
	}
}

// TestAdminUpdates_ReturnsPayload covers the admin Updates view endpoint: it
// always answers 200 with the server block and the host-side update command,
// even when the release/tag lookups can't resolve.
func TestAdminUpdates_ReturnsPayload(t *testing.T) {
	writeTestConfig(t)
	// A dev/git build → the server is never flagged, keeping the assertion
	// independent of what the GitHub release endpoint returns.
	srv := &Server{version: "v2026.07.07.21-git-test"}
	w := newRecorder()
	srv.handleAdminUpdates(w, baileyReq(http.MethodGet, "/bailey/api/admin/updates", "admin@example.com"))
	if w.Code != http.StatusOK {
		t.Fatalf("admin updates = %d, want 200", w.Code)
	}
	var body map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("bad json: %v", err)
	}
	// The CLI hint is gone (issue #254 — don't document CLI in the UI); the
	// payload now carries the version ledger + rollback depth instead.
	if _, ok := body["server_update_cmd"]; ok {
		t.Error("server_update_cmd should no longer be sent (CLI hint removed)")
	}
	if _, ok := body["history"]; !ok {
		t.Error("response missing 'history' key")
	}
	if body["rollback_depth"] != float64(updateRollbackDepth) {
		t.Errorf("rollback_depth = %v, want %d", body["rollback_depth"], updateRollbackDepth)
	}
	if _, ok := body["server"]; !ok {
		t.Error("response missing 'server' key")
	}
	if _, ok := body["count"]; !ok {
		t.Error("response missing 'count' key")
	}
}

// TestAdminUpdates_MarksWhatTheCallerCanApply covers issue #367: the Updates
// view is admin-gated but the update/rollback handlers are OWNER-gated, so the
// payload has to tell the console which rows this caller can actually act on —
// otherwise the console offers buttons that only ever 403.
func TestAdminUpdates_MarksWhatTheCallerCanApply(t *testing.T) {
	domain := writeTestConfig(t)
	const caller = "notowner@example.com"

	// Two workspaces in the ledger: one the caller owns, one they don't. Both
	// are stale and in the inventory the view reads, so both reach the loop.
	if _, err := registerEndpoint("minews-gitops."+domain, caller, "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := registerEndpoint("theirsws-gitops."+domain, "owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	stubStaleWorkspaces(t, "minews", "theirsws")
	for _, e := range []updateHistoryEntry{
		{Actor: "x@example.com", TargetKind: updateTargetWorkspace, TargetName: "minews", FromVersion: "g1", ToVersion: "g2"},
		{Actor: "x@example.com", TargetKind: updateTargetWorkspace, TargetName: "theirsws", FromVersion: "g1", ToVersion: "g2"},
		{Actor: "x@example.com", TargetKind: updateTargetServer, FromVersion: "v1", ToVersion: "v2"},
	} {
		if _, err := dbInsertUpdateHistory(e); err != nil {
			t.Fatal(err)
		}
	}

	srv := &Server{version: "v2026.07.07.21-git-test"}
	w := newRecorder()
	srv.handleAdminUpdates(w, baileyReq(http.MethodGet, "/bailey/api/admin/updates", caller, adminGrp))
	if w.Code != http.StatusOK {
		t.Fatalf("admin updates = %d, want 200", w.Code)
	}
	var body struct {
		Workspaces []struct {
			Name      string `json:"name"`
			Owner     string `json:"owner"`
			CanUpdate bool   `json:"can_update"`
		} `json:"workspaces"`
		History []struct {
			TargetKind  string `json:"target_kind"`
			TargetName  string `json:"target_name"`
			CanRollback bool   `json:"can_rollback"`
		} `json:"history"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("bad json: %v\n%s", err, w.Body.String())
	}

	// can_rollback must agree with callerOwnsWorkspace — the check
	// handleBaileyWorkspaceRollback enforces — and the server's own binary is
	// admin-gated, not owner-gated, so it stays rollable.
	seen := map[string]bool{}
	for _, h := range body.History {
		if h.TargetKind == updateTargetServer {
			if !h.CanRollback {
				t.Error("server history row should be rollable by an admin")
			}
			continue
		}
		switch h.TargetName {
		case "minews", "theirsws":
			seen[h.TargetName] = true
			want := h.TargetName == "minews"
			if h.CanRollback != want {
				t.Errorf("%s can_rollback = %v, want %v", h.TargetName, h.CanRollback, want)
			}
		}
	}
	if !seen["minews"] || !seen["theirsws"] {
		t.Fatalf("seeded history rows missing from the payload: %+v", body.History)
	}

	// Both stale workspaces reach the loop, so the row-level rules are decided
	// on real rows: the one the caller owns is listed and offered, the one they
	// have no role on is not listed at all. The expectations are spelled out
	// rather than recomputed with callerOwnsWorkspace — comparing the handler
	// against the helper the handler itself calls passes even when both are
	// wrong.
	var sawMine bool
	for _, ws := range body.Workspaces {
		switch ws.Name {
		case "minews":
			sawMine = true
			if !ws.CanUpdate {
				t.Error("the workspace's owner was not offered its update")
			}
		case "theirsws":
			t.Errorf("someone else's workspace %q was listed (can_update=%v)", ws.Name, ws.CanUpdate)
		default:
			t.Errorf("unexpected workspace in the payload: %+v", ws)
		}
	}
	if !sawMine {
		t.Fatalf("the caller's own stale workspace is missing from the payload — the assertions above proved nothing: %+v", body.Workspaces)
	}
}

// The Updates view must not carry the removed "server owner" override either
// (#337). An earlier draft of this view computed
// `callerOwns := serverOwner || callerRole(name) == roleOwner`, which had two
// effects for whoever owned the bailey.<domain> endpoint: every workspace
// became can_update/can_rollback, AND — because the drop rule is
// `!can && callerRole == roleNone` — nothing was dropped, so the page listed
// every stale workspace on the server by name and version. Owning the bailey
// row must confer nothing here.
func TestAdminUpdates_BaileyHostOwnerGetsNoCapability(t *testing.T) {
	domain := writeTestConfig(t)
	const caller = "srvowner@example.com"
	baileyHost := "bailey." + domain
	if err := deleteEndpoint(baileyHost); err != nil {
		t.Fatal(err)
	}
	if _, err := registerEndpoint(baileyHost, caller, "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	// A workspace owned by somebody else, with a rollback point in the ledger,
	// plus one the caller genuinely owns. Both are stale and in the inventory,
	// so the payload's workspace loop runs on two real rows — the bailey-host
	// owner must get exactly the one that is theirs.
	if _, err := registerEndpoint("notourws-dashboard."+domain, "someone@example.com", "", "", endpointKindWorkspace, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := registerEndpoint("ourws-dashboard."+domain, caller, "", "", endpointKindWorkspace, ""); err != nil {
		t.Fatal(err)
	}
	stubStaleWorkspaces(t, "notourws", "ourws")
	if _, err := dbInsertUpdateHistory(updateHistoryEntry{
		Actor: "x@example.com", TargetKind: updateTargetWorkspace,
		TargetName: "notourws", FromVersion: "g1", ToVersion: "g2",
	}); err != nil {
		t.Fatal(err)
	}

	srv := &Server{version: "v2026.07.07.21-git-test"}
	w := newRecorder()
	srv.handleAdminUpdates(w, baileyReq(http.MethodGet, "/bailey/api/admin/updates", caller, adminGrp))
	if w.Code != http.StatusOK {
		t.Fatalf("admin updates = %d, want 200", w.Code)
	}
	var body struct {
		Workspaces []struct {
			Name      string `json:"name"`
			CanUpdate bool   `json:"can_update"`
		} `json:"workspaces"`
		History []struct {
			TargetKind  string `json:"target_kind"`
			TargetName  string `json:"target_name"`
			CanRollback bool   `json:"can_rollback"`
		} `json:"history"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("bad json: %v\n%s", err, w.Body.String())
	}
	// Nothing they don't own is offered — and nothing they have no role on is
	// even listed. Both stale workspaces are in the inventory, so this loop
	// runs on both and the negative below is a real observation.
	var sawOwn bool
	for _, ws := range body.Workspaces {
		switch ws.Name {
		case "ourws":
			sawOwn = true
			if !ws.CanUpdate {
				t.Error("the caller's own workspace was not offered its update")
			}
		case "notourws":
			t.Errorf("someone else's workspace %q was listed to the bailey-host owner (can_update=%v)", ws.Name, ws.CanUpdate)
		default:
			t.Errorf("unexpected workspace in the payload: %+v", ws)
		}
	}
	if !sawOwn {
		t.Fatalf("the caller's own stale workspace is missing from the payload — the assertions above proved nothing: %+v", body.Workspaces)
	}
	var sawRow bool
	for _, h := range body.History {
		if h.TargetKind != updateTargetWorkspace || h.TargetName != "notourws" {
			continue
		}
		sawRow = true
		if h.CanRollback {
			t.Error("the bailey-host owner was offered rollback on someone else's workspace")
		}
	}
	if !sawRow {
		t.Fatal("seeded history row missing from the payload — the assertion above proved nothing")
	}
}

// TestAdminUpdates_UnconfirmedRoleIsNotListed is the Updates-view half of the
// fail-closed rule: the view drops a workspace whose role it could not
// resolve. The shape that makes this bite is a readable dashboard with a
// direct `access` grant whose recorded PARENT row cannot be read — roleFor
// then answers (roleAccess, err), a real role alongside a real error, so the
// "no role ⇒ drop" rule does not catch it. Only reading the error does.
func TestAdminUpdates_UnconfirmedRoleIsNotListed(t *testing.T) {
	domain := writeTestConfig(t)
	const caller = "updadmin@example.com"

	// One workspace the caller plainly owns (so the loop demonstrably runs),
	// and one whose membership cannot be confirmed.
	if _, err := registerEndpoint("plainws-dashboard."+domain, caller, "", "", endpointKindWorkspace, ""); err != nil {
		t.Fatal(err)
	}
	hub := "hub-unconfirmed." + domain
	if _, err := registerEndpoint(hub, "hubowner@example.com", "", "", endpointKindWorkspace, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := registerEndpoint("unconfws-dashboard."+domain, "hubowner@example.com", "", hub, endpointKindWorkspace, ""); err != nil {
		t.Fatal(err)
	}
	if err := addGrant("unconfws-dashboard."+domain, "email", caller, "access", "hubowner@example.com"); err != nil {
		t.Fatal(err)
	}
	stubStaleWorkspaces(t, "plainws", "unconfws")
	breakEndpointRowForTest(t, hub)

	// The shape this test exists for; fail loudly if it stops being reachable.
	if role, err := workspaceRoleFor("unconfws", domain, caller, nil); role != roleAccess || err == nil {
		t.Fatalf("this test needs the (access, error) shape; got role=%q err=%v", role, err)
	}

	srv := &Server{version: "v2026.07.07.21-git-test"}
	w := newRecorder()
	srv.handleAdminUpdates(w, baileyReq(http.MethodGet, "/bailey/api/admin/updates", caller, adminGrp))
	if w.Code != http.StatusOK {
		t.Fatalf("admin updates = %d, want 200", w.Code)
	}
	var body struct {
		Workspaces []struct {
			Name      string `json:"name"`
			CanUpdate bool   `json:"can_update"`
		} `json:"workspaces"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("bad json: %v\n%s", err, w.Body.String())
	}
	var sawPlain bool
	for _, ws := range body.Workspaces {
		switch ws.Name {
		case "plainws":
			sawPlain = true
		case "unconfws":
			t.Errorf("a workspace whose membership could not be read was listed (can_update=%v)", ws.CanUpdate)
		default:
			t.Errorf("unexpected workspace in the payload: %+v", ws)
		}
	}
	if !sawPlain {
		t.Fatalf("the caller's own stale workspace is missing from the payload — the assertion above proved nothing: %+v", body.Workspaces)
	}
}

// TestWorkspaceRollback_MethodAndValidation covers the CLI rollback daemon
// handler: method/validation guards and the streamed no-snapshot error path.
func TestWorkspaceRollback_MethodAndValidation(t *testing.T) {
	t.Setenv("HOME", t.TempDir()) // isolate: no real workspaces → deterministic no-snapshot
	srv := &Server{}

	// GET → 405.
	wGet := newRecorder()
	srv.handleWorkspaceRollback(wGet, baileyReqBody(http.MethodGet, "/workspace/rollback", "", ""))
	if wGet.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET rollback = %d, want 405", wGet.Code)
	}

	// Missing workspace → 400.
	wEmpty := newRecorder()
	srv.handleWorkspaceRollback(wEmpty, baileyReqBody(http.MethodPost, "/workspace/rollback", "", "{}"))
	if wEmpty.Code != http.StatusBadRequest {
		t.Errorf("empty workspace = %d, want 400", wEmpty.Code)
	}

	// Valid name, no snapshot → streams 200 with a 'no rollback snapshot' error event.
	wNo := newRecorder()
	srv.handleWorkspaceRollback(wNo, baileyReqBody(http.MethodPost, "/workspace/rollback", "", `{"workspace":"ghostws"}`))
	if wNo.Code != http.StatusOK {
		t.Fatalf("rollback stream status = %d, want 200", wNo.Code)
	}
	if !strings.Contains(wNo.Body.String(), "no rollback snapshot") {
		t.Errorf("expected no-snapshot error event; got: %s", wNo.Body.String())
	}
}

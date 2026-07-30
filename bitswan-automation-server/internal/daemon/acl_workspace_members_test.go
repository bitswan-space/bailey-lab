package daemon

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// Tests for the union ACL (#251):
//
//	effective = (all workspace members) ∪ (people added to this endpoint)
//
// with the workspace half switchable per endpoint (default ON). The deny
// paths matter more than the allow paths here, so every combination of
// (toggle on/off) × (workspace member / explicitly added / stranger) is
// asserted, plus the fail-closed behaviour on a membership-lookup error.

// workspaceShareListing is the share API's GET body, with the workspace
// half the dialog needs. Separate from shareListing (acl_share_test.go) so
// that test's narrower expectations stay untouched.
type workspaceShareListing struct {
	Hostname   string                   `json:"hostname"`
	OwnerEmail string                   `json:"owner_email"`
	Grants     []endpointGrant          `json:"grants"`
	Workspace  *endpointWorkspaceAccess `json:"workspace"`
}

func decodeWorkspaceListing(t *testing.T, w *httptest.ResponseRecorder) workspaceShareListing {
	t.Helper()
	var l workspaceShareListing
	if err := json.Unmarshal(w.Body.Bytes(), &l); err != nil {
		t.Fatalf("decode listing: %v\n%s", err, w.Body.String())
	}
	return l
}

// unionFixture registers a workspace dashboard with one member and one
// member-by-group, plus a child endpoint parented to it, and returns both
// hostnames. The child also has one explicitly-added outsider.
func unionFixture(t *testing.T, name string) (dashboard, child string) {
	t.Helper()
	dashboard = "union-" + name + "-dashboard.example.com"
	child = "union-" + name + "-frontend.example.com"
	if _, err := registerEndpoint(dashboard, "wsowner@example.com", name, "", endpointKindWorkspace, ""); err != nil {
		t.Fatal(err)
	}
	if err := addGrant(dashboard, "email", "member@example.com", "access", "wsowner@example.com"); err != nil {
		t.Fatal(err)
	}
	if err := addGrant(dashboard, "group", "/Acme/devs", "access", "wsowner@example.com"); err != nil {
		t.Fatal(err)
	}
	if _, err := registerEndpoint(child, "wsowner@example.com", name+" frontend", dashboard, endpointKindFrontend, "production"); err != nil {
		t.Fatal(err)
	}
	// Someone who is NOT in the workspace, added directly to the child.
	if err := addGrant(child, "email", "contractor@example.com", "access", "wsowner@example.com"); err != nil {
		t.Fatal(err)
	}
	return dashboard, child
}

func TestRegisterEndpoint_InheritsWorkspaceMembersByDefault(t *testing.T) {
	host := "union-default.example.com"
	ep, err := registerEndpoint(host, "owner@example.com", "", "some-dashboard.example.com", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if !ep.InheritWorkspaceMembers {
		t.Error("a newly registered endpoint must inherit workspace members by default")
	}
	// And it must read back that way from a fresh row, not just from the
	// in-memory record the insert returned.
	if got, err := getEndpoint(host); err != nil || got == nil || !got.InheritWorkspaceMembers {
		t.Errorf("getEndpoint inherit = %v (err %v), want true", got, err)
	}
	// listAllEndpoints reads the same column — a drift there would silently
	// misreport the flag on the admin endpoint listing.
	all, err := listAllEndpoints()
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range all {
		if e.Hostname == host {
			found = true
			if !e.InheritWorkspaceMembers {
				t.Error("listAllEndpoints reported inherit=false for a default endpoint")
			}
		}
	}
	if !found {
		t.Fatalf("%s missing from listAllEndpoints", host)
	}
}

func TestRoleFor_UnionMatrix(t *testing.T) {
	dashboard, child := unionFixture(t, "matrix")

	// The full matrix, asserted with the workspace half ON and then OFF.
	// "want" is the role on the CHILD endpoint.
	cases := []struct {
		name    string
		email   string
		groups  []string
		wantOn  endpointRole
		wantOff endpointRole
	}{
		{
			// The bug in #251: a workspace member could not open what the
			// workspace deployed. With the union on, they can.
			name: "workspace member", email: "member@example.com",
			wantOn: roleAccess, wantOff: roleNone,
		},
		{
			name: "workspace member via group", email: "dev@example.com", groups: []string{"/Acme/devs"},
			wantOn: roleAccess, wantOff: roleNone,
		},
		{
			// The manual half is not switchable — an explicitly added
			// person keeps access with the workspace half off.
			name: "explicitly added non-member", email: "contractor@example.com",
			wantOn: roleAccess, wantOff: roleAccess,
		},
		{
			// The child's own recorded owner never depends on inheritance.
			name: "recorded owner", email: "wsowner@example.com",
			wantOn: roleOwner, wantOff: roleOwner,
		},
		{
			// Denied in every combination — the union must not become a
			// backdoor for anyone who is neither a member nor invited.
			name: "unrelated user", email: "stranger@example.com", groups: []string{"/Other/users"},
			wantOn: roleNone, wantOff: roleNone,
		},
	}

	for _, on := range []bool{true, false} {
		if err := setEndpointWorkspaceInherit(child, on); err != nil {
			t.Fatalf("setEndpointWorkspaceInherit(%v): %v", on, err)
		}
		for _, tc := range cases {
			want := tc.wantOn
			if !on {
				want = tc.wantOff
			}
			t.Run(tc.name, func(t *testing.T) {
				got, err := roleFor(child, tc.email, tc.groups)
				if err != nil {
					t.Fatalf("roleFor: %v", err)
				}
				if got != want {
					t.Errorf("inherit=%v roleFor(child, %s) = %q, want %q", on, tc.email, got, want)
				}
			})
		}
		// Switching the child's inheritance must never touch the workspace's
		// own ACL — the member keeps their access to the dashboard either way.
		if role, err := roleFor(dashboard, "member@example.com", nil); err != nil || role != roleAccess {
			t.Errorf("inherit=%v: dashboard role for member = %q (err %v), want access", on, role, err)
		}
	}
}

func TestEnforceEndpointACL_WorkspaceMemberToggle(t *testing.T) {
	_, child := unionFixture(t, "gate")

	member := "member@example.com"
	// ON (the default): the gate lets the workspace member through.
	if err := setEndpointWorkspaceInherit(child, true); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	if !enforceEndpointACL(w, gateRequest(t, child, "/", member), member, nil) {
		t.Errorf("workspace member denied with inheritance on (status %d)", w.Code)
	}

	// OFF: the same member is denied, with the generic 403 page.
	if err := setEndpointWorkspaceInherit(child, false); err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	if enforceEndpointACL(w, gateRequest(t, child, "/", member), member, nil) {
		t.Fatal("workspace member allowed through with inheritance off")
	}
	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", w.Code)
	}

	// The explicitly added contractor is unaffected by the switch.
	w = httptest.NewRecorder()
	if !enforceEndpointACL(w, gateRequest(t, child, "/", "contractor@example.com"), "contractor@example.com", nil) {
		t.Errorf("explicitly granted user denied with inheritance off (status %d)", w.Code)
	}

	// And a stranger is denied either way.
	for _, on := range []bool{true, false} {
		if err := setEndpointWorkspaceInherit(child, on); err != nil {
			t.Fatal(err)
		}
		w = httptest.NewRecorder()
		if enforceEndpointACL(w, gateRequest(t, child, "/", "stranger@example.com"), "stranger@example.com", nil) {
			t.Errorf("inherit=%v: stranger allowed through", on)
		}
	}
}

// A membership lookup that fails must deny, not fall through to whatever
// direct role was computed first. unionWithWorkspaceRole is the seam the
// lookup goes through, so the failure is injectable here — the DB error it
// stands in for (a corrupt/locked bailey.db) can't be provoked from a test
// without breaking the shared connection every other test uses.
func TestUnionWithWorkspaceRole_LookupErrorDenies(t *testing.T) {
	boom := errors.New("membership lookup failed")
	// Even starting from a real direct grant, an unresolvable workspace
	// denies: a half-evaluated ACL is not an access decision.
	for _, direct := range []endpointRole{roleNone, roleAccess} {
		got, err := unionWithWorkspaceRole(direct, func() (endpointRole, error) {
			return roleOwner, boom
		})
		if !errors.Is(err, boom) {
			t.Errorf("direct=%q: err = %v, want the lookup error", direct, err)
		}
		if got != roleNone {
			t.Errorf("direct=%q: role = %q, want none (fail closed)", direct, got)
		}
	}
	// A clean lookup that finds nothing leaves the direct role standing.
	got, err := unionWithWorkspaceRole(roleAccess, func() (endpointRole, error) {
		return roleNone, nil
	})
	if err != nil || got != roleAccess {
		t.Errorf("clean empty lookup = %q (err %v), want access", got, err)
	}
}

// A missing workspace (parent row never registered) is the "workspace
// cannot be determined" case that CAN be provoked end to end: it must deny,
// never open up.
func TestRoleFor_MissingWorkspaceDenies(t *testing.T) {
	child := "union-orphan-frontend.example.com"
	if _, err := registerEndpoint(child, "owner@example.com", "", "union-orphan-dashboard.example.com", "", ""); err != nil {
		t.Fatal(err)
	}
	if role, err := roleFor(child, "member@example.com", nil); err != nil || role != roleNone {
		t.Errorf("orphaned child: role = %q (err %v), want none", role, err)
	}
}

func TestSetEndpointWorkspaceInherit_UnregisteredEndpoint(t *testing.T) {
	if err := setEndpointWorkspaceInherit("union-nosuch.example.com", false); err == nil {
		t.Error("expected an error toggling an unregistered endpoint")
	}
	if err := setEndpointWorkspaceInherit("", false); err == nil {
		t.Error("expected an error for an empty hostname")
	}
}

func TestWorkspaceMembershipSurface(t *testing.T) {
	cases := []struct {
		name string
		ep   *endpointRecord
		want string
	}{
		{"nil record", nil, ""},
		{"parentless", &endpointRecord{Hostname: "a.example.com"}, ""},
		{"parented", &endpointRecord{Hostname: "a.example.com", ParentEndpoint: "dash.example.com"}, "dash.example.com"},
		// A row naming itself as parent would recurse; it has no surface.
		{"self-parented", &endpointRecord{Hostname: "a.example.com", ParentEndpoint: "A.example.com"}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := workspaceMembershipSurface(tc.ep); got != tc.want {
				t.Errorf("= %q, want %q", got, tc.want)
			}
		})
	}
}

func TestWorkspaceAccessFor(t *testing.T) {
	dashboard, child := unionFixture(t, "dto")
	ep, err := getEndpoint(child)
	if err != nil || ep == nil {
		t.Fatalf("getEndpoint: %v", err)
	}
	ws := workspaceAccessFor(ep)
	if ws == nil {
		t.Fatal("workspaceAccessFor returned nil for a parented endpoint")
	}
	if ws.Endpoint != dashboard {
		t.Errorf("Endpoint = %q, want %q", ws.Endpoint, dashboard)
	}
	if !ws.Enabled {
		t.Error("Enabled = false, want true by default")
	}
	// Members are the dashboard's owner + email grantees; the group grant
	// is reported separately, not silently dropped.
	wantMembers := map[string]bool{"wsowner@example.com": true, "member@example.com": true}
	if len(ws.Members) != len(wantMembers) {
		t.Errorf("Members = %v, want %v", ws.Members, wantMembers)
	}
	for _, m := range ws.Members {
		if !wantMembers[m] {
			t.Errorf("unexpected member %q", m)
		}
	}
	if len(ws.Groups) != 1 || ws.Groups[0] != "/Acme/devs" {
		t.Errorf("Groups = %v, want [/Acme/devs]", ws.Groups)
	}
	// The DTO must follow the stored flag, so the dialog's switch shows the
	// endpoint's real state rather than an assumed default.
	if err := setEndpointWorkspaceInherit(child, false); err != nil {
		t.Fatal(err)
	}
	ep, _ = getEndpoint(child)
	if ws := workspaceAccessFor(ep); ws == nil || ws.Enabled {
		t.Errorf("after switching off, Enabled = %v, want false", ws)
	}

	// A parentless endpoint has no workspace half at all — the dialog then
	// draws no inherited row.
	dashEp, err := getEndpoint(dashboard)
	if err != nil {
		t.Fatal(err)
	}
	if got := workspaceAccessFor(dashEp); got != nil {
		t.Errorf("workspaceAccessFor(dashboard) = %+v, want nil", got)
	}
}

// --- Share API: who may flip the switch -----------------------------------

// shareWorkspaceToggle posts the workspace-access action as email.
func shareWorkspaceToggle(t *testing.T, host, email string, enabled bool, trusted bool) *httptest.ResponseRecorder {
	t.Helper()
	v := "false"
	if enabled {
		v = "true"
	}
	return shareAPIRequest(t, http.MethodPost, host, email, url.Values{
		"action":  {"workspace-access"},
		"enabled": {v},
	}, trusted)
}

func TestShareAPI_WorkspaceToggle_OwnerOnly(t *testing.T) {
	_, child := unionFixture(t, "api")

	// The recorded owner, on a trusted device, can switch it off and on.
	if w := shareWorkspaceToggle(t, child, "wsowner@example.com", false, true); w.Code != http.StatusOK {
		t.Fatalf("owner toggle off = %d: %s", w.Code, w.Body.String())
	}
	if ep, _ := getEndpoint(child); ep == nil || ep.InheritWorkspaceMembers {
		t.Error("toggle off did not persist")
	}
	if role, _ := roleFor(child, "member@example.com", nil); role != roleNone {
		t.Errorf("member still has role %q after the owner switched inheritance off", role)
	}
	if w := shareWorkspaceToggle(t, child, "wsowner@example.com", true, true); w.Code != http.StatusOK {
		t.Fatalf("owner toggle on = %d: %s", w.Code, w.Body.String())
	}
	if role, _ := roleFor(child, "member@example.com", nil); role != roleAccess {
		t.Errorf("member role = %q after re-enabling, want access", role)
	}

	// A workspace MEMBER must not be able to touch it. They only hold
	// `access` on the child (delegation never upgrades to owner), so the
	// share API's owner check rejects them — a member cannot switch their
	// own access on, nor off for everybody else.
	if w := shareWorkspaceToggle(t, child, "member@example.com", false, true); w.Code != http.StatusForbidden {
		t.Errorf("member toggle = %d, want 403", w.Code)
	}
	if ep, _ := getEndpoint(child); ep == nil || !ep.InheritWorkspaceMembers {
		t.Error("a member's rejected toggle changed the endpoint anyway")
	}

	// An outright stranger, likewise.
	if w := shareWorkspaceToggle(t, child, "stranger@example.com", false, true); w.Code != http.StatusForbidden {
		t.Errorf("stranger toggle = %d, want 403", w.Code)
	}

	// Owner role alone isn't enough: ACL writes also demand a trusted
	// device (the factor that survives an IdP compromise).
	if w := shareWorkspaceToggle(t, child, "wsowner@example.com", false, false); w.Code != http.StatusForbidden {
		t.Errorf("owner toggle without a trusted device = %d, want 403", w.Code)
	}
	if ep, _ := getEndpoint(child); ep == nil || !ep.InheritWorkspaceMembers {
		t.Error("untrusted-device toggle changed the endpoint anyway")
	}
}

// Once the workspace half is off, someone whose only path to owner was the
// workspace itself cannot switch it back on — the escalation this feature
// most obviously invites.
func TestShareAPI_WorkspaceToggle_NoSelfReEnable(t *testing.T) {
	dashboard, child := unionFixture(t, "reenable")
	// A workspace CO-OWNER: owner on the dashboard, so owner on the child by
	// delegation — but nothing recorded on the child itself.
	if err := addGrant(dashboard, "email", "coowner@example.com", "owner", "wsowner@example.com"); err != nil {
		t.Fatal(err)
	}
	if role, _ := roleFor(child, "coowner@example.com", nil); role != roleOwner {
		t.Fatalf("precondition: co-owner role on child = %q, want owner", role)
	}
	// They may switch it off (they are an owner while it is on)…
	if w := shareWorkspaceToggle(t, child, "coowner@example.com", false, true); w.Code != http.StatusOK {
		t.Fatalf("co-owner toggle off = %d: %s", w.Code, w.Body.String())
	}
	// …and by doing so they gave up their own hold on the endpoint.
	if w := shareWorkspaceToggle(t, child, "coowner@example.com", true, true); w.Code != http.StatusForbidden {
		t.Errorf("co-owner re-enable = %d, want 403 — inheritance must not be self-restorable", w.Code)
	}
	// The endpoint's recorded owner is still in control.
	if w := shareWorkspaceToggle(t, child, "wsowner@example.com", true, true); w.Code != http.StatusOK {
		t.Errorf("recorded owner re-enable = %d, want 200: %s", w.Code, w.Body.String())
	}
}

func TestShareAPI_WorkspaceToggle_Validation(t *testing.T) {
	_, child := unionFixture(t, "validate")

	// A garbled boolean is a 400, not a silently assumed default — this
	// switch widens access, so guessing is not acceptable.
	w := shareAPIRequest(t, http.MethodPost, child, "wsowner@example.com", url.Values{
		"action":  {"workspace-access"},
		"enabled": {"maybe"},
	}, true)
	if w.Code != http.StatusBadRequest {
		t.Errorf("enabled=maybe → %d, want 400", w.Code)
	}
	w = shareAPIRequest(t, http.MethodPost, child, "wsowner@example.com", url.Values{
		"action": {"workspace-access"},
	}, true)
	if w.Code != http.StatusBadRequest {
		t.Errorf("missing enabled → %d, want 400", w.Code)
	}

	// An endpoint with no workspace has nothing to toggle; say so rather
	// than storing a flag that means nothing.
	standalone := "union-standalone.example.com"
	if _, err := registerEndpoint(standalone, "owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if w := shareWorkspaceToggle(t, standalone, "owner@example.com", false, true); w.Code != http.StatusBadRequest {
		t.Errorf("toggle on a workspace-less endpoint = %d, want 400", w.Code)
	}
}

// The dialog can only show the inherited row if the API tells it about the
// workspace, so the listing's shape is part of the contract.
func TestShareAPI_ListingCarriesWorkspace(t *testing.T) {
	dashboard, child := unionFixture(t, "listing")

	w := shareAPIRequest(t, http.MethodGet, child, "wsowner@example.com", nil, false)
	if w.Code != http.StatusOK {
		t.Fatalf("GET = %d: %s", w.Code, w.Body.String())
	}
	got := decodeWorkspaceListing(t, w)
	if got.Workspace == nil {
		t.Fatal("listing has no workspace object for a parented endpoint")
	}
	if got.Workspace.Endpoint != dashboard || !got.Workspace.Enabled {
		t.Errorf("workspace = %+v, want endpoint %q enabled", got.Workspace, dashboard)
	}
	if len(got.Workspace.Members) == 0 {
		t.Error("workspace members are empty — the dialog could not enumerate who inherits")
	}

	// The POST response must reflect the change it just made, or the
	// dialog's switch snaps back to its old position.
	w = shareWorkspaceToggle(t, child, "wsowner@example.com", false, true)
	if w.Code != http.StatusOK {
		t.Fatalf("toggle = %d: %s", w.Code, w.Body.String())
	}
	if got := decodeWorkspaceListing(t, w); got.Workspace == nil || got.Workspace.Enabled {
		t.Errorf("POST response workspace = %+v, want enabled=false", got.Workspace)
	}

	// A parentless endpoint reports no workspace at all.
	w = shareAPIRequest(t, http.MethodGet, dashboard, "wsowner@example.com", nil, false)
	if got := decodeWorkspaceListing(t, w); got.Workspace != nil {
		t.Errorf("dashboard listing workspace = %+v, want null", got.Workspace)
	}
}

// --- People picker route --------------------------------------------------

// The picker is served under the gate prefix so it is reachable from an app
// host, and it must carry the SAME authority as the console's directory:
// endpoint owners in, everyone else out.
func TestGatePath_PeopleDirectoryRoute(t *testing.T) {
	domain := writeTestConfig(t)
	owner := "picker-owner@example.com"
	host := "pickerws-dashboard." + domain
	if _, err := registerEndpoint(host, owner, "", "", endpointKindWorkspace, ""); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = deleteEndpoint(host) })

	call := func(email string) *httptest.ResponseRecorder {
		r := gateRequest(t, "app.example.com", gatePathPrefix+"/api/people/directory", email)
		w := httptest.NewRecorder()
		handleGatePath(w, r)
		return w
	}
	if w := call(owner); w.Code != http.StatusOK {
		t.Errorf("endpoint owner = %d, want 200: %s", w.Code, w.Body.String())
	}
	if w := call("picker-nobody@example.com"); w.Code != http.StatusForbidden {
		t.Errorf("caller who owns nothing shareable = %d, want 403", w.Code)
	}
}

// --- Dialog markup -------------------------------------------------------

// The dialog is a generated HTML/JS string, so the only thing a unit test
// can pin down is that the hooks the JS drives are actually rendered and
// that no Sprintf verb went astray. Its appearance still needs a browser.
func TestShareModalRendersWorkspaceRowAndPicker(t *testing.T) {
	markup := shareModalHTML()
	for _, id := range []string{
		`id="bailey-share-workspace"`, // container for the inherited row
		`id="bailey-share-picker"`,    // people picker list
		`id="bailey-share-input"`,     // free-text entry must survive
	} {
		if !strings.Contains(markup, id) {
			t.Errorf("share modal markup is missing %s", id)
		}
	}
	for _, cls := range []string{
		".bailey-share-inherited", ".bailey-share-switch",
		".bailey-share-members", ".bailey-share-picker",
	} {
		if !strings.Contains(shareModalCSS, cls) {
			t.Errorf("share modal CSS is missing %s", cls)
		}
	}

	js := shareModalJS("app.example.com", "me@example.com", gatePathPrefix+"/api/share/app.example.com")
	if strings.Contains(js, "%!") {
		t.Fatalf("format verb error in rendered share JS")
	}
	// The picker must call the shared people directory, not a parallel API.
	if !strings.Contains(js, gatePathPrefix+"/api/people/directory") {
		t.Error("share JS does not point the picker at the people directory endpoint")
	}
	if !strings.Contains(js, "workspace-access") {
		t.Error("share JS does not post the workspace-access toggle")
	}
}

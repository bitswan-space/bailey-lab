package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// Tests for the workspace half of an endpoint's ACL (#251):
//
//	who can open it = (all workspace members) ∪ (people added to it)
//
// This is PRE-EXISTING behaviour — roleFor has delegated membership from an
// endpoint's parent (its workspace dashboard) since #129. #251 changed only
// what the share dialog SHOWS, so these tests exist to pin the union down
// (it was untested) and to prove the new `workspace` object describes the
// same set the gate actually admits.

// workspaceShareListing is the share API's GET body, with the workspace half
// the dialog needs. Separate from shareListing (acl_share_test.go) so that
// test's narrower expectations stay untouched.
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

// The union, end to end on roleFor. Both halves admit, and nobody outside
// either half gets in.
func TestRoleFor_WorkspaceMembersUnion(t *testing.T) {
	dashboard, child := unionFixture(t, "matrix")

	cases := []struct {
		name   string
		email  string
		groups []string
		want   endpointRole
	}{
		// The workspace half — what the dialog failed to show.
		{"workspace member", "member@example.com", nil, roleAccess},
		{"workspace member via group", "dev@example.com", []string{"/Acme/devs"}, roleAccess},
		// The manual half.
		{"explicitly added non-member", "contractor@example.com", nil, roleAccess},
		// The endpoint's own recorded owner.
		{"recorded owner", "wsowner@example.com", nil, roleOwner},
		// Neither half ⇒ denied.
		{"unrelated user", "stranger@example.com", []string{"/Other/users"}, roleNone},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := roleFor(child, tc.email, tc.groups)
			if err != nil {
				t.Fatalf("roleFor: %v", err)
			}
			if got != tc.want {
				t.Errorf("roleFor(child, %s) = %q, want %q", tc.email, got, tc.want)
			}
		})
	}

	// Delegation must not upgrade access→owner (#129): a member can open the
	// endpoint but must not be able to re-share it.
	if role, _ := roleFor(child, "member@example.com", nil); role == roleOwner {
		t.Error("a workspace access-member resolved as OWNER of the child endpoint")
	}
	// Nor may it leak back the other way — the member's role on the workspace
	// itself is unchanged.
	if role, err := roleFor(dashboard, "member@example.com", nil); err != nil || role != roleAccess {
		t.Errorf("dashboard role for member = %q (err %v), want access", role, err)
	}
}

// The same union at the gate — the authorization path a real request takes.
func TestEnforceEndpointACL_WorkspaceMemberAllowed(t *testing.T) {
	_, child := unionFixture(t, "gate")

	for _, email := range []string{"member@example.com", "contractor@example.com", "wsowner@example.com"} {
		w := httptest.NewRecorder()
		if !enforceEndpointACL(w, gateRequest(t, child, "/", email), email, nil) {
			t.Errorf("%s denied at the gate (status %d)", email, w.Code)
		}
	}
	// A group-only member too.
	w := httptest.NewRecorder()
	if !enforceEndpointACL(w, gateRequest(t, child, "/", "dev@example.com"), "dev@example.com", []string{"/Acme/devs"}) {
		t.Errorf("group workspace member denied at the gate (status %d)", w.Code)
	}
	// And a stranger is still refused, with the generic 403 page.
	w = httptest.NewRecorder()
	if enforceEndpointACL(w, gateRequest(t, child, "/", "stranger@example.com"), "stranger@example.com", nil) {
		t.Fatal("stranger allowed through")
	}
	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", w.Code)
	}
}

// A workspace that can't be resolved (parent row never registered) must
// deny, not open up.
func TestRoleFor_MissingWorkspaceDenies(t *testing.T) {
	child := "union-orphan-frontend.example.com"
	if _, err := registerEndpoint(child, "owner@example.com", "", "union-orphan-dashboard.example.com", "", ""); err != nil {
		t.Fatal(err)
	}
	if role, err := roleFor(child, "member@example.com", nil); err != nil || role != roleNone {
		t.Errorf("orphaned child: role = %q (err %v), want none", role, err)
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

// The row the dialog draws must describe the set the gate admits — if these
// drift, the dialog is lying about access again, which is the whole bug.
func TestWorkspaceAccessFor_MatchesWhoRoleForAdmits(t *testing.T) {
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
	wantMembers := map[string]bool{"wsowner@example.com": true, "member@example.com": true}
	if len(ws.Members) != len(wantMembers) {
		t.Errorf("Members = %v, want keys of %v", ws.Members, wantMembers)
	}
	for _, m := range ws.Members {
		if !wantMembers[m] {
			t.Errorf("unexpected member %q", m)
		}
		// Every name the dialog lists must genuinely be able to open it.
		if role, err := roleFor(child, m, nil); err != nil || role == roleNone {
			t.Errorf("dialog lists %q but roleFor says %q (err %v)", m, role, err)
		}
	}
	// The group grant is reported, not silently dropped — it also carries
	// access, and can't be expanded to individuals here.
	if len(ws.Groups) != 1 || ws.Groups[0] != "/Acme/devs" {
		t.Errorf("Groups = %v, want [/Acme/devs]", ws.Groups)
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
	if got.Workspace.Endpoint != dashboard {
		t.Errorf("workspace endpoint = %q, want %q", got.Workspace.Endpoint, dashboard)
	}
	if len(got.Workspace.Members) == 0 {
		t.Error("workspace members are empty — the dialog could not enumerate who inherits")
	}

	// A parentless endpoint reports no workspace at all.
	w = shareAPIRequest(t, http.MethodGet, dashboard, "wsowner@example.com", nil, false)
	if got := decodeWorkspaceListing(t, w); got.Workspace != nil {
		t.Errorf("dashboard listing workspace = %+v, want null", got.Workspace)
	}
}

// This surface is READ-ONLY: inherited workspace access is administered in
// the workspace, and the share API deliberately offers no way to switch it
// off per endpoint. An earlier draft of #251 added exactly that; this pins
// its removal so it can't creep back in unnoticed.
func TestShareAPI_NoWorkspaceAccessMutation(t *testing.T) {
	_, child := unionFixture(t, "readonly")
	for _, v := range []string{"false", "true"} {
		w := shareAPIRequest(t, http.MethodPost, child, "wsowner@example.com", url.Values{
			"action":  {"workspace-access"},
			"enabled": {v},
		}, true)
		if w.Code != http.StatusBadRequest {
			t.Errorf("workspace-access enabled=%s → %d, want 400 (unknown action)", v, w.Code)
		}
	}
	// The workspace's members still reach the endpoint afterwards.
	if role, _ := roleFor(child, "member@example.com", nil); role != roleAccess {
		t.Errorf("member role = %q after the rejected mutation, want access", role)
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
		".bailey-share-inherited", ".bailey-share-members",
		".bailey-share-count", ".bailey-share-picker",
		".bailey-share-member .dot",       // avatar
		".bailey-share-member .who .mail", // email under the name
	} {
		if !strings.Contains(shareModalCSS, cls) {
			t.Errorf("share modal CSS is missing %s", cls)
		}
	}

	js := shareModalJS("app.example.com", "me@example.com", gatePathPrefix+"/api/share/app.example.com")
	if strings.Contains(js, "%!") {
		t.Fatalf("format verb error in rendered share JS")
	}
	// The picker must call the shared people directory, not a parallel API. It
	// also supplies the display names for every chip.
	if !strings.Contains(js, gatePathPrefix+"/api/people/directory") {
		t.Error("share JS does not point the picker at the people directory endpoint")
	}
	// Identity chips use the console's avatar treatment (hashed colour +
	// initials), ported in avatarColor/initialsFor. The hsl() literal and the
	// separator class are the two things that must not drift from
	// console-ui.jsx, or the same person gets a different avatar in each UI.
	for _, frag := range []string{
		"function avatarColor(", "function initialsFor(", "function personChip(",
		"'hsl(' + (h % 360) + ' 52% 45%)'", // %% survived Sprintf
		`split(/[\s@._-]+/)`,
	} {
		if !strings.Contains(js, frag) {
			t.Errorf("share JS is missing the console avatar port: %s", frag)
		}
	}
	// The inherited row is informational: no switch, and nothing that posts a
	// workspace-access mutation.
	for _, gone := range []string{"workspace-access", "bailey-share-switch"} {
		if strings.Contains(js, gone) || strings.Contains(shareModalCSS, gone) {
			t.Errorf("the removed workspace toggle is still referenced (%q)", gone)
		}
	}
}

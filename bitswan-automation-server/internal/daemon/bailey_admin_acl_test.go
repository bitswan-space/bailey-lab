package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAdminACLTree_ListsEndpointsOwnerAndGrants(t *testing.T) {
	writeTestConfig(t)
	// A workspace dashboard (root) with a member grant, and a child gitops endpoint.
	if _, err := registerEndpoint("aclws-dashboard.example.com", "owner@example.com", "aclws (dashboard)", "", endpointKindWorkspace, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := registerEndpoint("aclws-gitops.example.com", "owner@example.com", "aclws (gitops)", "aclws-dashboard.example.com", endpointKindService, ""); err != nil {
		t.Fatal(err)
	}
	if err := addGrant("aclws-dashboard.example.com", "email", "member@example.com", string(roleAccess), "owner@example.com"); err != nil {
		t.Fatal(err)
	}

	w := httptest.NewRecorder()
	handleAdminACLTree(w, httptest.NewRequest(http.MethodGet, "/bailey/api/admin/acl", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var resp struct {
		Endpoints []aclTreeEndpoint `json:"endpoints"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	byHost := map[string]aclTreeEndpoint{}
	for _, e := range resp.Endpoints {
		byHost[e.Hostname] = e
	}
	dash, ok := byHost["aclws-dashboard.example.com"]
	if !ok {
		t.Fatalf("dashboard endpoint missing: %+v", resp.Endpoints)
	}
	if dash.OwnerEmail != "owner@example.com" || dash.Kind != endpointKindWorkspace {
		t.Errorf("dashboard owner/kind wrong: %+v", dash)
	}
	if dash.Access != "owned" {
		t.Errorf("workspace dashboard access = %q, want owned", dash.Access)
	}
	foundGrant := false
	for _, g := range dash.Grants {
		if g.PrincipalValue == "member@example.com" && g.Role == string(roleAccess) {
			foundGrant = true
		}
	}
	if !foundGrant {
		t.Errorf("member grant not surfaced: %+v", dash.Grants)
	}
	if child, ok := byHost["aclws-gitops.example.com"]; !ok || child.Parent != "aclws-dashboard.example.com" {
		t.Errorf("child endpoint parent wrong: %+v", child)
	}
}

// aclTreeByHost fetches the admin ACL tree and indexes it by lowercase host.
func aclTreeByHost(t *testing.T) map[string]aclTreeEndpoint {
	t.Helper()
	w := httptest.NewRecorder()
	handleAdminACLTree(w, httptest.NewRequest(http.MethodGet, "/bailey/api/admin/acl", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		Endpoints []aclTreeEndpoint `json:"endpoints"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v\n%s", err, w.Body.String())
	}
	out := map[string]aclTreeEndpoint{}
	for _, e := range resp.Endpoints {
		out[strings.ToLower(e.Hostname)] = e
	}
	return out
}

// A fresh server has no stored row for either structurally-open host (the
// gate no longer mints one), so the audit page must synthesise both — the
// operator still needs to see that these hosts are reachable by everyone.
func TestAdminACLTree_SynthesisesStructurallyOpenHosts(t *testing.T) {
	domain := writeTestConfig(t)
	console := serverConsoleHost(domain)
	onboard := serverConsoleOnboardHost(domain)
	for _, h := range []string{console, onboard} {
		if err := deleteEndpoint(h); err != nil {
			t.Fatal(err)
		}
	}

	byHost := aclTreeByHost(t)
	pub, ok := byHost[strings.ToLower(onboard)]
	if !ok {
		t.Fatalf("onboarding host missing from the tree: %+v", byHost)
	}
	if pub.Access != "public" {
		t.Errorf("onboarding access = %q, want public", pub.Access)
	}
	all, ok := byHost[strings.ToLower(console)]
	if !ok {
		t.Fatalf("console host missing from the tree: %+v", byHost)
	}
	if all.Access != "all-users" {
		t.Errorf("console access = %q, want all-users", all.Access)
	}
	// Synthesised rows assert reachability, never ownership.
	for _, e := range []aclTreeEndpoint{pub, all} {
		if e.OwnerEmail != "" {
			t.Errorf("%s reports owner %q — structural access has no owner", e.Hostname, e.OwnerEmail)
		}
		if len(e.Grants) != 0 {
			t.Errorf("%s reports grants %+v — structural access has none", e.Hostname, e.Grants)
		}
	}
}

// A server provisioned before #337 still holds an auto-registered bailey row
// naming whoever signed in first. It must appear exactly ONCE (not duplicated
// by the synthetic row) and must not report that stale ownership — reporting
// it would invite a reader, or future code, to treat the account as
// privileged. No migration is needed to reach that state.
func TestAdminACLTree_LegacyBaileyRowNotDuplicatedAndOwnerSuppressed(t *testing.T) {
	domain := writeTestConfig(t)
	console := serverConsoleHost(domain)
	if err := deleteEndpoint(console); err != nil {
		t.Fatal(err)
	}
	// The legacy shape: registered by the old gate, with a grant on top.
	if _, err := registerEndpoint(console, "firstvisitor@example.com", "Bailey ("+console+")", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := addGrant(console, "email", "someone@example.com", string(roleAccess), "firstvisitor@example.com"); err != nil {
		t.Fatal(err)
	}

	w := httptest.NewRecorder()
	handleAdminACLTree(w, httptest.NewRequest(http.MethodGet, "/bailey/api/admin/acl", nil))
	var resp struct {
		Endpoints []aclTreeEndpoint `json:"endpoints"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	seen := 0
	for _, e := range resp.Endpoints {
		if !strings.EqualFold(e.Hostname, console) {
			continue
		}
		seen++
		if e.Access != "all-users" {
			t.Errorf("legacy console row access = %q, want all-users", e.Access)
		}
		if e.OwnerEmail != "" {
			t.Errorf("legacy console row reports owner %q — must be suppressed", e.OwnerEmail)
		}
		if len(e.Grants) != 0 {
			t.Errorf("legacy console row reports grants %+v — must be suppressed", e.Grants)
		}
	}
	if seen != 1 {
		t.Errorf("console host appears %d times, want exactly 1 (synthetic row must not duplicate a stored one)", seen)
	}
	// The stored row is untouched — this is a reporting change, not a migration.
	if ep, err := getEndpoint(console); err != nil || ep == nil || ep.OwnerEmail != "firstvisitor@example.com" {
		t.Errorf("stored row was modified: %+v (err %v)", ep, err)
	}
}

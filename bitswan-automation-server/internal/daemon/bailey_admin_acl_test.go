package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
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

package daemon

import (
	"encoding/json"
	"net/http"
)

// Read-only, server-wide ACL view. Lists every registered endpoint with its
// owner and grants so an admin can SEE who can reach what — but never edit it
// here. Even an admin doesn't manage other people's ACLs from this page; it is
// purely observational (the console offers no mutation controls, and this API
// exposes none). The frontend nests by `parent` to render the
// workspace → endpoints tree.

type aclTreeGrant struct {
	PrincipalType  string `json:"principal_type"`
	PrincipalValue string `json:"principal_value"`
	Role           string `json:"role"`
}

type aclTreeEndpoint struct {
	Hostname    string         `json:"hostname"`
	DisplayName string         `json:"display_name"`
	Kind        string         `json:"kind"`
	Stage       string         `json:"stage"`
	Parent      string         `json:"parent"`
	OwnerEmail  string         `json:"owner_email"`
	Grants      []aclTreeGrant `json:"grants"`
}

// handleAdminACLTree (GET /bailey/api/admin/acl) returns all endpoints with
// their owner + grants. Admin-only — the caller is already gated in handleBailey.
func handleAdminACLTree(w http.ResponseWriter, r *http.Request) {
	eps, err := listAllEndpoints()
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	out := make([]aclTreeEndpoint, 0, len(eps))
	for _, e := range eps {
		grants, _ := listGrants(e.Hostname)
		g := make([]aclTreeGrant, 0, len(grants))
		for _, gr := range grants {
			g = append(g, aclTreeGrant{
				PrincipalType:  gr.PrincipalType,
				PrincipalValue: gr.PrincipalValue,
				Role:           string(gr.Role),
			})
		}
		out = append(out, aclTreeEndpoint{
			Hostname:    e.Hostname,
			DisplayName: e.DisplayName,
			Kind:        e.Kind,
			Stage:       e.Stage,
			Parent:      e.ParentEndpoint,
			OwnerEmail:  e.OwnerEmail,
			Grants:      g,
		})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"endpoints": out})
}

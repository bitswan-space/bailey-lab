package daemon

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
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
	// Access classifies how the endpoint is reached, NOT just its grants:
	//   "public"    — the onboarding host; any signed-in user reaches it
	//                 (device-trust exempt) so a new device can become trusted.
	//   "all-users" — the Server Console; every verified user can reach it
	//                 (the gate free-pass) so they can manage their own devices.
	//   "owned"     — a normal endpoint gated by its per-endpoint ACL (owner +
	//                 grants). The owner registration on public/all-users hosts
	//                 is incidental bookkeeping, not an access restriction.
	Access string `json:"access"`
}

// specialAccessEndpoints returns the rows for the two hosts whose reachability
// is STRUCTURAL rather than granted: the public onboarding host and the
// all-users Server Console. They are synthesised from the configured domain,
// not read from the endpoints table, because they are not ACL'd endpoints —
// the gate lets every signed-in user through by host predicate
// (isServerConsoleOnboardHost / isBaileyHost), consulting no row.
//
// Before #337 they appeared here only because the gate auto-registered a row
// for them on first sign-in, whose sole purpose was minting a "server owner".
// That registration is gone, so the audit page states the fact directly: this
// host is open to everyone because of what it IS, not because a row happens to
// exist. Empty when no protected domain is configured.
func specialAccessEndpoints() []aclTreeEndpoint {
	sc, err := config.NewAutomationServerConfig().LoadConfig()
	if err != nil || sc == nil {
		return nil
	}
	domain := sc.ProtectedHostnameDomain()
	if domain == "" {
		return nil
	}
	return []aclTreeEndpoint{
		{
			Hostname:    serverConsoleOnboardHost(domain),
			DisplayName: "Device-trust onboarding",
			Access:      "public",
			Grants:      []aclTreeGrant{},
		},
		{
			Hostname:    serverConsoleHost(domain),
			DisplayName: "Server Console",
			Access:      "all-users",
			Grants:      []aclTreeGrant{},
		},
	}
}

// handleAdminACLTree (GET /bailey/api/admin/acl) returns all endpoints with
// their owner + grants, plus a synthesised row per structurally-open host
// (specialAccessEndpoints). Admin-only — the caller is already gated in
// handleBailey.
//
// Rows classified public/all-users carry no owner or grants even when the
// underlying table has them: a server provisioned before #337 still holds an
// auto-registered bailey row naming whoever signed in first, and that
// ownership means nothing. Reporting it would invite a reader — human or
// future code — to treat that account as privileged, which is the bug this
// all came from. Suppressing it here makes upgraded and fresh servers report
// identically without touching the stored row.
func handleAdminACLTree(w http.ResponseWriter, r *http.Request) {
	eps, err := listAllEndpoints()
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	special := specialAccessEndpoints()
	seen := make(map[string]bool, len(eps))
	out := make([]aclTreeEndpoint, 0, len(eps)+len(special))
	for _, e := range eps {
		seen[strings.ToLower(e.Hostname)] = true
		grants, _ := listGrants(e.Hostname)
		g := make([]aclTreeGrant, 0, len(grants))
		for _, gr := range grants {
			g = append(g, aclTreeGrant{
				PrincipalType:  gr.PrincipalType,
				PrincipalValue: gr.PrincipalValue,
				Role:           string(gr.Role),
			})
		}
		access := "owned"
		switch {
		case isServerConsoleOnboardHost(e.Hostname):
			access = "public"
		case isBaileyHost(toOuterHost(e.Hostname)):
			access = "all-users"
		}
		entry := aclTreeEndpoint{
			Hostname:    e.Hostname,
			DisplayName: e.DisplayName,
			Kind:        e.Kind,
			Stage:       e.Stage,
			Parent:      e.ParentEndpoint,
			OwnerEmail:  e.OwnerEmail,
			Grants:      g,
			Access:      access,
		}
		if access != "owned" {
			entry.OwnerEmail = ""
			entry.Grants = []aclTreeGrant{}
		}
		out = append(out, entry)
	}
	// Only for hosts with no stored row — an upgraded server keeps rendering
	// from its existing (owner-suppressed) row rather than showing it twice.
	for _, sp := range special {
		if !seen[strings.ToLower(sp.Hostname)] {
			out = append(out, sp)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"endpoints": out})
}

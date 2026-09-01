package daemon

import (
	"encoding/json"
	"net/http"
	"strings"
)

// Socket-side admin API for Bailey endpoint access grants, backing the
// `bitswan bailey access` CLI. Like the device-trust API in
// bailey_devices_socket_api.go, these handlers live ONLY on the daemon's
// Unix-socket mux (setupRoutes) behind authMiddleware — never on the public
// gate mux. Reading or changing an endpoint's ACL is deliberately an
// operator-only capability, and since the socket is mounted into first-party
// workspace containers that is enforced by the admin token, not by socket
// reachability: all three handlers gate on callerAdminPrincipal /
// callerHasAdminToken (#189 for grant/revoke, #234 for list). See
// socketPrivilegedRoutes in server.go for the full operator-only set. The
// browser share UI stays least-privileged (an owner can only approve pending
// requests for endpoints they already own); blanket grants are not exposed
// there. The daemon is also the only process with the bailey.db volume
// mounted, so it is the one place the live ACL can be edited.

// AccessGrantRequest is the body of POST /bailey/access/{grant,revoke}.
type AccessGrantRequest struct {
	Host      string `json:"host"`
	Principal string `json:"principal"`
	// PrincipalType is "email" (default) or "group" (a Keycloak group path).
	PrincipalType string `json:"principal_type"`
	// Role is "access" (default, least privilege) or "owner".
	Role string `json:"role"`
}

func (r *AccessGrantRequest) normalize() {
	r.Host = strings.TrimSpace(r.Host)
	r.Principal = strings.TrimSpace(r.Principal)
	r.PrincipalType = strings.TrimSpace(r.PrincipalType)
	r.Role = strings.TrimSpace(r.Role)
	if r.PrincipalType == "" {
		r.PrincipalType = "email"
	}
	if r.Role == "" {
		r.Role = string(roleAccess)
	}
}

// accessAuditTarget renders the affected grant for an audit row: which principal
// gained or lost which role on which endpoint. Call it after normalize() so the
// defaults are filled in.
func accessAuditTarget(r *AccessGrantRequest) string {
	return r.Host + " " + r.PrincipalType + ":" + r.Principal + " role=" + r.Role
}

// handleAccessGrant grants a principal access (or owner) on an endpoint.
func (s *Server) handleAccessGrant(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// BSY-13 / #189: the daemon socket is reachable by first-party workspace
	// containers and authMiddleware trusts any socket peer, so granting ACL
	// access (attributed to the root admin) must additionally require the admin
	// token — otherwise a compromised first-party container could grant itself
	// access. Mirrors the workspace secret-read hardening.
	actor, hasToken := s.callerAdminPrincipal(r)
	if !hasToken {
		writeJSONError(w, "granting access requires the automation-server admin token (run the bitswan CLI on the host, or pass the daemon token as a bearer token)", http.StatusForbidden)
		return
	}
	var req AccessGrantRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}
	req.normalize()
	if req.Host == "" || req.Principal == "" {
		writeJSONError(w, "host and principal are required", http.StatusBadRequest)
		return
	}

	// Fail loudly if the endpoint isn't registered — granting on a host that
	// the gate doesn't know about would be a silent no-op at access-check time.
	ep, err := getEndpoint(req.Host)
	if err != nil {
		writeJSONError(w, "failed to look up endpoint: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if ep == nil {
		writeJSONError(w, "no registered endpoint with hostname '"+req.Host+"'", http.StatusNotFound)
		return
	}

	grantedBy := serverRootAdmin()
	if grantedBy == "" {
		grantedBy = "cli"
	}
	if err := addGrant(req.Host, req.PrincipalType, req.Principal, req.Role, grantedBy); err != nil {
		writeJSONError(w, err.Error(), http.StatusBadRequest)
		return
	}
	// #189: record WHICH admin credential granted this. granted_by keeps the
	// root-admin address (it's a displayed column other code reads), but the
	// audit trail must not imply a named user did it by hand.
	_ = recordEvent(actor, auditAccessGrant, accessAuditTarget(&req))

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"granted":        true,
		"host":           req.Host,
		"principal":      req.Principal,
		"principal_type": req.PrincipalType,
		"role":           req.Role,
	})
}

// handleAccessRevoke removes a principal's grant on an endpoint.
func (s *Server) handleAccessRevoke(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// BSY-13 / #189: revoking a grant is the same privileged, socket-reachable
	// ACL mutation as granting one, so gate it on the admin token too — a
	// first-party container must not be able to revoke access either.
	actor, hasToken := s.callerAdminPrincipal(r)
	if !hasToken {
		writeJSONError(w, "revoking access requires the automation-server admin token (run the bitswan CLI on the host, or pass the daemon token as a bearer token)", http.StatusForbidden)
		return
	}
	var req AccessGrantRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}
	req.normalize()
	if req.Host == "" || req.Principal == "" {
		writeJSONError(w, "host and principal are required", http.StatusBadRequest)
		return
	}
	if err := removeGrant(req.Host, req.PrincipalType, req.Principal, req.Role); err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// #189: a revoke previously left NO trace anywhere — removeGrant takes no
	// actor and deletes the row that carried granted_by, so the only record of
	// the grant disappeared with it.
	_ = recordEvent(actor, auditAccessRevoke, accessAuditTarget(&req))
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"revoked":        true,
		"host":           req.Host,
		"principal":      req.Principal,
		"principal_type": req.PrincipalType,
		"role":           req.Role,
	})
}

// handleAccessList lists the grants on an endpoint (?host=...), plus the
// endpoint's original owner.
func (s *Server) handleAccessList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// #234: the read side of the same capability #189 gated. An endpoint's full
	// grant list plus its owner address is reconnaissance for picking a target,
	// and it was readable by exactly the population of first-party containers
	// that motivated gating the mutations. The only caller is the host CLI
	// (Client.ListAccess), which always sends its bearer token, so the gate is
	// transparent to the operator flow; no in-cluster consumer reads this route
	// (gitops uses /bailey/role, /memory/admit and /ingress/* only).
	if !s.callerHasAdminToken(r) {
		writeJSONError(w, "listing endpoint access requires the automation-server admin token (run the bitswan CLI on the host, or pass the daemon token as a bearer token)", http.StatusForbidden)
		return
	}
	host := strings.TrimSpace(r.URL.Query().Get("host"))
	if host == "" {
		writeJSONError(w, "host query parameter is required", http.StatusBadRequest)
		return
	}
	ep, err := getEndpoint(host)
	if err != nil {
		writeJSONError(w, "failed to look up endpoint: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if ep == nil {
		writeJSONError(w, "no registered endpoint with hostname '"+host+"'", http.StatusNotFound)
		return
	}
	grants, err := listGrants(host)
	if err != nil {
		writeJSONError(w, "failed to list grants: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"host":        host,
		"owner_email": ep.OwnerEmail,
		"grants":      grants,
	})
}

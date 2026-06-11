package daemon

import (
	"net/http"
	"strings"
)

// Identity on protected-ingress requests comes from oauth2-proxy
// (bitswan-protected-proxy), which authenticates against Keycloak and
// forwards the result as headers. The daemon never sees credentials —
// only the already-verified email and group memberships.

// adminGroupSuffix is the suffix of any Keycloak group path that grants
// admin privileges. AOC's convention is one child group named "admin"
// under each org (e.g. "/Example Org/admin"); the group-membership
// mapper attached to the shared oauth client emits these paths in the
// OIDC `group_membership` claim, which oauth2-proxy forwards as
// X-Forwarded-Groups. Matching by suffix means we don't have to know
// the org's display name.
const adminGroupSuffix = "/admin"

// identityFromHeaders extracts the authenticated user from the
// oauth2-proxy-forwarded headers. Returns ("", nil) when there is no
// identity on the request (e.g. before the OIDC handshake has run, or
// in unit tests).
func identityFromHeaders(r *http.Request) (string, []string) {
	email := r.Header.Get("X-Forwarded-Email")
	if email == "" {
		email = r.Header.Get("X-Auth-Request-Email")
	}
	groupsHeader := r.Header.Get("X-Forwarded-Groups")
	if groupsHeader == "" {
		groupsHeader = r.Header.Get("X-Auth-Request-Groups")
	}
	var groups []string
	for _, g := range strings.Split(groupsHeader, ",") {
		if g = strings.TrimSpace(g); g != "" {
			groups = append(groups, g)
		}
	}
	return email, groups
}

// isAdminGroups reports whether the group list contains the org admin
// group. The bare "admin" is tolerated too — older configs that
// emitted the group name without the path-prefix mapper, and test
// harnesses, shouldn't lock admins out. Empty input means "not admin"
// — fail closed.
func isAdminGroups(groups []string) bool {
	for _, g := range groups {
		if g == "admin" || strings.HasSuffix(strings.ToLower(g), adminGroupSuffix) {
			return true
		}
	}
	return false
}

// requestEndpointHost returns the canonical hostname for ACL lookup.
// Prefers X-Forwarded-Host (set by the upstream proxy), falls back to
// r.Host. Strips any port suffix.
func requestEndpointHost(r *http.Request) string {
	h := r.Header.Get("X-Forwarded-Host")
	if h == "" {
		h = r.Host
	}
	if i := strings.Index(h, ":"); i >= 0 {
		h = h[:i]
	}
	return strings.ToLower(h)
}

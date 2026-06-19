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

// adminGroup is an alias of adminGroupSuffix kept for the ported admin
// handlers (bailey_admin_helpers.go) that reference it by that name.
const adminGroup = adminGroupSuffix

// baileyConfigName is the name of the AOC oauth config the Bailey
// management surface authenticates against. Used by signoutRedirect to
// build the Keycloak end-session URL.
const baileyConfigName = "bailey"

// isAdmin reports whether the request's forwarded identity is in the
// org admin group. Thin wrapper over identityFromHeaders/isAdminGroups
// so handlers can ask the question without unpacking headers.
func isAdmin(r *http.Request) bool {
	email, _ := identityFromHeaders(r)
	return callerIsAdmin(email)
}

// forwardedIdentityHeaders are every request header from which the
// daemon derives identity or admin status. They are trustworthy ONLY
// when set by the oauth2-proxy hop (bitswan-protected-proxy) in front
// of the gate; a client can otherwise forge them. The gate's Director
// strips the client-supplied copies before proxying to any upstream
// (see startProtectedGate), and re-applies only the gate-resolved
// values on the leg to the Bailey daemon upstream.
var forwardedIdentityHeaders = []string{
	"X-Forwarded-Email",
	"X-Forwarded-User",
	"X-Forwarded-Groups",
	"X-Forwarded-Preferred-Username",
	"X-Auth-Request-Email",
	"X-Auth-Request-User",
	"X-Auth-Request-Groups",
	"X-Auth-Request-Preferred-Username",
}

// stripForwardedIdentityHeaders removes all client-supplied
// forwarded-identity headers from a request. Used by the gate before it
// reverse-proxies to an upstream so a forged identity can never reach
// (or be injected through) a downstream app. Covers the X-Auth-Request-*
// family too, since identityFromHeaders falls back to those.
func stripForwardedIdentityHeaders(r *http.Request) {
	for _, h := range forwardedIdentityHeaders {
		r.Header.Del(h)
	}
}

// baileyAuthCookieNames are the cookies that carry Bailey's own auth/session
// state. They are meaningful only to the gate and the Bailey daemon; an
// upstream app must never receive them.
var baileyAuthCookieNames = map[string]bool{
	deviceCookieName: true, // _bailey_device — the replayable device-trust credential
	gateOriginCookie: true, // _bailey_origin — the gate's return-path stash
}

// stripBaileyAuthCookies rewrites r's Cookie header to drop Bailey's auth
// cookies while preserving any cookies the app set for itself. The gate calls
// this before proxying to an app upstream so a malicious/compromised app can
// never read or replay the device-trust credential — it can only ever see the
// request the gate already authorized, not the credential behind it.
func stripBaileyAuthCookies(r *http.Request) {
	cookies := r.Cookies()
	hadBailey := false
	for _, c := range cookies {
		if baileyAuthCookieNames[c.Name] {
			hadBailey = true
			break
		}
	}
	if !hadBailey {
		return
	}
	r.Header.Del("Cookie")
	for _, c := range cookies {
		if baileyAuthCookieNames[c.Name] {
			continue
		}
		r.AddCookie(c)
	}
}

// identityFromHeaders extracts the authenticated user from the
// oauth2-proxy-forwarded headers. Returns ("", nil) when there is no
// identity on the request (e.g. before the OIDC handshake has run, or
// in unit tests).
//
// SECURITY / STAGE-4 GAP: these X-Forwarded-* / X-Auth-Request-* headers
// are TRUSTED here with NO proof the request actually traversed
// oauth2-proxy. That is safe only as long as this code path is reached
// EXCLUSIVELY via the trusted gate/oauth2-proxy chain. It is NOT safe on
// the daemon's :8080 TCP listener, which is bound to all interfaces and
// reachable by any container on bitswan_network (including
// user-controlled workspace apps) — any of them can connect directly
// with forged X-Forwarded-Email/-Groups and impersonate an arbitrary
// user or org admin. The known, accepted stage-4 fix is the proxy split:
// :8080 must be bound to loopback / a non-routable daemon<->gate-only
// network so the only reachable path is through the gate. It is NOT
// bound to loopback today because the ACME DNS-01 bridge (acme_dns.go)
// and the docs ingress (docs.go) reach :8080 cross-container by its
// docker DNS name; re-binding without the proxy split would break them.
// Until that split lands, the gate's Director strip (startProtectedGate)
// is the partial mitigation. DO NOT add new trust in these headers on
// any TCP-reachable surface without the gate in front.
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

package daemon

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// signoutRedirect ends the oauth2-proxy session and bounces the user to the
// Keycloak end-session endpoint so the IdP-level session is also gone —
// otherwise clearing only the proxy cookie leaves Keycloak's SSO session alive
// and the next request silently re-issues a code for the SAME account, so the
// user can never switch accounts (#233, "this sign out button doesn't work").
//
// The issuer + client come from protectedClientInfo() — the shared client the
// oauth2-proxy actually authenticates against, resolved from the AOC. The old
// source, GetOauthConfig("bailey"), looked for a per-workspace oauth config at
// workspaces/bailey/oauth-config.yaml; "bailey" is not a workspace, so that
// file never existed and every sign-out fell through to the bare fallback.
func signoutRedirect(w http.ResponseWriter, r *http.Request, postLogoutPath string) {
	clientID, issuer := protectedClientInfo()
	if clientID == "" || issuer == "" {
		http.Redirect(w, r, "/oauth2/sign_out", http.StatusFound)
		return
	}
	scheme := "https"
	if r.TLS == nil && r.Header.Get("X-Forwarded-Proto") != "https" {
		scheme = "http"
	}
	// requestEndpointHost prefers X-Forwarded-Host, so the post-logout URL is the
	// PUBLIC host even though this request was reverse-proxied to the daemon.
	postLogout := scheme + "://" + requestEndpointHost(r) + postLogoutPath
	keycloakEnd := strings.TrimRight(issuer, "/") +
		"/protocol/openid-connect/logout?post_logout_redirect_uri=" + url.QueryEscape(postLogout) +
		"&client_id=" + url.QueryEscape(clientID)
	http.Redirect(w, r, "/oauth2/sign_out?rd="+url.QueryEscape(keycloakEnd), http.StatusFound)
}

// handleWhoami is the auth-debug endpoint. Dumps the auth-related headers
// the daemon sees so an operator can confirm what oauth2-proxy is
// forwarding (mostly useful when an admin login is landing on the
// 'not an admin' page).
func handleWhoami(w http.ResponseWriter, r *http.Request) {
	hs := map[string]string{}
	for _, h := range []string{
		"X-Forwarded-Email", "X-Forwarded-User", "X-Forwarded-Groups",
		"X-Auth-Request-Email", "X-Auth-Request-User", "X-Auth-Request-Groups",
		"X-Forwarded-Preferred-Username", "X-Forwarded-Access-Token",
	} {
		if v := r.Header.Get(h); v != "" {
			if h == "X-Forwarded-Access-Token" {
				v = fmt.Sprintf("<present, len=%d>", len(v))
			}
			hs[h] = v
		}
	}
	email, _ := identityFromHeaders(r)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"headers":              hs,
		"admin_group_constant": adminGroup,
		"is_admin":             isAdmin(r),
		// Authoritative Bailey role (admin|auditor|member|user) — what the
		// dashboard badge shows. Same source as People & roles, not SSO groups.
		"email": email,
		"role":  effectiveRole(email),
	})
}

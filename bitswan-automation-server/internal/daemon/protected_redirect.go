package daemon

import (
	"fmt"
	"net/url"
	"sync"

	"github.com/bitswan-space/bitswan-workspaces/internal/aoc"
)

// aocOAuthClient is the slice of the AOC API that redirect-URI
// registration needs. Kept as an interface behind a constructor var so
// tests can exercise the registration and reconcile logic without a
// network or an AOC.
type aocOAuthClient interface {
	GetOrCreateOAuthClientWithPostLogout(serviceName, redirectURI, postLogoutRedirectURI string) (*aoc.OAuthClientResponse, error)
}

var newAOCOAuthClient = func() (aocOAuthClient, error) { return aoc.NewAOCClient() }

// protectedClientURIs is the pair of OAuth URIs one protected hostname
// needs on the shared Keycloak client. They are a pair on purpose:
// Keycloak keeps two independent allowlists — redirectUris for the login
// callback, post.logout.redirect.uris for the RP-initiated logout target
// — and a host present on one but not the other is a half-working
// endpoint. Login succeeds, then Logout dead-ends on Keycloak's "We are
// sorry… Invalid redirect uri" page (Keycloak >= 18 requires the logout
// target to be registered, and a `*` inside a host is matched literally,
// so there is no wildcard to fall back on).
type protectedClientURIs struct {
	Host       string
	Callback   string
	PostLogout string
}

// protectedClientURIsForHost lists what must be registered for one
// protected endpoint: a callback and its post-logout twin, for the outer
// hostname (the chrome wrap) and the --inner hostname (the content
// iframe) alike. Both halves are reachable in a browser, so both can be
// logged out of.
//
// Takes either the outer or the inner form of the hostname and always
// returns the same pair set, so callers can't half-register an endpoint
// by handing in the wrong twin. The post-logout target is the endpoint
// root, matching what the Logout button actually asks for (see
// logoutURLForHost and signoutRedirect, which both post-logout to "/").
func protectedClientURIsForHost(hostname string) []protectedClientURIs {
	outer := toOuterHost(hostname)
	if outer == "" {
		return nil
	}
	var out []protectedClientURIs
	for _, h := range []string{outer, toInnerHost(outer)} {
		out = append(out, protectedClientURIs{
			Host:       h,
			Callback:   fmt.Sprintf("https://%s/oauth2/callback", h),
			PostLogout: fmt.Sprintf("https://%s/", h),
		})
	}
	return out
}

// registerProtectedRedirectURI tells the AOC to add an endpoint's OAuth
// URIs to the shared bitswan-protected-client. Every endpoint protected
// by bitswan-protected-proxy needs its callback URL on that client's
// allowlist (Keycloak otherwise refuses the OAuth callback) and its
// root on the post-logout allowlist (Keycloak otherwise refuses the
// logout). Both are stated in the same call, per hostname, so an
// endpoint can never end up registered for login only.
//
// service_name="bitswan-protected" maps to the client whose client_id
// is automation-server-<server>-bitswan-protected-client.
// GetOrCreateOAuthClient is idempotent: it adds what is missing and
// returns the existing client credentials.
func registerProtectedRedirectURI(hostname string) error {
	aocClient, err := newAOCOAuthClient()
	if err != nil {
		return fmt.Errorf("AOC not configured: %w", err)
	}
	return registerProtectedRedirectURIWith(aocClient, hostname)
}

// registerProtectedRedirectURIWith is registerProtectedRedirectURI with the
// AOC client supplied, so a sweep over many hostnames builds one client and
// reports "AOC not configured" once instead of once per host.
func registerProtectedRedirectURIWith(aocClient aocOAuthClient, hostname string) error {
	for _, u := range protectedClientURIsForHost(hostname) {
		if _, err := aocClient.GetOrCreateOAuthClientWithPostLogout(
			"bitswan-protected", u.Callback, u.PostLogout); err != nil {
			return fmt.Errorf("register %s: %w", u.Callback, err)
		}
	}
	return nil
}

var (
	protectedClientMu     sync.Mutex
	protectedClientID     string
	protectedClientIssuer string
)

// protectedClientInfo returns the shared protected client's id and OIDC
// issuer URL, fetched once from the AOC and cached for the daemon's
// lifetime. Returns empty strings when the AOC or domain isn't
// configured yet — callers must degrade gracefully.
func protectedClientInfo() (clientID, issuer string) {
	protectedClientMu.Lock()
	defer protectedClientMu.Unlock()
	if protectedClientID != "" {
		return protectedClientID, protectedClientIssuer
	}
	domain := protectedHostnameDomain()
	if domain == "" {
		return "", ""
	}
	aocClient, err := aoc.NewAOCClient()
	if err != nil {
		return "", ""
	}
	resp, err := aocClient.GetOrCreateOAuthClient("bitswan-protected",
		"https://bailey."+domain+"/oauth2/callback")
	if err != nil {
		fmt.Printf("Warning: could not fetch protected client info from AOC: %v\n", err)
		return "", ""
	}
	protectedClientID, protectedClientIssuer = resp.ClientID, resp.IssuerURL
	return protectedClientID, protectedClientIssuer
}

// logoutURLForHost builds the wrap's Logout target. Clearing the
// oauth2-proxy cookie alone is not a logout — Keycloak's SSO session
// survives and the next request silently signs the user back in. So the
// button chains both layers: oauth2-proxy's /oauth2/sign_out clears its
// session, then forwards the browser (rd=) to Keycloak's RP-initiated
// logout, which ends the SSO session and returns to the endpoint —
// where the user now gets a fresh login form.
//
// Requires the IdP's hostname on oauth2-proxy's whitelist_domains,
// otherwise the rd= is silently dropped (see docs/protected_ingress.md).
// Falls back to plain sign_out when the client info isn't available.
func logoutURLForHost(outerHost string) string {
	clientID, issuer := protectedClientInfo()
	if clientID == "" || issuer == "" {
		return "/oauth2/sign_out"
	}
	endSession := issuer + "/protocol/openid-connect/logout" +
		"?client_id=" + url.QueryEscape(clientID) +
		"&post_logout_redirect_uri=" + url.QueryEscape("https://"+outerHost+"/")
	return "/oauth2/sign_out?rd=" + url.QueryEscape(endSession)
}

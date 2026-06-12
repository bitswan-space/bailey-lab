package daemon

import (
	"fmt"
	"net/url"
	"sync"

	"github.com/bitswan-space/bitswan-workspaces/internal/aoc"
)

// registerProtectedRedirectURI tells the AOC to add redirect URIs to
// the shared bitswan-protected-client. Every endpoint protected by
// bitswan-protected-proxy needs its callback URL on that client's
// allowlist; Keycloak otherwise refuses the OAuth callback.
//
// Each endpoint exists at two subdomains (outer for the wrap, inner
// for the content) — both need their callback registered.
//
// service_name="bitswan-protected" maps to the client whose client_id
// is automation-server-<server>-bitswan-protected-client.
// GetOrCreateOAuthClient is idempotent: it adds the URI if missing and
// returns the existing client credentials.
func registerProtectedRedirectURI(hostname string) error {
	aocClient, err := aoc.NewAOCClient()
	if err != nil {
		return fmt.Errorf("AOC not configured: %w", err)
	}
	outer := toOuterHost(hostname)
	for _, h := range []string{outer, toInnerHost(outer)} {
		redirectURI := fmt.Sprintf("https://%s/oauth2/callback", h)
		if _, err := aocClient.GetOrCreateOAuthClient("bitswan-protected", redirectURI); err != nil {
			return fmt.Errorf("register %s: %w", redirectURI, err)
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

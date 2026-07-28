package daemon

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// setProtectedClientForTest seeds the process-lifetime protected-client cache
// (normally filled from the AOC on first use) and restores it afterwards, so a
// test can exercise signout without a live AOC.
func setProtectedClientForTest(t *testing.T, clientID, issuer string) {
	t.Helper()
	protectedClientMu.Lock()
	oldID, oldIssuer := protectedClientID, protectedClientIssuer
	protectedClientID, protectedClientIssuer = clientID, issuer
	protectedClientMu.Unlock()
	t.Cleanup(func() {
		protectedClientMu.Lock()
		protectedClientID, protectedClientIssuer = oldID, oldIssuer
		protectedClientMu.Unlock()
	})
}

// TestSignoutRedirect_EndsKeycloakSession is the regression for #233 ("this
// sign out button doesn't work"). Clearing only the oauth2-proxy cookie is not
// a logout: Keycloak's SSO session survives and the next request silently signs
// the user back in as the SAME account, so they can't switch accounts. Sign-out
// must chain oauth2-proxy's /oauth2/sign_out to Keycloak's RP-initiated logout
// (rd=<end-session>), using the protected client the proxy actually uses.
func TestSignoutRedirect_EndsKeycloakSession(t *testing.T) {
	setProtectedClientForTest(t, "bitswan-protected", "https://keycloak.test.example.com/realms/bitswan")

	r := httptest.NewRequest(http.MethodGet, "https://bailey-onboard.test.example.com/bailey/signout", nil)
	r.Host = "bailey-onboard.test.example.com"
	r.Header.Set("X-Forwarded-Proto", "https")
	w := httptest.NewRecorder()

	signoutRedirect(w, r, "/")

	if w.Code != http.StatusFound {
		t.Fatalf("status = %d, want 302", w.Code)
	}
	loc := w.Header().Get("Location")
	if !strings.HasPrefix(loc, "/oauth2/sign_out?rd=") {
		t.Fatalf("Location = %q, want /oauth2/sign_out chained to Keycloak (rd=)", loc)
	}
	rd, err := url.QueryUnescape(strings.TrimPrefix(loc, "/oauth2/sign_out?rd="))
	if err != nil {
		t.Fatalf("rd not URL-decodable: %v", err)
	}
	if !strings.Contains(rd, "keycloak.test.example.com/realms/bitswan/protocol/openid-connect/logout") {
		t.Errorf("rd does not point at Keycloak's end-session endpoint: %q", rd)
	}
	if !strings.Contains(rd, "client_id=bitswan-protected") {
		t.Errorf("rd missing client_id: %q", rd)
	}
	if !strings.Contains(rd, url.QueryEscape("https://bailey-onboard.test.example.com/")) {
		t.Errorf("rd missing post_logout_redirect_uri back to this host: %q", rd)
	}
}

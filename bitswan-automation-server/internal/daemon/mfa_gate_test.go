package daemon

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// gateReq builds a request carrying the oauth2-proxy-forwarded identity
// headers (and optionally a device cookie) so enforceMFAGate sees the
// same inputs it would in production.
func gateReq(host, path, email string, groups []string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "https://"+host+path, nil)
	r.Host = host
	r.Header.Set("Accept", "text/html")
	if email != "" {
		r.Header.Set("X-Forwarded-Email", email)
	}
	if len(groups) > 0 {
		r.Header.Set("X-Forwarded-Groups", strings.Join(groups, ","))
	}
	return r
}

// markServerClaimed records a root admin so serverClaimed() is true
// regardless of the (shared, package-wide) device table state. Used by
// gate tests that exercise the post-claim "trust this device" path.
func markServerClaimed(t *testing.T) {
	t.Helper()
	if err := dbSetSetting(settingRootAdmin, "root@example.com", "root@example.com"); err != nil {
		t.Fatal(err)
	}
}

// resetClaimState wipes the device table and clears the root-admin
// setting so the server reads as UNCLAIMED. Used by the claim-redirect
// test. (The package shares one SQLite DB across tests — see TestMain —
// so the bootstrap window must be reopened explicitly.)
func resetClaimState(t *testing.T) {
	t.Helper()
	db, err := openBaileyDB()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`DELETE FROM devices`); err != nil {
		t.Fatal(err)
	}
	if err := dbDeleteSetting(settingRootAdmin); err != nil {
		t.Fatal(err)
	}
}

// consoleHost returns the Server Console hostname for the test config
// domain (writeTestConfig writes "test.example.com" → "bailey.test.example.com").
func consoleHost(t *testing.T) string {
	t.Helper()
	return serverConsoleHost(writeTestConfig(t))
}

// bodyLooksLikeSPA reports whether the recorder captured the embedded
// React console index.html (the SPA shell) rather than a Go gate page.
// The Go scene pages carry the "sc-pad"/scenePage markup; index.html does
// not — it's a near-empty shell that loads /assets/*.
func bodyLooksLikeSPA(w *httptest.ResponseRecorder) bool {
	b := w.Body.String()
	return strings.Contains(b, "<div id=\"root\"") || strings.Contains(b, "/assets/")
}

// TestMFAGate_UntrustedServesSPA is the core assertion of the new
// contract: on a CLAIMED server, a signed-in user with no device cookie
// making a top-level HTML GET on the CONSOLE host gets the React console
// SPA served INLINE (so it can render ApprovalScene) — NOT a 303 to any
// Go gate page (pending-pair / claim / recovery / TOTP).
func TestMFAGate_UntrustedServesSPA(t *testing.T) {
	markServerClaimed(t)
	host := consoleHost(t)
	w := httptest.NewRecorder()
	pass := enforceMFAGate(w, gateReq(host, "/", "user@example.com", nil))
	if pass {
		t.Fatal("untrusted device passed the gate; want SPA served")
	}
	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200 (inline SPA)", w.Code)
	}
	if loc := w.Header().Get("Location"); loc != "" {
		t.Errorf("gate redirected to %q; want inline SPA, no redirect to a Go page", loc)
	}
	if !bodyLooksLikeSPA(w) {
		t.Errorf("served body doesn't look like the console SPA shell:\n%s", w.Body.String())
	}
}

// TestMFAGate_UntrustedAppHostRedirectsToConsole verifies that an
// untrusted top-level HTML GET on an APP host (where the SPA's assets/APIs
// can't resolve) is 303'd to the CONSOLE host root with a return param —
// NOT to a Go gate page.
func TestMFAGate_UntrustedAppHostRedirectsToConsole(t *testing.T) {
	markServerClaimed(t)
	domain := writeTestConfig(t)
	w := httptest.NewRecorder()
	pass := enforceMFAGate(w, gateReq("app."+domain, "/secret", "user@example.com", nil))
	if pass {
		t.Fatal("untrusted app-host request passed the gate")
	}
	if w.Code != http.StatusSeeOther {
		t.Errorf("status = %d, want 303", w.Code)
	}
	loc := w.Header().Get("Location")
	if !strings.HasPrefix(loc, "https://"+serverConsoleHost(domain)+"/") {
		t.Errorf("Location = %q, want redirect to console host root", loc)
	}
	if strings.Contains(loc, gatePathPrefix) {
		t.Errorf("Location = %q must NOT point at a Go gate page", loc)
	}
	if !strings.Contains(loc, "return=") {
		t.Errorf("Location = %q missing return param", loc)
	}
}

// TestMFAGate_UntrustedNonHTMLGets401 verifies a subresource/XHR/non-GET
// from an untrusted device gets a clean 401 (never an HTML scene body).
func TestMFAGate_UntrustedNonHTMLGets401(t *testing.T) {
	markServerClaimed(t)
	domain := writeTestConfig(t)
	// POST (non-GET) and a non-HTML GET both must 401.
	for _, r := range []*http.Request{
		func() *http.Request {
			req := gateReq("app."+domain, "/api/data", "user@example.com", nil)
			req.Method = http.MethodPost
			return req
		}(),
		func() *http.Request {
			req := gateReq("app."+domain, "/main.js", "user@example.com", nil)
			req.Header.Set("Accept", "*/*")
			return req
		}(),
	} {
		w := httptest.NewRecorder()
		if enforceMFAGate(w, r) {
			t.Errorf("%s %s passed the gate; want 401", r.Method, r.URL.Path)
		}
		if w.Code != http.StatusUnauthorized {
			t.Errorf("%s %s: status = %d, want 401", r.Method, r.URL.Path, w.Code)
		}
	}
}

// TestMFAGate_UnclaimedServesSPA verifies that on a fresh (unclaimed)
// server an eligible signed-in user on the console host gets the SPA
// (which reads gate-state can_claim and renders BootstrapScene) — NOT a
// 303 to the Go claim page, and NOT silently auto-paired.
func TestMFAGate_UnclaimedServesSPA(t *testing.T) {
	resetClaimState(t)
	host := consoleHost(t)
	w := httptest.NewRecorder()
	pass := enforceMFAGate(w, gateReq(host, "/", "admin@example.com", []string{"realm/admin"}))
	if pass {
		t.Fatal("unclaimed server passed an untrusted device through the gate")
	}
	if loc := w.Header().Get("Location"); loc != "" {
		t.Errorf("gate redirected to %q; want inline SPA", loc)
	}
	if !bodyLooksLikeSPA(w) {
		t.Errorf("served body doesn't look like the console SPA shell")
	}
	// And the gate must NOT have minted a device cookie (no silent TOFU).
	for _, c := range w.Result().Cookies() {
		if c.Name == deviceCookieName && c.Value != "" {
			t.Error("gate silently paired a device on an unclaimed server; want explicit claim")
		}
	}
}

// TestMFAGate_NeverForcesTOTP asserts no gate path ever redirects an
// untrusted user to a TOTP enrol/challenge screen (the removed #340 gate).
func TestMFAGate_NeverForcesTOTP(t *testing.T) {
	domain := writeTestConfig(t)
	for _, tc := range []struct {
		name   string
		setup  func(*testing.T)
		groups []string
	}{
		{"unclaimed-admin", resetClaimState, []string{"realm/admin"}},
		{"claimed-admin", markServerClaimed, []string{"realm/admin"}},
		{"claimed-user", markServerClaimed, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.setup(t)
			w := httptest.NewRecorder()
			enforceMFAGate(w, gateReq("app."+domain, "/", "u@example.com", tc.groups))
			loc := w.Header().Get("Location")
			if strings.Contains(loc, enrollPathSuffix) || strings.Contains(loc, challengePathSuffix) {
				t.Errorf("gate forced a TOTP screen: Location = %q", loc)
			}
		})
	}
}

// TestMFAGate_GatePathsExempt verifies the paths an un-trusted user needs
// to become trusted are passed through (no loop, and the React SPA's
// gate-state/action APIs + assets stay reachable while untrusted).
func TestMFAGate_GatePathsExempt(t *testing.T) {
	for _, p := range []string{
		// Legacy Go gate pages (kept as a no-JS fallback).
		gatePathPrefix + "/pending-pair",
		gatePathPrefix + "/approve",
		gatePathPrefix + "/recovery",
		gatePathPrefix + "/challenge",
		"/oauth2/start",
		// The React gate SPA's APIs + assets — must be reachable untrusted.
		"/bailey/api/gate-state",
		"/bailey/api/claim",
		"/bailey/api/pending-pair",
		"/bailey/api/pending-pair/poll",
		"/bailey/api/self-trust",
		"/bailey/api/recover",
		"/bailey/api/totp/enroll",
		"/bailey/static/x.js",
		"/bailey/favicon.svg",
	} {
		w := httptest.NewRecorder()
		if !enforceMFAGate(w, gateReq("bailey.example.com", p, "user@example.com", nil)) {
			t.Errorf("exempt path %q did not pass the gate (would loop / starve SPA)", p)
		}
	}
}

// TestMFAGate_DisableEscapeHatch verifies BAILEY_MFA_GATE_DISABLE=1
// short-circuits the gate.
func TestMFAGate_DisableEscapeHatch(t *testing.T) {
	t.Setenv("BAILEY_MFA_GATE_DISABLE", "1")
	w := httptest.NewRecorder()
	if !enforceMFAGate(w, gateReq("app.example.com", "/", "user@example.com", nil)) {
		t.Error("BAILEY_MFA_GATE_DISABLE=1 should pass everything through")
	}
}

// TestMFAGate_NoIdentityPassesThrough verifies a request with no
// forwarded identity is let through (the upstream rejects it; the gate
// never invents an identity).
func TestMFAGate_NoIdentityPassesThrough(t *testing.T) {
	w := httptest.NewRecorder()
	if !enforceMFAGate(w, gateReq("app.example.com", "/", "", nil)) {
		t.Error("identity-less request should pass through")
	}
}

// TestMFAGate_TrustedDevicePasses verifies that once a device is paired
// and its cookie presented, the request flows through.
func TestMFAGate_TrustedDevicePasses(t *testing.T) {
	email := "trusted@example.com"
	rec, err := addDevice(email, "test-device")
	if err != nil {
		t.Fatal(err)
	}
	w0 := httptest.NewRecorder()
	if err := setDeviceCookie(w0, gateReq("app.example.com", "/", email, nil), email, rec.ID); err != nil {
		t.Fatal(err)
	}
	cookie := w0.Result().Cookies()
	r := gateReq("app.example.com", "/", email, nil)
	for _, c := range cookie {
		r.AddCookie(c)
	}
	w := httptest.NewRecorder()
	if !enforceMFAGate(w, r) {
		t.Errorf("trusted device did not pass: status=%d loc=%q", w.Code, w.Header().Get("Location"))
	}
}

// TestMFAGate_AdminOnClaimedServerTrustsLikeAnyone verifies that, post-
// claim, an admin on an untrusted device is served the SAME gate SPA as
// anyone else — there is no admin-only TOTP gate anymore. Device trust is
// the only gate; the Keycloak admin group only governs WHO can approve
// others (the SPA's gate-state reports is_admin), not a forced factor.
func TestMFAGate_AdminOnClaimedServerTrustsLikeAnyone(t *testing.T) {
	markServerClaimed(t)
	host := consoleHost(t)
	w := httptest.NewRecorder()
	pass := enforceMFAGate(w, gateReq(host, "/", "admin@example.com", []string{"realm/admin"}))
	if pass {
		t.Fatal("admin on untrusted device passed the gate; want SPA served")
	}
	if loc := w.Header().Get("Location"); loc != "" {
		t.Errorf("admin redirected to %q; want inline SPA like any user", loc)
	}
	if !bodyLooksLikeSPA(w) {
		t.Errorf("admin not served the console SPA shell")
	}
}

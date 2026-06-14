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

// TestMFAGate_UntrustedDeviceRedirected is the core security assertion:
// on a CLAIMED server, a signed-in user with no device cookie must be
// redirected to the "trust this device" (pending-pair) page rather than
// reaching the app — and NOT to any TOTP enrol/challenge page.
func TestMFAGate_UntrustedDeviceRedirected(t *testing.T) {
	markServerClaimed(t)
	w := httptest.NewRecorder()
	pass := enforceMFAGate(w, gateReq("app.example.com", "/", "user@example.com", nil))
	if pass {
		t.Fatal("untrusted device passed the gate; want redirect")
	}
	if w.Code != http.StatusSeeOther {
		t.Errorf("status = %d, want 303", w.Code)
	}
	if loc := w.Header().Get("Location"); loc != gatePathPrefix+"/pending-pair" {
		t.Errorf("Location = %q, want %q", loc, gatePathPrefix+"/pending-pair")
	}
}

// TestMFAGate_UnclaimedRedirectsToClaim verifies that on a fresh
// (unclaimed) server an eligible signed-in user is sent to the one-time
// CLAIM page — NOT a TOTP screen, NOT silently auto-paired.
func TestMFAGate_UnclaimedRedirectsToClaim(t *testing.T) {
	resetClaimState(t)
	w := httptest.NewRecorder()
	// Admin identity is unambiguously eligible to claim.
	pass := enforceMFAGate(w, gateReq("bailey.example.com", "/", "admin@example.com", []string{"realm/admin"}))
	if pass {
		t.Fatal("unclaimed server passed an untrusted device through the gate")
	}
	if loc := w.Header().Get("Location"); loc != gatePathPrefix+"/claim" {
		t.Errorf("Location = %q, want %q (claim page)", loc, gatePathPrefix+"/claim")
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
			enforceMFAGate(w, gateReq("app.example.com", "/", "u@example.com", tc.groups))
			loc := w.Header().Get("Location")
			if strings.Contains(loc, enrollPathSuffix) || strings.Contains(loc, challengePathSuffix) {
				t.Errorf("gate forced a TOTP screen: Location = %q", loc)
			}
		})
	}
}

// TestMFAGate_GatePathsExempt verifies the pages an un-trusted user needs
// to become trusted are passed through (no redirect loop).
func TestMFAGate_GatePathsExempt(t *testing.T) {
	for _, p := range []string{
		gatePathPrefix + "/pending-pair",
		gatePathPrefix + "/approve",
		gatePathPrefix + "/recovery",
		gatePathPrefix + "/challenge",
		"/oauth2/start",
	} {
		w := httptest.NewRecorder()
		if !enforceMFAGate(w, gateReq("app.example.com", p, "user@example.com", nil)) {
			t.Errorf("exempt path %q did not pass the gate (would loop)", p)
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
// claim, an admin on an untrusted device is sent to the SAME "trust this
// device" page as anyone else — there is no admin-only TOTP gate anymore.
// Device trust is the only gate; the Keycloak admin group only governs
// WHO can approve others, not a forced second factor.
func TestMFAGate_AdminOnClaimedServerTrustsLikeAnyone(t *testing.T) {
	markServerClaimed(t)
	w := httptest.NewRecorder()
	pass := enforceMFAGate(w, gateReq("app.example.com", "/", "admin@example.com", []string{"realm/admin"}))
	if pass {
		t.Fatal("admin on untrusted device passed the gate; want trust-device redirect")
	}
	if loc := w.Header().Get("Location"); loc != gatePathPrefix+"/pending-pair" {
		t.Errorf("Location = %q, want %q", loc, gatePathPrefix+"/pending-pair")
	}
}

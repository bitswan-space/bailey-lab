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

// TestMFAGate_UntrustedDeviceRedirected is the core security assertion:
// a non-admin signed-in user with no device cookie must be redirected to
// the pending-pair page rather than reaching the app.
func TestMFAGate_UntrustedDeviceRedirected(t *testing.T) {
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

// TestMFAGate_AdminWithoutSessionChallenged verifies an admin lacking a
// TOTP session is sent to the challenge (which itself redirects to enrol
// if not yet enrolled).
func TestMFAGate_AdminWithoutSessionChallenged(t *testing.T) {
	w := httptest.NewRecorder()
	pass := enforceMFAGate(w, gateReq("app.example.com", "/", "admin@example.com", []string{"realm/admin"}))
	if pass {
		t.Fatal("admin without TOTP session passed the gate; want challenge redirect")
	}
	if loc := w.Header().Get("Location"); loc != gatePathPrefix+challengePathSuffix {
		t.Errorf("Location = %q, want %q", loc, gatePathPrefix+challengePathSuffix)
	}
}

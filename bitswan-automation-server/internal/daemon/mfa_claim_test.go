package daemon

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// claimReq builds a request carrying forwarded identity for the claim
// handler (which reads identity from headers for the group check).
func claimReq(method, path, email string, groups []string) *http.Request {
	r := httptest.NewRequest(method, "https://bailey.example.com"+path, nil)
	r.Header.Set("X-Forwarded-Email", email)
	if len(groups) > 0 {
		r.Header.Set("X-Forwarded-Groups", strings.Join(groups, ","))
	}
	return r
}

// TestClaim_GETRendersBootstrapScene verifies the claim page renders 200
// with the BootstrapScene copy while the server is unclaimed.
func TestClaim_GETRendersBootstrapScene(t *testing.T) {
	resetClaimState(t)
	w := httptest.NewRecorder()
	claimHandler(w, claimReq(http.MethodGet, gatePathPrefix+"/claim", "admin@example.com", []string{"realm/admin"}), "admin@example.com")
	if w.Code != http.StatusOK {
		t.Fatalf("claim GET status = %d, want 200", w.Code)
	}
	body := w.Body.String()
	for _, want := range []string{"Claim this server", "first trusted device", "Claim server"} {
		if !strings.Contains(body, want) {
			t.Errorf("claim page missing %q", want)
		}
	}
	if strings.Contains(strings.ToLower(body), "scan") || strings.Contains(body, "authenticator") {
		t.Error("claim page wrongly shows authenticator/QR setup")
	}
}

// TestClaim_POSTClaimsAndTrustsDevice verifies POST claims root admin,
// TOFU-trusts the device (sets the device cookie), and redirects back.
func TestClaim_POSTClaimsAndTrustsDevice(t *testing.T) {
	resetClaimState(t)
	w := httptest.NewRecorder()
	claimHandler(w, claimReq(http.MethodPost, gatePathPrefix+"/claim", "owner@example.com", []string{"realm/admin"}), "owner@example.com")
	if w.Code != http.StatusSeeOther {
		t.Fatalf("claim POST status = %d, want 303", w.Code)
	}
	if got := serverRootAdmin(); !strings.EqualFold(got, "owner@example.com") {
		t.Errorf("root admin = %q, want owner@example.com", got)
	}
	if !serverClaimed() {
		t.Error("server not marked claimed after POST")
	}
	var gotCookie bool
	for _, c := range w.Result().Cookies() {
		if c.Name == deviceCookieName && c.Value != "" {
			gotCookie = true
		}
	}
	if !gotCookie {
		t.Error("claim POST did not set a device cookie (no TOFU trust)")
	}
}

// TestClaim_ClosedAfterClaim verifies the claim window closes once the
// server is claimed — a later visitor is bounced to pending-pair.
func TestClaim_ClosedAfterClaim(t *testing.T) {
	markServerClaimed(t)
	w := httptest.NewRecorder()
	claimHandler(w, claimReq(http.MethodGet, gatePathPrefix+"/claim", "late@example.com", []string{"realm/admin"}), "late@example.com")
	if loc := w.Header().Get("Location"); loc != gatePathPrefix+"/pending-pair" {
		t.Errorf("post-claim Location = %q, want pending-pair", loc)
	}
}

// TestPendingPair_NoAuthenticatorHidesTOTPTab verifies the trust-this-
// device page only offers the authenticator self-trust path when the user
// actually has an authenticator enrolled (opt-in, never forced).
func TestPendingPair_NoAuthenticatorHidesTOTPTab(t *testing.T) {
	email := "noauth@example.com"
	_ = dbDeleteTOTP(email)
	e, err := generatePendingPair(email)
	if err != nil {
		t.Fatal(err)
	}
	html := pendingPairHTML(email, e, false, false, "")
	if strings.Contains(html, "/self-trust") {
		t.Error("self-trust path offered without an enrolled authenticator")
	}
	if !strings.Contains(html, "Trust this device") {
		t.Error("missing 'Trust this device' heading")
	}
	if !strings.Contains(html, e.Code) {
		t.Error("admin-approval code not shown")
	}
}

// TestSelfTrust_RequiresAuthenticator verifies self-trust is unavailable
// (redirects to admin approval) when no authenticator is enrolled.
func TestSelfTrust_RequiresAuthenticator(t *testing.T) {
	email := "noauth2@example.com"
	_ = dbDeleteTOTP(email)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "https://bailey.example.com"+gatePathPrefix+"/self-trust", nil)
	r.Header.Set("X-Forwarded-Email", email)
	selfTrustHandler(w, r, email)
	if loc := w.Header().Get("Location"); loc != gatePathPrefix+"/pending-pair" {
		t.Errorf("self-trust without authenticator Location = %q, want pending-pair", loc)
	}
}

// TestRecovery_BackupCodeTrustsDevice verifies a single-use backup code
// recovers (trusts) a device, and is then burned.
func TestRecovery_BackupCodeTrustsDevice(t *testing.T) {
	email := "recover@example.com"
	if err := dbSaveBackupCodes(email, []string{"ABCD-1234", "WXYZ-9999"}); err != nil {
		t.Fatal(err)
	}
	form := "mode=backup&backup=abcd1234"
	r := httptest.NewRequest(http.MethodPost, "https://bailey.example.com"+gatePathPrefix+"/recovery",
		strings.NewReader(form))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	r.Header.Set("X-Forwarded-Email", email)
	w := httptest.NewRecorder()
	recoveryHandler(w, r, email)
	if w.Code != http.StatusSeeOther {
		t.Fatalf("backup recovery status = %d, want 303 (body: %s)", w.Code, w.Body.String())
	}
	// Code is single-use: second attempt must fail.
	ok, _ := dbConsumeBackupCode(email, "ABCD-1234")
	if ok {
		t.Error("backup code was not burned after use")
	}
}

// TestRecovery_NoMethodForbidden verifies recovery 403s when the account
// has neither an authenticator nor backup codes.
func TestRecovery_NoMethodForbidden(t *testing.T) {
	email := "nomethod@example.com"
	_ = dbDeleteTOTP(email)
	_ = dbSaveBackupCodes(email, nil)
	r := httptest.NewRequest(http.MethodGet, "https://bailey.example.com"+gatePathPrefix+"/recovery", nil)
	r.Header.Set("X-Forwarded-Email", email)
	w := httptest.NewRecorder()
	recoveryHandler(w, r, email)
	if w.Code != http.StatusForbidden {
		t.Errorf("recovery with no method status = %d, want 403", w.Code)
	}
}

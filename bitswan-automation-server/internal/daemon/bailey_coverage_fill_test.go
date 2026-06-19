package daemon

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// --- bailey_gate_api.go extra branches ---------------------------------

func TestGateAPI_PendingPairReportsTOTPEnrolled(t *testing.T) {
	markServerClaimed(t)
	email := "ppt@example.com"
	if err := dbSaveTOTP(&totpRecord{Email: email, Secret: "S", CreatedAt: nowRFC3339()}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dbDeleteTOTP(email) })
	w := dispatch(gateAPIReq(http.MethodGet, "/bailey/api/pending-pair", email))
	if !strings.Contains(w.Body.String(), `"totp_enrolled":true`) {
		t.Errorf("pending-pair did not report totp_enrolled: %s", w.Body.String())
	}
}

func TestGateAPI_TOTPVerifyConflictWhenEnrolled(t *testing.T) {
	markServerClaimed(t)
	email := "verifyconflict@example.com"
	if err := dbSaveTOTP(&totpRecord{Email: email, Secret: "S", CreatedAt: nowRFC3339()}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dbDeleteTOTP(email) })
	w := dispatch(gateAPIJSON(http.MethodPost, "/bailey/api/totp/verify", email, `{"code":"123456"}`))
	if w.Code != http.StatusConflict {
		t.Errorf("verify when enrolled = %d, want 409", w.Code)
	}
}

func TestGateAPI_TOTPVerifyNoCookie(t *testing.T) {
	markServerClaimed(t)
	email := "verifynocookie@example.com"
	_ = dbDeleteTOTP(email)
	w := dispatch(gateAPIJSON(http.MethodPost, "/bailey/api/totp/verify", email, `{"code":"123456"}`))
	if w.Code != http.StatusBadRequest {
		t.Errorf("verify w/o cookie = %d, want 400", w.Code)
	}
}

func TestGateAPI_SelfTrustFormEncoded(t *testing.T) {
	markServerClaimed(t)
	email := "selftrustform@example.com"
	_ = dbDeleteTOTP(email) // no authenticator → 403 (exercises decodeGateBody form branch via the handler)
	r := httptest.NewRequest(http.MethodPost, "https://bailey.example.com/bailey/api/self-trust",
		strings.NewReader("code=123456"))
	r.Host = "bailey.example.com"
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	r.Header.Set("X-Forwarded-Email", email)
	w := httptest.NewRecorder()
	(&Server{}).handleBailey(w, r)
	if w.Code != http.StatusForbidden {
		t.Errorf("self-trust form (no auth) = %d, want 403", w.Code)
	}
}

func TestGateAPI_RecoverNoIdentity(t *testing.T) {
	markServerClaimed(t)
	w := dispatch(gateAPIJSON(http.MethodPost, "/bailey/api/recover", "", `{"totp":"1"}`))
	if w.Code != http.StatusUnauthorized {
		t.Errorf("recover no identity = %d, want 401", w.Code)
	}
}

// --- mfa_claim.go -------------------------------------------------------

func TestEligibleToClaim(t *testing.T) {
	if eligibleToClaim("", nil) {
		t.Error("empty email eligible")
	}
	if !eligibleToClaim("a@example.com", []string{"/Org/admin"}) {
		t.Error("admin-group user should be eligible")
	}
	// No admin group + anyAdminElsewhere()==false → eligible.
	if !eligibleToClaim("a@example.com", nil) {
		t.Error("group-less first user should be eligible")
	}
	if anyAdminElsewhere() {
		t.Error("anyAdminElsewhere should be false in this build")
	}
}

func TestClaimHandler_NotEligible(t *testing.T) {
	resetClaimState(t)
	// A non-admin identity in a deployment that DOES use admin groups: we
	// simulate "uses admin groups" by passing a non-admin group set. Since
	// anyAdminElsewhere() is always false, eligibleToClaim returns true for
	// a group-less user; to hit the not-eligible branch we need email=="".
	w := httptest.NewRecorder()
	claimHandler(w, claimReq(http.MethodGet, gatePathPrefix+"/claim", "", nil), "")
	if w.Code != http.StatusForbidden {
		t.Errorf("empty-identity claim = %d, want 403", w.Code)
	}
	if !strings.Contains(w.Body.String(), "Waiting to be claimed") {
		t.Error("not-eligible page not rendered")
	}
}

func TestClaimHandler_MethodGuard(t *testing.T) {
	resetClaimState(t)
	w := httptest.NewRecorder()
	claimHandler(w, claimReq(http.MethodDelete, gatePathPrefix+"/claim", "admin@example.com", []string{"/Org/admin"}), "admin@example.com")
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("DELETE claim = %d, want 405", w.Code)
	}
}

func TestClaimNotEligibleHTML(t *testing.T) {
	h := claimNotEligibleHTML("someone@example.com")
	if !strings.Contains(h, "Waiting to be claimed") {
		t.Error("claimNotEligibleHTML missing heading")
	}
}

func TestRecordServerClaim(t *testing.T) {
	resetClaimState(t)
	if err := recordServerClaim("rsc@example.com"); err != nil {
		t.Fatal(err)
	}
	if serverRootAdmin() != "rsc@example.com" {
		t.Errorf("root admin = %q", serverRootAdmin())
	}
	if serverClaimedAt() == "" {
		t.Error("claimed_at not recorded")
	}
}

// --- mfa_devices.go helpers --------------------------------------------

func TestClearDeviceCookie(t *testing.T) {
	w := httptest.NewRecorder()
	clearDeviceCookie(w)
	var found bool
	for _, c := range w.Result().Cookies() {
		if c.Name == deviceCookieName && c.MaxAge < 0 {
			found = true
		}
	}
	if !found {
		t.Error("clearDeviceCookie did not emit an expiring cookie")
	}
}

func TestDeviceNameFromRequest(t *testing.T) {
	cases := []struct{ ua, wantBrowser, wantOS string }{
		{"Mozilla/5.0 (Macintosh) Chrome/120 Safari/537", "Chrome", "macOS"},
		{"Mozilla/5.0 (Windows NT 10.0) Edg/120", "Edge", "Windows"},
		{"Mozilla/5.0 (X11; Linux) Firefox/120", "Firefox", "Linux"},
		{"Mozilla/5.0 (iPhone) Safari/604", "Safari", "iOS"},
		{"weird-agent", "Browser", ""},
	}
	for _, c := range cases {
		r := httptest.NewRequest(http.MethodGet, "https://x/", nil)
		r.Header.Set("User-Agent", c.ua)
		got := deviceNameFromRequest(r)
		if !strings.Contains(got, c.wantBrowser) {
			t.Errorf("UA %q → %q, want browser %q", c.ua, got, c.wantBrowser)
		}
		if c.wantOS != "" && !strings.Contains(got, c.wantOS) {
			t.Errorf("UA %q → %q, want OS %q", c.ua, got, c.wantOS)
		}
	}
}

func TestVerifyDeviceCookie_Edges(t *testing.T) {
	email := "vdc@example.com"
	// Wrong number of parts.
	if _, ok := verifyDeviceCookie(email, "a.b.c"); ok {
		t.Error("3-part cookie verified")
	}
	// Bad base64 email field.
	if _, ok := verifyDeviceCookie(email, "!!!.id.123.sig"); ok {
		t.Error("bad-base64 cookie verified")
	}
	// Valid cookie verifies and returns the id.
	w := httptest.NewRecorder()
	rec, err := addDevice(email, "vdc-dev")
	if err != nil {
		t.Fatal(err)
	}
	if err := setDeviceCookie(w, httptest.NewRequest(http.MethodGet, "https://x/", nil), email, rec.ID); err != nil {
		t.Fatal(err)
	}
	val := w.Result().Cookies()[0].Value
	id, ok := verifyDeviceCookie(email, val)
	if !ok || id != rec.ID {
		t.Errorf("valid cookie verify = (%q,%v)", id, ok)
	}
}

func TestCookieDomainForProtected(t *testing.T) {
	domain := writeTestConfig(t)
	if got := cookieDomainForProtected(); got != "."+domain {
		t.Errorf("cookieDomain = %q, want .%s", got, domain)
	}
}

// --- bailey_people.go workspaces attribution ---------------------------

func TestGatherPeople_AttributesWorkspaceOwnership(t *testing.T) {
	domain := writeTestConfig(t)
	owner := "wsperson@example.com"
	// GetWorkspaceList enumerates real workspace dirs; create one so the
	// per-person workspace-count branch runs.
	ws := "peoplews"
	mkWorkspaceDir(t, ws, true)
	if _, err := registerEndpoint(ws+"-editor."+domain, owner, "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	people, _ := gatherPeople(baileyReq(http.MethodGet, "/x", "boss@example.com", adminGrp))
	for _, p := range people {
		if strings.EqualFold(p.Email, owner) {
			if p.Workspaces < 1 {
				t.Errorf("workspace owner has count %d, want >=1", p.Workspaces)
			}
			return
		}
	}
	t.Error("workspace owner not in roster")
}

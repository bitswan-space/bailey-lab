package daemon

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"
)

// acctReq builds a request for the account handlers with the device
// cookie absent (the self-service pages just need identity).
func acctReq(method, path, email string, form string) *http.Request {
	var r *http.Request
	if form != "" {
		r = httptest.NewRequest(method, "https://bailey.example.com"+path, strings.NewReader(form))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	} else {
		r = httptest.NewRequest(method, "https://bailey.example.com"+path, nil)
	}
	r.Host = "bailey.example.com"
	if email != "" {
		r.Header.Set("X-Forwarded-Email", email)
	}
	return r
}

// --- accountDevicesHandler ---------------------------------------------

func TestAccountDevices_GETRendersList(t *testing.T) {
	email := "acctdev@example.com"
	if _, err := addDevice(email, "My Laptop"); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	accountDevicesHandler(w, acctReq(http.MethodGet, mfaGatePathPrefix+"/account/devices", email, ""), email)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	body := w.Body.String()
	if !strings.Contains(body, "Paired devices") || !strings.Contains(body, "My Laptop") {
		t.Error("device list page missing expected content")
	}
}

func TestAccountDevices_GETEmpty(t *testing.T) {
	email := "acctnodev@example.com"
	// Remove any devices for a clean empty render.
	devs, _ := loadDevices(email)
	for _, d := range devs {
		_ = removeDevice(email, d.ID)
	}
	w := httptest.NewRecorder()
	accountDevicesHandler(w, acctReq(http.MethodGet, mfaGatePathPrefix+"/account/devices", email, ""), email)
	if !strings.Contains(w.Body.String(), "No devices paired yet") {
		t.Error("empty device list note missing")
	}
}

func TestAccountDevices_POSTRemove(t *testing.T) {
	email := "acctremove@example.com"
	rec, err := addDevice(email, "ToRemove")
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	accountDevicesHandler(w, acctReq(http.MethodPost, mfaGatePathPrefix+"/account/devices", email, "action=remove&id="+rec.ID), email)
	if w.Code != http.StatusSeeOther {
		t.Fatalf("remove status = %d, want 303", w.Code)
	}
	if got, _ := findDevice(email, rec.ID); got != nil {
		t.Error("device not removed")
	}
}

func TestAccountDevices_POSTErrors(t *testing.T) {
	email := "accterr@example.com"
	// Missing id → 400.
	w := httptest.NewRecorder()
	accountDevicesHandler(w, acctReq(http.MethodPost, "/x", email, "action=remove"), email)
	if w.Code != http.StatusBadRequest {
		t.Errorf("missing id = %d, want 400", w.Code)
	}
	// Unknown action → 400.
	w2 := httptest.NewRecorder()
	accountDevicesHandler(w2, acctReq(http.MethodPost, "/x", email, "action=frobnicate"), email)
	if w2.Code != http.StatusBadRequest {
		t.Errorf("unknown action = %d, want 400", w2.Code)
	}
}

func TestAccountDevices_MethodGuard(t *testing.T) {
	w := httptest.NewRecorder()
	accountDevicesHandler(w, acctReq(http.MethodDelete, "/x", "u@example.com", ""), "u@example.com")
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("DELETE = %d, want 405", w.Code)
	}
}

// --- accountTOTPHandler -------------------------------------------------

func TestAccountTOTP_GETEnrolMintsCandidate(t *testing.T) {
	email := "accttotp@example.com"
	_ = dbDeleteTOTP(email)
	w := httptest.NewRecorder()
	accountTOTPHandler(w, acctReq(http.MethodGet, mfaGatePathPrefix+"/account/2fa", email, ""), email)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "Enrol TOTP recovery") {
		t.Error("enrol page not rendered")
	}
	var sawCookie bool
	for _, c := range w.Result().Cookies() {
		if c.Name == accountEnrolCookieName && c.Value != "" {
			sawCookie = true
		}
	}
	if !sawCookie {
		t.Error("candidate secret cookie not set on enrol GET")
	}
}

func TestAccountTOTP_GETStatusWhenEnrolled(t *testing.T) {
	email := "accttotpenrolled@example.com"
	if err := saveTOTPRecord(&totpRecord{Email: email, Secret: "S", CreatedAt: nowRFC3339()}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dbDeleteTOTP(email) })
	w := httptest.NewRecorder()
	accountTOTPHandler(w, acctReq(http.MethodGet, "/x", email, ""), email)
	if !strings.Contains(w.Body.String(), "TOTP enabled") {
		t.Error("status page not rendered for enrolled user")
	}
}

func TestAccountTOTP_POSTEnrolFlow(t *testing.T) {
	email := "accttotpflow@example.com"
	_ = dbDeleteTOTP(email)

	// First GET to obtain a candidate secret cookie.
	wGet := httptest.NewRecorder()
	accountTOTPHandler(wGet, acctReq(http.MethodGet, "/x", email, ""), email)
	var cookie *http.Cookie
	for _, c := range wGet.Result().Cookies() {
		if c.Name == accountEnrolCookieName {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatal("no candidate cookie")
	}

	// Wrong code → 401, re-renders enrol page.
	rWrong := acctReq(http.MethodPost, "/x", email, "action=enroll&code=000000")
	rWrong.AddCookie(cookie)
	wWrong := httptest.NewRecorder()
	accountTOTPHandler(wWrong, rWrong, email)
	if wWrong.Code != http.StatusUnauthorized {
		t.Errorf("wrong code = %d, want 401", wWrong.Code)
	}

	// Right code → 303 redirect, record persisted.
	code, _ := totp.GenerateCode(cookie.Value, time.Now())
	rOK := acctReq(http.MethodPost, "/x", email, "action=enroll&code="+code)
	rOK.AddCookie(cookie)
	wOK := httptest.NewRecorder()
	accountTOTPHandler(wOK, rOK, email)
	if wOK.Code != http.StatusSeeOther {
		t.Fatalf("right code = %d, want 303; body=%s", wOK.Code, wOK.Body.String())
	}
	if rec, _ := loadTOTPRecord(email); rec == nil {
		t.Error("TOTP record not persisted after enrol")
	}
}

func TestAccountTOTP_POSTEnrolNoCookie(t *testing.T) {
	email := "accttotpnocookie@example.com"
	_ = dbDeleteTOTP(email)
	w := httptest.NewRecorder()
	accountTOTPHandler(w, acctReq(http.MethodPost, "/x", email, "action=enroll&code=123456"), email)
	if w.Code != http.StatusBadRequest {
		t.Errorf("enrol w/o cookie = %d, want 400", w.Code)
	}
}

func TestAccountTOTP_DisableAdminOnly(t *testing.T) {
	email := "accttotpdisable@example.com"
	if err := saveTOTPRecord(&totpRecord{Email: email, Secret: "S", CreatedAt: nowRFC3339()}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dbDeleteTOTP(email) })

	// Non-admin disable → 403.
	w := httptest.NewRecorder()
	accountTOTPHandler(w, acctReq(http.MethodPost, "/x", email, "action=disable"), email)
	if w.Code != http.StatusForbidden {
		t.Errorf("non-admin disable = %d, want 403", w.Code)
	}

	// Admin disable → 303 + record gone.
	rAdmin := acctReq(http.MethodPost, "/x", email, "action=disable")
	rAdmin.Header.Set("X-Forwarded-Groups", adminGrp)
	wAdmin := httptest.NewRecorder()
	accountTOTPHandler(wAdmin, rAdmin, email)
	if wAdmin.Code != http.StatusSeeOther {
		t.Fatalf("admin disable = %d, want 303", wAdmin.Code)
	}
	if rec, _ := loadTOTPRecord(email); rec != nil {
		t.Error("TOTP record not deleted on admin disable")
	}
}

func TestAccountTOTP_UnknownActionAndMethod(t *testing.T) {
	email := "acctmisc@example.com"
	_ = dbDeleteTOTP(email)
	w := httptest.NewRecorder()
	accountTOTPHandler(w, acctReq(http.MethodPost, "/x", email, "action=zzz"), email)
	if w.Code != http.StatusBadRequest {
		t.Errorf("unknown action = %d, want 400", w.Code)
	}
	w2 := httptest.NewRecorder()
	accountTOTPHandler(w2, acctReq(http.MethodDelete, "/x", email, ""), email)
	if w2.Code != http.StatusMethodNotAllowed {
		t.Errorf("DELETE = %d, want 405", w2.Code)
	}
}

// --- candidateSecretForAccount cookie reuse ----------------------------

func TestCandidateSecretForAccount_ReusesCookie(t *testing.T) {
	email := "acctcand@example.com"
	// First call mints a secret + sets a cookie.
	w1 := httptest.NewRecorder()
	r1 := acctReq(http.MethodGet, "/x", email, "")
	secret1 := candidateSecretForAccount(w1, r1, email)
	if secret1 == "" {
		t.Fatal("no secret minted")
	}
	var cookie *http.Cookie
	for _, c := range w1.Result().Cookies() {
		if c.Name == accountEnrolCookieName {
			cookie = c
		}
	}
	// Second call with the cookie present reuses the same secret.
	r2 := acctReq(http.MethodGet, "/x", email, "")
	r2.AddCookie(cookie)
	w2 := httptest.NewRecorder()
	secret2 := candidateSecretForAccount(w2, r2, email)
	if secret2 != secret1 {
		t.Errorf("secret not reused: %q vs %q", secret1, secret2)
	}
}

// --- safeReturnTo -------------------------------------------------------

func TestSafeReturnTo(t *testing.T) {
	cases := map[string]string{
		"":                  "/fallback",
		"/ok":               "/ok",
		"//evil.com":        "/fallback",
		"https://evil.com":  "/fallback",
		"relative":          "/fallback",
	}
	for in, want := range cases {
		if got := safeReturnTo(in, "/fallback"); got != want {
			t.Errorf("safeReturnTo(%q) = %q, want %q", in, got, want)
		}
	}
}

// --- inline TOTP HTML renderers ----------------------------------------

func TestRenderTOTPInlineHTML(t *testing.T) {
	email := "inline@example.com"
	_ = dbDeleteTOTP(email)
	// Not enrolled → enrol markup with QR + form.
	w := httptest.NewRecorder()
	html := renderTOTPInlineHTML(w, acctReq(http.MethodGet, "/x", email, ""), email, true, "/back")
	if !strings.Contains(html, "Scan with an authenticator") || !strings.Contains(html, "/back") {
		t.Error("inline enrol HTML missing expected pieces")
	}

	// Enrolled → status markup; admin sees disable button.
	if err := saveTOTPRecord(&totpRecord{Email: email, Secret: "S", CreatedAt: nowRFC3339()}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dbDeleteTOTP(email) })
	w2 := httptest.NewRecorder()
	statusHTML := renderTOTPInlineHTML(w2, acctReq(http.MethodGet, "/x", email, ""), email, true, "/back")
	if !strings.Contains(statusHTML, "TOTP enabled") || !strings.Contains(statusHTML, "Disable TOTP") {
		t.Error("inline status HTML missing disable control for admin")
	}
	// Non-admin: no disable button.
	nonAdmin := inlineTOTPStatusHTML(email, false, "")
	if strings.Contains(nonAdmin, "Disable TOTP") {
		t.Error("non-admin inline status should not show disable")
	}
}

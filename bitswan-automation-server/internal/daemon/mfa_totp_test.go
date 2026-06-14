package daemon

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"
)

func totpReq(method, path, email, form string) *http.Request {
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

// --- session cookie sign/verify ----------------------------------------

func TestSessionCookie_SignVerifyRoundTrip(t *testing.T) {
	email := "sess@example.com"
	val, err := signedSessionCookie(email, time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if !verifySessionCookie(email, val) {
		t.Error("valid session cookie failed verification")
	}
	// Wrong email rejected.
	if verifySessionCookie("other@example.com", val) {
		t.Error("session cookie verified for the wrong email")
	}
	// Expired rejected.
	exp, _ := signedSessionCookie(email, time.Now().Add(-time.Hour))
	if verifySessionCookie(email, exp) {
		t.Error("expired session cookie verified")
	}
	// Malformed rejected.
	if verifySessionCookie(email, "a.b") {
		t.Error("malformed cookie verified")
	}
	if verifySessionCookie(email, "notbase64!.123.deadbeef") {
		t.Error("bad base64 cookie verified")
	}
}

func TestSetAndHasValidSession(t *testing.T) {
	email := "sess2@example.com"
	w := httptest.NewRecorder()
	r := totpReq(http.MethodGet, "/x", email, "")
	if err := setSessionCookie(w, r, email); err != nil {
		t.Fatal(err)
	}
	// Replay the cookie on a new request.
	r2 := totpReq(http.MethodGet, "/x", email, "")
	for _, c := range w.Result().Cookies() {
		r2.AddCookie(c)
	}
	if !hasValidSession(r2, email) {
		t.Error("session not valid after setSessionCookie")
	}
	// No cookie → false.
	if hasValidSession(totpReq(http.MethodGet, "/x", email, ""), email) {
		t.Error("hasValidSession true with no cookie")
	}
}

func TestEnrolCookieName(t *testing.T) {
	if enrolCookieName(mfaGatePathPrefix+"/account/2fa") != "_bailey_account_enroll" {
		t.Error("account enrol cookie name wrong")
	}
	if enrolCookieName(mfaGatePathPrefix+"/admin/enroll") != "_bailey_enroll" {
		t.Error("admin enrol cookie name wrong")
	}
}

func TestTOTPIssuerName(t *testing.T) {
	domain := writeTestConfig(t)
	if got := totpIssuerName(); got != "Bailey - "+domain {
		t.Errorf("issuer = %q", got)
	}
	if got := totpIssuerForRequest(totpReq(http.MethodGet, "/x", "u@example.com", "")); !strings.HasPrefix(got, "Bailey") {
		t.Errorf("issuerForRequest = %q", got)
	}
}

// --- enrol gate handlers ------------------------------------------------

func TestTOTPGate_EnrolGETMintsAndPOSTSaves(t *testing.T) {
	base := mfaGatePathPrefix + "/admin"
	email := "totpgate@example.com"
	_ = dbDeleteTOTP(email)

	// GET enroll → 200 + candidate cookie.
	wGet := httptest.NewRecorder()
	handleTOTPGate(wGet, totpReq(http.MethodGet, base+enrollPathSuffix, email, ""), base, email)
	if wGet.Code != http.StatusOK {
		t.Fatalf("enroll GET = %d", wGet.Code)
	}
	if !strings.Contains(wGet.Body.String(), "Set up an authenticator") {
		t.Error("enroll page not rendered")
	}
	var cookie *http.Cookie
	for _, c := range wGet.Result().Cookies() {
		if c.Name == enrolCookieName(base) {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatal("no candidate cookie minted")
	}

	// POST wrong code → 401.
	rWrong := totpReq(http.MethodPost, base+enrollPathSuffix, email, "code=000000")
	rWrong.AddCookie(cookie)
	wWrong := httptest.NewRecorder()
	handleTOTPGate(wWrong, rWrong, base, email)
	if wWrong.Code != http.StatusUnauthorized {
		t.Errorf("wrong enroll code = %d, want 401", wWrong.Code)
	}

	// POST right code → 303 + saved + session cookie.
	code, _ := totp.GenerateCode(cookie.Value, time.Now())
	rOK := totpReq(http.MethodPost, base+enrollPathSuffix, email, "code="+code)
	rOK.AddCookie(cookie)
	wOK := httptest.NewRecorder()
	handleTOTPGate(wOK, rOK, base, email)
	if wOK.Code != http.StatusSeeOther {
		t.Fatalf("right enroll code = %d, want 303; body=%s", wOK.Code, wOK.Body.String())
	}
	if rec, _ := loadTOTPRecord(email); rec == nil {
		t.Error("record not saved after enroll")
	}
}

func TestTOTPGate_EnrolGETRedirectsWhenEnrolled(t *testing.T) {
	base := mfaGatePathPrefix + "/admin"
	email := "totpgateenrolled@example.com"
	if err := saveTOTPRecord(&totpRecord{Email: email, Secret: "S", CreatedAt: nowRFC3339()}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dbDeleteTOTP(email) })
	w := httptest.NewRecorder()
	handleTOTPGate(w, totpReq(http.MethodGet, base+enrollPathSuffix, email, ""), base, email)
	if w.Header().Get("Location") != base+challengePathSuffix {
		t.Errorf("enrolled enroll GET Location = %q, want challenge", w.Header().Get("Location"))
	}
}

func TestTOTPGate_EnrolPOSTNoCookie(t *testing.T) {
	base := mfaGatePathPrefix + "/admin"
	email := "totpgatenocookie@example.com"
	_ = dbDeleteTOTP(email)
	w := httptest.NewRecorder()
	handleTOTPGate(w, totpReq(http.MethodPost, base+enrollPathSuffix, email, "code=123456"), base, email)
	if w.Code != http.StatusBadRequest {
		t.Errorf("enroll POST w/o cookie = %d, want 400", w.Code)
	}
}

// --- challenge gate handlers -------------------------------------------

func TestTOTPGate_ChallengeGETRedirectsWhenNotEnrolled(t *testing.T) {
	base := mfaGatePathPrefix + "/admin"
	email := "totpchallnoenrol@example.com"
	_ = dbDeleteTOTP(email)
	w := httptest.NewRecorder()
	handleTOTPGate(w, totpReq(http.MethodGet, base+challengePathSuffix, email, ""), base, email)
	if w.Header().Get("Location") != base+enrollPathSuffix {
		t.Errorf("challenge GET Location = %q, want enroll", w.Header().Get("Location"))
	}
}

func TestTOTPGate_ChallengeFlow(t *testing.T) {
	base := mfaGatePathPrefix + "/admin"
	email := "totpchall@example.com"
	secret := enrolTOTP(t, email)

	// GET challenge → 200, renders the code form + a pairing code.
	wGet := httptest.NewRecorder()
	handleTOTPGate(wGet, totpReq(http.MethodGet, base+challengePathSuffix, email, ""), base, email)
	if wGet.Code != http.StatusOK {
		t.Fatalf("challenge GET = %d", wGet.Code)
	}
	if !strings.Contains(wGet.Body.String(), "Second factor") {
		t.Error("challenge page not rendered")
	}

	// POST wrong code → 401.
	wWrong := httptest.NewRecorder()
	handleTOTPGate(wWrong, totpReq(http.MethodPost, base+challengePathSuffix, email, "code=000000"), base, email)
	if wWrong.Code != http.StatusUnauthorized {
		t.Errorf("wrong challenge code = %d, want 401", wWrong.Code)
	}

	// POST right code → 303 + session cookie.
	code, _ := totp.GenerateCode(secret, time.Now())
	wOK := httptest.NewRecorder()
	handleTOTPGate(wOK, totpReq(http.MethodPost, base+challengePathSuffix, email, "code="+code), base, email)
	if wOK.Code != http.StatusSeeOther {
		t.Fatalf("right challenge code = %d, want 303", wOK.Code)
	}
	var sawSession bool
	for _, c := range wOK.Result().Cookies() {
		if c.Name == twoFactorCookieName && c.Value != "" {
			sawSession = true
		}
	}
	if !sawSession {
		t.Error("challenge success did not set the session cookie")
	}
}

func TestTOTPGate_ChallengeGETWithValidSessionRedirects(t *testing.T) {
	base := mfaGatePathPrefix + "/admin"
	email := "totpchallsess@example.com"
	enrolTOTP(t, email)
	// Pre-set a valid session.
	wSet := httptest.NewRecorder()
	if err := setSessionCookie(wSet, totpReq(http.MethodGet, "/x", email, ""), email); err != nil {
		t.Fatal(err)
	}
	r := totpReq(http.MethodGet, base+challengePathSuffix, email, "")
	for _, c := range wSet.Result().Cookies() {
		r.AddCookie(c)
	}
	w := httptest.NewRecorder()
	handleTOTPGate(w, r, base, email)
	// With a valid session it should redirect (originRedirect) rather than
	// render the form.
	if w.Code != http.StatusSeeOther {
		t.Errorf("challenge GET with session = %d, want 303 redirect", w.Code)
	}
}

func TestTOTPGate_MethodGuard(t *testing.T) {
	base := mfaGatePathPrefix + "/admin"
	w := httptest.NewRecorder()
	handleTOTPGate(w, totpReq(http.MethodDelete, base+enrollPathSuffix, "u@example.com", ""), base, "u@example.com")
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("DELETE = %d, want 405", w.Code)
	}
}

// --- HTML renderers -----------------------------------------------------

func TestTOTPHTMLRenderers(t *testing.T) {
	writeTestConfig(t)
	// Use a real generated secret so the QR image encodes.
	key, _ := totp.Generate(totp.GenerateOpts{Issuer: "Bailey", AccountName: "html@example.com"})
	enroll := totpEnrollHTML("html@example.com", key.Secret(), mfaGatePathPrefix+"/admin", "oops")
	if !strings.Contains(enroll, "Set up an authenticator") || !strings.Contains(enroll, "oops") {
		t.Error("enroll HTML missing content/error")
	}
	chall := totpChallengeHTML("html@example.com", mfaGatePathPrefix+"/admin", "bad", &pairingEntry{Code: "123456"})
	if !strings.Contains(chall, "Second factor") || !strings.Contains(chall, "123456") {
		t.Error("challenge HTML missing content/pair code")
	}
	// No pair entry → no pairing block.
	chall2 := totpChallengeHTML("html@example.com", mfaGatePathPrefix+"/admin", "", nil)
	if strings.Contains(chall2, "approve from another browser") {
		t.Error("challenge HTML rendered a pairing block without a pair")
	}
}

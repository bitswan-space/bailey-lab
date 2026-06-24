package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"
)

// gateAPIReq builds a request through the real handleBailey router for a
// gate-API path, carrying the oauth2-proxy identity headers but NO device
// cookie (the caller is authenticated-but-untrusted, the pre-trust state).
func gateAPIReq(method, path, email string, groups ...string) *http.Request {
	r := httptest.NewRequest(method, "https://bailey.example.com"+path, nil)
	r.Host = "bailey.example.com"
	if email != "" {
		r.Header.Set("X-Forwarded-Email", email)
	}
	if len(groups) > 0 {
		r.Header.Set("X-Forwarded-Groups", strings.Join(groups, ","))
	}
	return r
}

func gateAPIJSON(method, path, email, body string, groups ...string) *http.Request {
	r := httptest.NewRequest(method, "https://bailey.example.com"+path, strings.NewReader(body))
	r.Host = "bailey.example.com"
	r.Header.Set("Content-Type", "application/json")
	if email != "" {
		r.Header.Set("X-Forwarded-Email", email)
	}
	if len(groups) > 0 {
		r.Header.Set("X-Forwarded-Groups", strings.Join(groups, ","))
	}
	return r
}

// --- gate-state ---------------------------------------------------------

func TestGateAPI_StateUnclaimed(t *testing.T) {
	resetClaimState(t)
	w := dispatch(gateAPIReq(http.MethodGet, "/bailey/api/gate-state", "admin@example.com", "/Org/admin"))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	var st gateState
	if err := json.Unmarshal(w.Body.Bytes(), &st); err != nil {
		t.Fatalf("decode: %v\n%s", err, w.Body.String())
	}
	if st.Email != "admin@example.com" {
		t.Errorf("email = %q", st.Email)
	}
	if !st.IsAdmin {
		t.Error("is_admin = false, want true for admin group")
	}
	if st.Claimed {
		t.Error("claimed = true on a reset (unclaimed) server")
	}
	if !st.CanClaim {
		t.Error("can_claim = false; admin on unclaimed server should be eligible")
	}
	if st.Trusted {
		t.Error("trusted = true with no device cookie")
	}
}

func TestGateAPI_StateClaimed(t *testing.T) {
	markServerClaimed(t)
	w := dispatch(gateAPIReq(http.MethodGet, "/bailey/api/gate-state", "user@example.com"))
	var st gateState
	_ = json.Unmarshal(w.Body.Bytes(), &st)
	if !st.Claimed {
		t.Error("claimed = false after markServerClaimed")
	}
	if st.CanClaim {
		t.Error("can_claim = true on an already-claimed server")
	}
}

// --- claim --------------------------------------------------------------

func TestGateAPI_ClaimBootstrapsAndTrusts(t *testing.T) {
	resetClaimState(t)
	r := gateAPIJSON(http.MethodPost, "/bailey/api/claim", "first@example.com", "{}", "/Org/admin")
	w := dispatch(r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	// Root admin recorded + this browser trusted (device cookie set).
	if got := serverRootAdmin(); got != "first@example.com" {
		t.Errorf("root admin = %q, want first@example.com", got)
	}
	if !serverClaimed() {
		t.Error("server not claimed after claim")
	}
	var sawCookie bool
	for _, c := range w.Result().Cookies() {
		if c.Name == deviceCookieName && c.Value != "" {
			sawCookie = true
		}
	}
	if !sawCookie {
		t.Error("claim did not set a device cookie (this browser must be trusted)")
	}
}

func TestGateAPI_ClaimRejectedWhenClaimed(t *testing.T) {
	markServerClaimed(t)
	w := dispatch(gateAPIJSON(http.MethodPost, "/bailey/api/claim", "late@example.com", "{}", "/Org/admin"))
	if w.Code != http.StatusConflict {
		t.Errorf("status = %d, want 409 on an already-claimed server; body=%s", w.Code, w.Body.String())
	}
}

// --- pending-pair + poll ------------------------------------------------

func TestGateAPI_PendingPairMintsCode(t *testing.T) {
	markServerClaimed(t)
	w := dispatch(gateAPIReq(http.MethodGet, "/bailey/api/pending-pair", "pp@example.com"))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", w.Code, w.Body.String())
	}
	var got struct {
		Code     string `json:"code"`
		Approved bool   `json:"approved"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &got)
	if len(got.Code) != 6 {
		t.Errorf("code = %q, want a 6-digit code", got.Code)
	}
	if got.Approved {
		t.Error("approved = true on a fresh pending pair")
	}
}

func TestGateAPI_PollPendingThenApproved(t *testing.T) {
	markServerClaimed(t)
	email := "poll@example.com"
	// Mint a pending pair.
	if _, err := generatePendingPair(email); err != nil {
		t.Fatal(err)
	}
	// Not approved yet → approved:false, no cookie.
	w := dispatch(gateAPIReq(http.MethodGet, "/bailey/api/pending-pair/poll", email))
	var got struct {
		Approved bool `json:"approved"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &got)
	if got.Approved {
		t.Fatal("approved = true before any approval")
	}
	// Approve it (as if a trusted admin did), then poll again.
	e, _ := dbLoadPendingPairByEmail(email)
	if approvePendingPair(email, e.Code, "admin@example.com", true) == nil {
		t.Fatal("approve failed")
	}
	w2 := dispatch(gateAPIReq(http.MethodGet, "/bailey/api/pending-pair/poll", email))
	var got2 struct {
		Approved bool `json:"approved"`
	}
	_ = json.Unmarshal(w2.Body.Bytes(), &got2)
	if !got2.Approved {
		t.Fatalf("approved = false after approval; body=%s", w2.Body.String())
	}
	var sawCookie bool
	for _, c := range w2.Result().Cookies() {
		if c.Name == deviceCookieName && c.Value != "" {
			sawCookie = true
		}
	}
	if !sawCookie {
		t.Error("poll on approved pair did not set the device cookie")
	}
}

// --- self-trust ---------------------------------------------------------

func TestGateAPI_SelfTrustWithTOTP(t *testing.T) {
	markServerClaimed(t)
	email := "selftrust@example.com"
	secret := enrolTOTP(t, email)
	code, _ := totp.GenerateCode(secret, time.Now())
	w := dispatch(gateAPIJSON(http.MethodPost, "/bailey/api/self-trust", email, `{"totp":"`+code+`"}`))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	assertDeviceCookie(t, w, "self-trust")
}

func TestGateAPI_SelfTrustWrongCode(t *testing.T) {
	markServerClaimed(t)
	email := "selftrustbad@example.com"
	enrolTOTP(t, email)
	w := dispatch(gateAPIJSON(http.MethodPost, "/bailey/api/self-trust", email, `{"totp":"000000"}`))
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401 for wrong code", w.Code)
	}
}

func TestGateAPI_SelfTrustWithoutEnrolment(t *testing.T) {
	markServerClaimed(t)
	w := dispatch(gateAPIJSON(http.MethodPost, "/bailey/api/self-trust", "noauth@example.com", `{"totp":"123456"}`))
	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403 when no authenticator is enrolled", w.Code)
	}
}

// --- recover ------------------------------------------------------------

func TestGateAPI_RecoverWithTOTP(t *testing.T) {
	markServerClaimed(t)
	email := "recover@example.com"
	secret := enrolTOTP(t, email)
	code, _ := totp.GenerateCode(secret, time.Now())
	w := dispatch(gateAPIJSON(http.MethodPost, "/bailey/api/recover", email, `{"totp":"`+code+`"}`))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	assertDeviceCookie(t, w, "recover")
}

func TestGateAPI_RecoverWithBackupCode(t *testing.T) {
	markServerClaimed(t)
	email := "recoverbackup@example.com"
	codes, err := generateBackupCodes()
	if err != nil {
		t.Fatal(err)
	}
	if err := dbSaveBackupCodes(email, codes); err != nil {
		t.Fatal(err)
	}
	w := dispatch(gateAPIJSON(http.MethodPost, "/bailey/api/recover", email, `{"backup":"`+codes[0]+`"}`))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	assertDeviceCookie(t, w, "recover-backup")
	// Single-use: the same code must now fail.
	w2 := dispatch(gateAPIJSON(http.MethodPost, "/bailey/api/recover", email, `{"backup":"`+codes[0]+`"}`))
	if w2.Code == http.StatusOK {
		t.Error("backup code was reusable; want single-use")
	}
}

func TestGateAPI_RecoverNoMethod(t *testing.T) {
	markServerClaimed(t)
	w := dispatch(gateAPIJSON(http.MethodPost, "/bailey/api/recover", "norecovery@example.com", `{"totp":"123456"}`))
	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403 when no recovery method set up", w.Code)
	}
}

// --- TOTP enrol + verify ------------------------------------------------

func TestGateAPI_TOTPEnrollAndVerify(t *testing.T) {
	markServerClaimed(t)
	email := "enrol@example.com"
	_ = dbDeleteTOTP(email)

	// Enroll → secret + otpauth_url, candidate cookie set.
	wEnroll := dispatch(gateAPIReq(http.MethodGet, "/bailey/api/totp/enroll", email))
	if wEnroll.Code != http.StatusOK {
		t.Fatalf("enroll status = %d; body=%s", wEnroll.Code, wEnroll.Body.String())
	}
	var en struct {
		Secret     string `json:"secret"`
		OtpauthURL string `json:"otpauth_url"`
	}
	_ = json.Unmarshal(wEnroll.Body.Bytes(), &en)
	if en.Secret == "" || !strings.HasPrefix(en.OtpauthURL, "otpauth://") {
		t.Fatalf("bad enroll payload: %+v", en)
	}
	var enrolCookie *http.Cookie
	for _, c := range wEnroll.Result().Cookies() {
		if c.Name == gateEnrolCookieName {
			enrolCookie = c
		}
	}
	if enrolCookie == nil {
		t.Fatal("enroll did not set the candidate-secret cookie")
	}

	// Verify with the right code → ok + backup codes; record persisted.
	code, _ := totp.GenerateCode(en.Secret, time.Now())
	rv := gateAPIJSON(http.MethodPost, "/bailey/api/totp/verify", email, `{"code":"`+code+`"}`)
	rv.AddCookie(enrolCookie)
	wv := dispatch(rv)
	if wv.Code != http.StatusOK {
		t.Fatalf("verify status = %d; body=%s", wv.Code, wv.Body.String())
	}
	var vr struct {
		OK          bool     `json:"ok"`
		BackupCodes []string `json:"backup_codes"`
	}
	_ = json.Unmarshal(wv.Body.Bytes(), &vr)
	if !vr.OK || len(vr.BackupCodes) == 0 {
		t.Fatalf("verify payload missing ok/backup_codes: %+v", vr)
	}
	if rec, _ := loadTOTPRecord(email); rec == nil {
		t.Error("TOTP record not persisted after verify")
	}
	// A returned backup code must actually work for recovery.
	if ok, _ := dbConsumeBackupCode(email, vr.BackupCodes[0]); !ok {
		t.Error("returned backup code is not valid")
	}
}

// --- backup-codes/regenerate -------------------------------------------

func TestGateAPI_BackupCodesRegenerate(t *testing.T) {
	markServerClaimed(t)
	email := "regen@example.com"
	w := dispatch(gateAPIJSON(http.MethodPost, "/bailey/api/backup-codes/regenerate", email, "{}"))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", w.Code, w.Body.String())
	}
	var got struct {
		BackupCodes []string `json:"backup_codes"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &got)
	if len(got.BackupCodes) == 0 {
		t.Fatal("no backup codes returned")
	}
	if !dbBackupCodesExist(email) {
		t.Error("backup codes not persisted")
	}
	// Regenerating replaces the set — the old code must no longer validate.
	old := got.BackupCodes[0]
	w2 := dispatch(gateAPIJSON(http.MethodPost, "/bailey/api/backup-codes/regenerate", email, "{}"))
	var got2 struct {
		BackupCodes []string `json:"backup_codes"`
	}
	_ = json.Unmarshal(w2.Body.Bytes(), &got2)
	stillThere := false
	for _, c := range got2.BackupCodes {
		if c == old {
			stillThere = true
		}
	}
	if stillThere {
		t.Error("regenerate kept an old code")
	}
}

// --- identity / method guards ------------------------------------------

func TestGateAPI_RequiresIdentity(t *testing.T) {
	markServerClaimed(t)
	w := dispatch(gateAPIJSON(http.MethodPost, "/bailey/api/claim", "", "{}"))
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401 with no identity", w.Code)
	}
}

func TestGateAPI_MethodGuards(t *testing.T) {
	markServerClaimed(t)
	// gate-state is GET-only.
	if w := dispatch(gateAPIReq(http.MethodPost, "/bailey/api/gate-state", "u@example.com")); w.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST gate-state = %d, want 405", w.Code)
	}
	// claim is POST-only.
	if w := dispatch(gateAPIReq(http.MethodGet, "/bailey/api/claim", "u@example.com")); w.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET claim = %d, want 405", w.Code)
	}
}

// --- helpers ------------------------------------------------------------

// enrolTOTP persists a TOTP record for email and returns its secret, so a
// test can compute a valid current code with totp.GenerateCode.
func enrolTOTP(t *testing.T, email string) string {
	t.Helper()
	key, err := totp.Generate(totp.GenerateOpts{Issuer: "Bailey", AccountName: email})
	if err != nil {
		t.Fatal(err)
	}
	if err := saveTOTPRecord(&totpRecord{Email: email, Secret: key.Secret()}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dbDeleteTOTP(email) })
	return key.Secret()
}

func assertDeviceCookie(t *testing.T, w *httptest.ResponseRecorder, ctx string) {
	t.Helper()
	for _, c := range w.Result().Cookies() {
		if c.Name == deviceCookieName && c.Value != "" {
			return
		}
	}
	t.Errorf("%s: no device cookie set (this browser should be trusted)", ctx)
}

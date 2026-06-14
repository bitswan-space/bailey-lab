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

func pairReq(method, path, email, form string) *http.Request {
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

// trustedDeviceReq returns a request carrying a valid device cookie for
// email, so approverIsTrusted(...) reports true (an already-paired
// browser). groups is attached as the forwarded-groups header.
func trustedDeviceReq(t *testing.T, method, path, email, form string, groups ...string) *http.Request {
	t.Helper()
	rec, err := addDevice(email, "approver-device")
	if err != nil {
		t.Fatal(err)
	}
	w0 := httptest.NewRecorder()
	if err := setDeviceCookie(w0, pairReq(http.MethodGet, "/", email, ""), email, rec.ID); err != nil {
		t.Fatal(err)
	}
	r := pairReq(method, path, email, form)
	for _, c := range w0.Result().Cookies() {
		r.AddCookie(c)
	}
	if len(groups) > 0 {
		r.Header.Set("X-Forwarded-Groups", strings.Join(groups, ","))
	}
	return r
}

// --- pendingPairHandler -------------------------------------------------

func TestPendingPairHandler_GETMintsCodePage(t *testing.T) {
	email := "pph@example.com"
	_ = dbDeleteTOTP(email)
	w := httptest.NewRecorder()
	pendingPairHandler(w, pairReq(http.MethodGet, mfaGatePathPrefix+"/pending-pair", email, ""), email)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "Trust this device") {
		t.Error("pending-pair page not rendered")
	}
}

func TestPendingPairHandler_MethodGuard(t *testing.T) {
	w := httptest.NewRecorder()
	pendingPairHandler(w, pairReq(http.MethodPost, "/x", "u@example.com", ""), "u@example.com")
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST = %d, want 405", w.Code)
	}
}

// --- selfTrustHandler ---------------------------------------------------

func TestSelfTrustHandler_Success(t *testing.T) {
	email := "selftrustok@example.com"
	secret := enrolTOTP(t, email)
	code, _ := totp.GenerateCode(secret, time.Now())
	w := httptest.NewRecorder()
	selfTrustHandler(w, pairReq(http.MethodPost, mfaGatePathPrefix+"/self-trust", email, "code="+code), email)
	if w.Code != http.StatusSeeOther {
		t.Fatalf("self-trust success = %d, want 303; body=%s", w.Code, w.Body.String())
	}
	var sawDevice bool
	for _, c := range w.Result().Cookies() {
		if c.Name == deviceCookieName && c.Value != "" {
			sawDevice = true
		}
	}
	if !sawDevice {
		t.Error("self-trust did not set a device cookie")
	}
}

func TestSelfTrustHandler_WrongCode(t *testing.T) {
	email := "selftrustwrong@example.com"
	enrolTOTP(t, email)
	w := httptest.NewRecorder()
	selfTrustHandler(w, pairReq(http.MethodPost, "/x", email, "code=000000"), email)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("wrong self-trust code = %d, want 401", w.Code)
	}
}

func TestSelfTrustHandler_MethodGuardWithEnrolment(t *testing.T) {
	email := "selftrustget@example.com"
	enrolTOTP(t, email)
	w := httptest.NewRecorder()
	selfTrustHandler(w, pairReq(http.MethodGet, "/x", email, ""), email)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET self-trust (enrolled) = %d, want 405", w.Code)
	}
}

// --- pendingPairPollHandler --------------------------------------------

func TestPendingPairPoll_NoContentThenApproved(t *testing.T) {
	email := "pollpair@example.com"
	if _, err := generatePendingPair(email); err != nil {
		t.Fatal(err)
	}
	// Not approved yet → 204.
	w := httptest.NewRecorder()
	pendingPairPollHandler(w, pairReq(http.MethodGet, "/x", email, ""), email)
	if w.Code != http.StatusNoContent {
		t.Fatalf("unapproved poll = %d, want 204", w.Code)
	}
	// Approve, then poll → 200 JSON + device cookie.
	e, _ := dbLoadPendingPairByEmail(email)
	if approvePendingPair(email, e.Code, "admin@example.com", true) == nil {
		t.Fatal("approve failed")
	}
	w2 := httptest.NewRecorder()
	pendingPairPollHandler(w2, pairReq(http.MethodGet, "/x", email, ""), email)
	if w2.Code != http.StatusOK {
		t.Fatalf("approved poll = %d, want 200", w2.Code)
	}
	var got map[string]any
	_ = json.Unmarshal(w2.Body.Bytes(), &got)
	if got["approved"] != true {
		t.Errorf("approved field = %v", got["approved"])
	}
}

// --- approveHandler (HTML) ----------------------------------------------

func TestApproveHandler_GETRendersList(t *testing.T) {
	w := httptest.NewRecorder()
	approveHandler(w, pairReq(http.MethodGet, mfaGatePathPrefix+"/approve", "approver@example.com", ""), "approver@example.com")
	if w.Code != http.StatusOK {
		t.Fatalf("approve GET = %d", w.Code)
	}
}

func TestApproveHandler_POSTMissingFields(t *testing.T) {
	w := httptest.NewRecorder()
	approveHandler(w, pairReq(http.MethodPost, "/x", "approver@example.com", "email=&code="), "approver@example.com")
	if w.Code != http.StatusBadRequest {
		t.Errorf("missing fields = %d, want 400", w.Code)
	}
}

func TestApproveHandler_POSTUntrustedApproverForbidden(t *testing.T) {
	// No device cookie → approverIsTrusted false → 403.
	w := httptest.NewRecorder()
	approveHandler(w, pairReq(http.MethodPost, "/x", "approver@example.com", "email=target@example.com&code=123456"), "approver@example.com")
	if w.Code != http.StatusForbidden {
		t.Errorf("untrusted approver = %d, want 403", w.Code)
	}
}

func TestApproveHandler_POSTTrustedAdminApproves(t *testing.T) {
	target := "targetapprove@example.com"
	if _, err := generatePendingPair(target); err != nil {
		t.Fatal(err)
	}
	e, _ := dbLoadPendingPairByEmail(target)
	r := trustedDeviceReq(t, http.MethodPost, mfaGatePathPrefix+"/approve",
		"adminapprover@example.com", "email="+target+"&code="+e.Code, adminGrp)
	w := httptest.NewRecorder()
	approveHandler(w, r, "adminapprover@example.com")
	if w.Code != http.StatusOK {
		t.Fatalf("trusted admin approve = %d; body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "Approved "+target) {
		t.Error("approval confirmation missing")
	}
}

func TestApproveHandler_NonAdminCannotApproveOther(t *testing.T) {
	// Trusted but non-admin approver trying to approve a different user.
	r := trustedDeviceReq(t, http.MethodPost, "/x",
		"plainuser@example.com", "email=someoneelse@example.com&code=123456")
	w := httptest.NewRecorder()
	approveHandler(w, r, "plainuser@example.com")
	if w.Code != http.StatusForbidden {
		t.Errorf("non-admin approving other = %d, want 403", w.Code)
	}
}

// --- handleApprovePairJSON ---------------------------------------------

func TestApprovePairJSON_Success(t *testing.T) {
	target := "jsontarget@example.com"
	if _, err := generatePendingPair(target); err != nil {
		t.Fatal(err)
	}
	e, _ := dbLoadPendingPairByEmail(target)
	r := trustedDeviceReq(t, http.MethodPost, mfaGatePathPrefix+"/approve",
		"jsonadmin@example.com", "email="+target+"&code="+e.Code, adminGrp)
	w := httptest.NewRecorder()
	handleApprovePairJSON(w, r, "jsonadmin@example.com")
	if w.Code != http.StatusOK {
		t.Fatalf("json approve = %d; body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), target) {
		t.Error("json approve response missing target")
	}
}

func TestApprovePairJSON_Guards(t *testing.T) {
	// Method guard.
	w := httptest.NewRecorder()
	handleApprovePairJSON(w, pairReq(http.MethodGet, "/x", "a@example.com", ""), "a@example.com")
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET = %d, want 405", w.Code)
	}
	// Missing fields.
	w2 := httptest.NewRecorder()
	handleApprovePairJSON(w2, pairReq(http.MethodPost, "/x", "a@example.com", "email=&code="), "a@example.com")
	if w2.Code != http.StatusBadRequest {
		t.Errorf("missing fields = %d, want 400", w2.Code)
	}
	// Untrusted approver.
	w3 := httptest.NewRecorder()
	handleApprovePairJSON(w3, pairReq(http.MethodPost, "/x", "a@example.com", "email=t@example.com&code=123456"), "a@example.com")
	if w3.Code != http.StatusForbidden {
		t.Errorf("untrusted = %d, want 403", w3.Code)
	}
}

// --- recoveryHandler ----------------------------------------------------

func TestRecoveryHandler_GETForms(t *testing.T) {
	email := "recform@example.com"
	enrolTOTP(t, email)
	// Default (authenticator) tab.
	w := httptest.NewRecorder()
	recoveryHandler(w, pairReq(http.MethodGet, mfaGatePathPrefix+"/recovery", email, ""), email)
	if w.Code != http.StatusOK {
		t.Fatalf("recovery GET = %d", w.Code)
	}
	// ?mode=backup tab.
	w2 := httptest.NewRecorder()
	recoveryHandler(w2, pairReq(http.MethodGet, mfaGatePathPrefix+"/recovery?mode=backup", email, ""), email)
	if w2.Code != http.StatusOK {
		t.Fatalf("recovery backup GET = %d", w2.Code)
	}
}

func TestRecoveryHandler_TOTPSuccessAndWrong(t *testing.T) {
	email := "rectotp@example.com"
	secret := enrolTOTP(t, email)
	// Wrong code → 401.
	wWrong := httptest.NewRecorder()
	recoveryHandler(wWrong, pairReq(http.MethodPost, "/x", email, "code=000000"), email)
	if wWrong.Code != http.StatusUnauthorized {
		t.Errorf("wrong recovery code = %d, want 401", wWrong.Code)
	}
	// Right code → 303 + device cookie.
	code, _ := totp.GenerateCode(secret, time.Now())
	wOK := httptest.NewRecorder()
	recoveryHandler(wOK, pairReq(http.MethodPost, "/x", email, "code="+code), email)
	if wOK.Code != http.StatusSeeOther {
		t.Fatalf("right recovery code = %d, want 303", wOK.Code)
	}
}

func TestRecoveryHandler_BackupWrong(t *testing.T) {
	email := "recbackupwrong@example.com"
	if err := dbSaveBackupCodes(email, []string{"GOOD-0001"}); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	recoveryHandler(w, pairReq(http.MethodPost, "/x", email, "mode=backup&backup=WRONG-9999"), email)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("wrong backup = %d, want 401", w.Code)
	}
}

func TestRecoveryHandler_MethodGuard(t *testing.T) {
	email := "recmethod@example.com"
	enrolTOTP(t, email)
	w := httptest.NewRecorder()
	recoveryHandler(w, pairReq(http.MethodDelete, "/x", email, ""), email)
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("DELETE = %d, want 405", w.Code)
	}
}

// --- visiblePendingRequests + claim/approve store edges -----------------

func TestVisiblePendingRequests_FilterByApprover(t *testing.T) {
	a := "vpra@example.com"
	b := "vprb@example.com"
	_ = dbDeletePendingPairByEmail(a)
	_ = dbDeletePendingPairByEmail(b)
	if _, err := generatePendingPair(a); err != nil {
		t.Fatal(err)
	}
	if _, err := generatePendingPair(b); err != nil {
		t.Fatal(err)
	}
	// Admin sees both (at least a and b).
	admin := visiblePendingRequests("admin@example.com", true)
	var sawA, sawB bool
	for _, e := range admin {
		if e.Email == a {
			sawA = true
		}
		if e.Email == b {
			sawB = true
		}
	}
	if !sawA || !sawB {
		t.Error("admin did not see all pending requests")
	}
	// Non-admin only sees their own.
	own := visiblePendingRequests(a, false)
	for _, e := range own {
		if e.Email != a {
			t.Errorf("non-admin saw a foreign request: %s", e.Email)
		}
	}
}

func TestApproveAndClaimPendingPair_Edges(t *testing.T) {
	// approvePendingPair with a non-existent code returns nil.
	if approvePendingPair("x@example.com", "nope00", "admin@example.com", true) != nil {
		t.Error("approve with bad code returned non-nil")
	}
	// claimPendingPair before approval returns nil.
	email := "claimedge@example.com"
	if _, err := generatePendingPair(email); err != nil {
		t.Fatal(err)
	}
	if claimPendingPair(email) != nil {
		t.Error("claim before approval returned non-nil")
	}
	// After approval, claim consumes it.
	e, _ := dbLoadPendingPairByEmail(email)
	approvePendingPair(email, e.Code, "admin@example.com", false)
	if claimPendingPair(email) == nil {
		t.Error("claim after approval returned nil")
	}
	// Now gone.
	if claimPendingPair(email) != nil {
		t.Error("claim after consume returned non-nil")
	}
}

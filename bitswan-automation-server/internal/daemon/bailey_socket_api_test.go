package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Tests for the socket-side admin APIs that back the `bitswan bailey` CLI:
// device-trust approval (bailey_devices_socket_api.go + approvePendingPairByCode
// in mfa_pair.go) and endpoint access grants (bailey_access_socket_api.go).
// These handlers are plain net/http handlers on the daemon's Unix-socket mux,
// so we exercise them directly with httptest against the test bailey.db that
// TestMain provisions.

func jsonReq(method, path string, body any) *http.Request {
	var r *http.Request
	if body != nil {
		b, _ := json.Marshal(body)
		r = httptest.NewRequest(method, path, strings.NewReader(string(b)))
		r.Header.Set("Content-Type", "application/json")
	} else {
		r = httptest.NewRequest(method, path, nil)
	}
	return r
}

// --- device-trust approval -------------------------------------------------

func TestApprovePendingPairByCode(t *testing.T) {
	email := "approve-by-code@example.com"
	_ = dbDeletePendingPairByEmail(email)
	e, err := generatePendingPair(email)
	if err != nil {
		t.Fatal(err)
	}

	got := approvePendingPairByCode(e.Code, "root@example.com")
	if got == nil {
		t.Fatal("approvePendingPairByCode returned nil for a valid code")
	}
	if got.Email != email {
		t.Errorf("approved email = %q, want %q", got.Email, email)
	}

	// The pending pair must now carry the approver so the device's poll mints
	// the cookie.
	reloaded, _ := dbLoadPendingPairByCode(e.Code)
	if reloaded == nil || reloaded.ApprovedBy == "" {
		t.Error("pending pair not marked approved after approvePendingPairByCode")
	}

	// Unknown code → nil.
	if approvePendingPairByCode("000000", "root@example.com") != nil {
		t.Error("unknown code should not approve")
	}

	// Expired pending pair → nil.
	exp := &pairingEntry{
		Email:     "expired-code@example.com",
		Code:      "111111",
		IssuedAt:  time.Now().Add(-10 * time.Minute),
		ExpiresAt: time.Now().Add(-5 * time.Minute),
	}
	if err := dbUpsertPendingPair(exp); err != nil {
		t.Fatal(err)
	}
	if approvePendingPairByCode("111111", "root@example.com") != nil {
		t.Error("expired code should not approve")
	}
}

func TestHandleDeviceApprove(t *testing.T) {
	s := &Server{}
	email := "dev-approve@example.com"
	_ = dbDeletePendingPairByEmail(email)
	e, err := generatePendingPair(email)
	if err != nil {
		t.Fatal(err)
	}

	// Happy path: code only.
	w := httptest.NewRecorder()
	s.handleDeviceApprove(w, jsonReq(http.MethodPost, "/bailey/devices/approve", map[string]string{"code": e.Code}))
	if w.Code != http.StatusOK {
		t.Fatalf("approve = %d; body=%s", w.Code, w.Body.String())
	}
	var got struct {
		Approved bool   `json:"approved"`
		Email    string `json:"email"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &got)
	if !got.Approved || got.Email != email {
		t.Errorf("approve body = %+v, want approved for %s", got, email)
	}

	// Email-scoped approval that matches.
	_ = dbDeletePendingPairByEmail(email)
	e2, _ := generatePendingPair(email)
	w = httptest.NewRecorder()
	s.handleDeviceApprove(w, jsonReq(http.MethodPost, "/bailey/devices/approve",
		map[string]string{"code": e2.Code, "email": email}))
	if w.Code != http.StatusOK {
		t.Errorf("scoped approve = %d", w.Code)
	}

	// Email-scoped approval with a mismatching email → 404.
	_ = dbDeletePendingPairByEmail(email)
	e3, _ := generatePendingPair(email)
	w = httptest.NewRecorder()
	s.handleDeviceApprove(w, jsonReq(http.MethodPost, "/bailey/devices/approve",
		map[string]string{"code": e3.Code, "email": "someone-else@example.com"}))
	if w.Code != http.StatusNotFound {
		t.Errorf("mismatched-email approve = %d, want 404", w.Code)
	}

	// Missing code → 400.
	w = httptest.NewRecorder()
	s.handleDeviceApprove(w, jsonReq(http.MethodPost, "/bailey/devices/approve", map[string]string{}))
	if w.Code != http.StatusBadRequest {
		t.Errorf("missing code = %d, want 400", w.Code)
	}

	// Unknown code → 404.
	w = httptest.NewRecorder()
	s.handleDeviceApprove(w, jsonReq(http.MethodPost, "/bailey/devices/approve", map[string]string{"code": "000000"}))
	if w.Code != http.StatusNotFound {
		t.Errorf("unknown code = %d, want 404", w.Code)
	}

	// Bad body → 400.
	w = httptest.NewRecorder()
	bad := httptest.NewRequest(http.MethodPost, "/bailey/devices/approve", strings.NewReader("{not json"))
	s.handleDeviceApprove(w, bad)
	if w.Code != http.StatusBadRequest {
		t.Errorf("bad body = %d, want 400", w.Code)
	}

	// Wrong method → 405.
	w = httptest.NewRecorder()
	s.handleDeviceApprove(w, httptest.NewRequest(http.MethodGet, "/bailey/devices/approve", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET approve = %d, want 405", w.Code)
	}
}

func TestHandleDevicesPending(t *testing.T) {
	s := &Server{}
	email := "pending-list@example.com"
	_ = dbDeletePendingPairByEmail(email)
	if _, err := generatePendingPair(email); err != nil {
		t.Fatal(err)
	}

	w := httptest.NewRecorder()
	s.handleDevicesPending(w, httptest.NewRequest(http.MethodGet, "/bailey/devices/pending", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("pending = %d", w.Code)
	}
	var got struct {
		Pending []PendingDevice `json:"pending"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &got)
	var seen bool
	for _, p := range got.Pending {
		if strings.EqualFold(p.Email, email) {
			seen = true
		}
	}
	if !seen {
		t.Error("pending list did not include the new request")
	}

	// Wrong method → 405.
	w = httptest.NewRecorder()
	s.handleDevicesPending(w, httptest.NewRequest(http.MethodPost, "/bailey/devices/pending", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST pending = %d, want 405", w.Code)
	}
}

// --- endpoint access grants ------------------------------------------------

func TestHandleAccessGrantRevokeList(t *testing.T) {
	s := &Server{}
	host := "access-cli.example.com"
	owner := "owner@example.com"
	user := "grantee@example.com"
	if _, err := registerEndpoint(host, owner, "Access CLI App", "", "", ""); err != nil {
		t.Fatal(err)
	}

	// Grant (default role = access).
	w := httptest.NewRecorder()
	s.handleAccessGrant(w, jsonReq(http.MethodPost, "/bailey/access/grant",
		map[string]string{"host": host, "principal": user}))
	if w.Code != http.StatusOK {
		t.Fatalf("grant = %d; body=%s", w.Code, w.Body.String())
	}
	grants, _ := listGrants(host)
	var granted bool
	for _, g := range grants {
		if strings.EqualFold(g.PrincipalValue, user) && g.Role == roleAccess {
			granted = true
		}
	}
	if !granted {
		t.Error("grant not recorded")
	}

	// List shows the owner + grant.
	w = httptest.NewRecorder()
	s.handleAccessList(w, httptest.NewRequest(http.MethodGet, "/bailey/access/list?host="+host, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("list = %d", w.Code)
	}
	var listed struct {
		Host       string `json:"host"`
		OwnerEmail string `json:"owner_email"`
		Grants     []struct {
			PrincipalValue string `json:"principal_value"`
		} `json:"grants"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &listed)
	if listed.OwnerEmail != owner {
		t.Errorf("list owner = %q, want %q", listed.OwnerEmail, owner)
	}

	// Revoke.
	w = httptest.NewRecorder()
	s.handleAccessRevoke(w, jsonReq(http.MethodPost, "/bailey/access/revoke",
		map[string]string{"host": host, "principal": user}))
	if w.Code != http.StatusOK {
		t.Fatalf("revoke = %d", w.Code)
	}
	grants, _ = listGrants(host)
	for _, g := range grants {
		if strings.EqualFold(g.PrincipalValue, user) && g.Role == roleAccess {
			t.Error("grant still present after revoke")
		}
	}
}

func TestHandleAccessGrantErrors(t *testing.T) {
	s := &Server{}

	// Unknown endpoint → 404.
	w := httptest.NewRecorder()
	s.handleAccessGrant(w, jsonReq(http.MethodPost, "/bailey/access/grant",
		map[string]string{"host": "no-such-host.example.com", "principal": "x@example.com"}))
	if w.Code != http.StatusNotFound {
		t.Errorf("grant unknown host = %d, want 404", w.Code)
	}

	// Missing fields → 400.
	w = httptest.NewRecorder()
	s.handleAccessGrant(w, jsonReq(http.MethodPost, "/bailey/access/grant", map[string]string{"host": "h"}))
	if w.Code != http.StatusBadRequest {
		t.Errorf("grant missing principal = %d, want 400", w.Code)
	}

	// Wrong method → 405.
	w = httptest.NewRecorder()
	s.handleAccessGrant(w, httptest.NewRequest(http.MethodGet, "/bailey/access/grant", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET grant = %d, want 405", w.Code)
	}

	// List with no host param → 400.
	w = httptest.NewRecorder()
	s.handleAccessList(w, httptest.NewRequest(http.MethodGet, "/bailey/access/list", nil))
	if w.Code != http.StatusBadRequest {
		t.Errorf("list no host = %d, want 400", w.Code)
	}

	// List unknown host → 404.
	w = httptest.NewRecorder()
	s.handleAccessList(w, httptest.NewRequest(http.MethodGet, "/bailey/access/list?host=nope.example.com", nil))
	if w.Code != http.StatusNotFound {
		t.Errorf("list unknown host = %d, want 404", w.Code)
	}

	// Revoke wrong method → 405.
	w = httptest.NewRecorder()
	s.handleAccessRevoke(w, httptest.NewRequest(http.MethodGet, "/bailey/access/revoke", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET revoke = %d, want 405", w.Code)
	}
}

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

// tSockAdminTok is the admin bearer every operator-only socket handler requires
// — the mutations since #189, and the pending-device / ACL reads since #234.
// jsonReq sends it so the happy/again-error paths still reach their handlers;
// the rejection paths are covered by TestSocketPrivilegedRoutes.
const tSockAdminTok = "test-admin-token"

func jsonReq(method, path string, body any) *http.Request {
	var r *http.Request
	if body != nil {
		b, _ := json.Marshal(body)
		r = httptest.NewRequest(method, path, strings.NewReader(string(b)))
		r.Header.Set("Content-Type", "application/json")
	} else {
		r = httptest.NewRequest(method, path, nil)
	}
	r.Header.Set("Authorization", "Bearer "+tSockAdminTok)
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
	s := &Server{token: tSockAdminTok}
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
	bad.Header.Set("Authorization", "Bearer "+tSockAdminTok)
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
	s := &Server{token: tSockAdminTok}
	email := "pending-list@example.com"
	_ = dbDeletePendingPairByEmail(email)
	if _, err := generatePendingPair(email); err != nil {
		t.Fatal(err)
	}

	w := httptest.NewRecorder()
	s.handleDevicesPending(w, jsonReq(http.MethodGet, "/bailey/devices/pending", nil))
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
	s.handleDevicesPending(w, jsonReq(http.MethodPost, "/bailey/devices/pending", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST pending = %d, want 405", w.Code)
	}
}

// --- endpoint access grants ------------------------------------------------

func TestHandleAccessGrantRevokeList(t *testing.T) {
	s := &Server{token: tSockAdminTok}
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
	s.handleAccessList(w, jsonReq(http.MethodGet, "/bailey/access/list?host="+host, nil))
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
	s := &Server{token: tSockAdminTok}

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
	s.handleAccessGrant(w, jsonReq(http.MethodGet, "/bailey/access/grant", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET grant = %d, want 405", w.Code)
	}

	// List with no host param → 400.
	w = httptest.NewRecorder()
	s.handleAccessList(w, jsonReq(http.MethodGet, "/bailey/access/list", nil))
	if w.Code != http.StatusBadRequest {
		t.Errorf("list no host = %d, want 400", w.Code)
	}

	// List unknown host → 404.
	w = httptest.NewRecorder()
	s.handleAccessList(w, jsonReq(http.MethodGet, "/bailey/access/list?host=nope.example.com", nil))
	if w.Code != http.StatusNotFound {
		t.Errorf("list unknown host = %d, want 404", w.Code)
	}

	// Revoke wrong method → 405.
	w = httptest.NewRecorder()
	s.handleAccessRevoke(w, jsonReq(http.MethodGet, "/bailey/access/revoke", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET revoke = %d, want 405", w.Code)
	}
}

// privilegedRouteCase is how to drive one socketPrivilegedRoutes entry: the
// method its handler accepts, the handler itself, and a minimal request shape
// that would otherwise reach the work (so a 403 proves the gate fired, not that
// the request was malformed).
type privilegedRouteCase struct {
	method  string
	handler func(http.ResponseWriter, *http.Request)
	query   string
	body    any
}

// TestSocketPrivilegedRoutes pins the operator-only set of the Unix-socket mux
// declared as socketPrivilegedRoutes: every one of those routes must answer 403
// to a socket peer that presents no admin token (or a wrong one), even though
// authMiddleware trusts the socket transport itself.
//
// This is the shape the #226 review asked for over a blanket "every socket
// handler needs the token" invariant, which would be wrong — most routes on this
// mux are deliberately open to first-party containers
// (socketWorkspaceCallableRoutes). #189 gated the three mutations; #234 adds the
// two reads that leaked the pending approval codes and an endpoint's ACL.
func TestSocketPrivilegedRoutes(t *testing.T) {
	s := &Server{token: tSockAdminTok}

	cases := map[string]privilegedRouteCase{
		"/bailey/devices/approve": {method: http.MethodPost, handler: s.handleDeviceApprove,
			body: map[string]string{"code": "123456"}},
		"/bailey/devices/pending": {method: http.MethodGet, handler: s.handleDevicesPending},
		"/bailey/access/grant": {method: http.MethodPost, handler: s.handleAccessGrant,
			body: map[string]string{"host": "h.example.com", "principal": "x@example.com"}},
		"/bailey/access/revoke": {method: http.MethodPost, handler: s.handleAccessRevoke,
			body: map[string]string{"host": "h.example.com", "principal": "x@example.com"}},
		"/bailey/access/list": {method: http.MethodGet, handler: s.handleAccessList,
			query: "?host=h.example.com"},
	}

	// The table and the declared list must not drift: a route added to
	// socketPrivilegedRoutes without a case here would otherwise go untested.
	if len(cases) != len(socketPrivilegedRoutes) {
		t.Fatalf("cases cover %d routes, socketPrivilegedRoutes declares %d", len(cases), len(socketPrivilegedRoutes))
	}
	for _, route := range socketPrivilegedRoutes {
		if _, ok := cases[route]; !ok {
			t.Fatalf("socketPrivilegedRoutes lists %q with no case in this test", route)
		}
	}

	noAuth := func(route string, c privilegedRouteCase) *http.Request {
		if c.body == nil {
			return httptest.NewRequest(c.method, route+c.query, nil) // deliberately NO Authorization header
		}
		b, _ := json.Marshal(c.body)
		r := httptest.NewRequest(c.method, route+c.query, strings.NewReader(string(b)))
		r.Header.Set("Content-Type", "application/json")
		return r
	}

	for _, route := range socketPrivilegedRoutes {
		c := cases[route]

		w := httptest.NewRecorder()
		c.handler(w, noAuth(route, c))
		if w.Code != http.StatusForbidden {
			t.Errorf("%s without admin token = %d, want 403 (body=%s)", route, w.Code, w.Body.String())
		}

		// A wrong bearer is rejected too, not just a missing one.
		w = httptest.NewRecorder()
		r := noAuth(route, c)
		r.Header.Set("Authorization", "Bearer not-the-admin-token")
		c.handler(w, r)
		if w.Code != http.StatusForbidden {
			t.Errorf("%s with wrong token = %d, want 403", route, w.Code)
		}
	}
}

// TestSocketRouteClassesResolveOnMux checks both declared route classes against
// the mux setupRoutes actually builds, so a renamed or removed path cannot leave
// either list quietly describing a route that no longer exists.
//
// It cannot catch the opposite drift — a NEW route registered in setupRoutes and
// classified in neither list — because net/http exposes no way to enumerate a
// ServeMux's patterns. Closing that needs setupRoutes to be built from this data
// instead of alongside it (the remaining half of the #226 mux note).
func TestSocketRouteClassesResolveOnMux(t *testing.T) {
	mux := (&Server{token: tSockAdminTok}).setupRoutes()
	for _, class := range [][]string{socketPrivilegedRoutes, socketWorkspaceCallableRoutes} {
		for _, route := range class {
			_, pattern := mux.Handler(httptest.NewRequest(http.MethodGet, route, nil))
			if pattern == "" {
				t.Errorf("route %q is declared but not registered on the socket mux", route)
			}
		}
	}
}

// TestDevicesPendingDoesNotLeakCodeWhenGated is the #234 disclosure assertion
// proper: an ungated caller must not learn a live 6-digit approval code. The
// status assertion above would still pass if a future handler answered 403 with
// the list attached, and the code is the whole point of the finding.
func TestDevicesPendingDoesNotLeakCodeWhenGated(t *testing.T) {
	s := &Server{token: tSockAdminTok}
	email := "pending-leak@example.com"
	_ = dbDeletePendingPairByEmail(email)
	e, err := generatePendingPair(email)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dbDeletePendingPairByEmail(email) })

	w := httptest.NewRecorder()
	s.handleDevicesPending(w, httptest.NewRequest(http.MethodGet, "/bailey/devices/pending", nil))
	if w.Code != http.StatusForbidden {
		t.Fatalf("ungated pending = %d, want 403", w.Code)
	}
	if body := w.Body.String(); strings.Contains(body, e.Code) || strings.Contains(body, email) {
		t.Errorf("403 response disclosed the pending code or email: %s", body)
	}

	// With the token the operator still sees the code — the gate must not have
	// broken the flow it exists to protect.
	w = httptest.NewRecorder()
	s.handleDevicesPending(w, jsonReq(http.MethodGet, "/bailey/devices/pending", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("authorized pending = %d, want 200", w.Code)
	}
	if !strings.Contains(w.Body.String(), e.Code) {
		t.Error("authorized pending list is missing the code the operator needs to approve")
	}
}

// TestAccessListDoesNotLeakOwnerWhenGated is the ACL half of #234: the owner
// address and grant list are the reconnaissance value, so assert they are absent
// from the rejection and present once the token is supplied.
func TestAccessListDoesNotLeakOwnerWhenGated(t *testing.T) {
	s := &Server{token: tSockAdminTok}
	host := "acl-leak.example.com"
	owner := "acl-leak-owner@example.com"
	if _, err := registerEndpoint(host, owner, "ACL Leak App", "", "", ""); err != nil {
		t.Fatal(err)
	}

	w := httptest.NewRecorder()
	s.handleAccessList(w, httptest.NewRequest(http.MethodGet, "/bailey/access/list?host="+host, nil))
	if w.Code != http.StatusForbidden {
		t.Fatalf("ungated list = %d, want 403", w.Code)
	}
	if body := w.Body.String(); strings.Contains(body, owner) {
		t.Errorf("403 response disclosed the endpoint owner: %s", body)
	}

	w = httptest.NewRecorder()
	s.handleAccessList(w, jsonReq(http.MethodGet, "/bailey/access/list?host="+host, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("authorized list = %d, want 200", w.Code)
	}
	if !strings.Contains(w.Body.String(), owner) {
		t.Error("authorized list is missing the owner the operator asked for")
	}
}

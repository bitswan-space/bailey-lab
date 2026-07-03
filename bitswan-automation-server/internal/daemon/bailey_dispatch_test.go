package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// baileyReq builds a request as handleBailey sees it, with the
// oauth2-proxy-forwarded identity headers set (the same shape
// gateRequest/browserGet use in the sibling tests).
func baileyReq(method, path, email string, groups ...string) *http.Request {
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

// baileyForm builds a POST with a urlencoded body (devices/remove etc.
// read r.FormValue, so the body must be form-encoded).
func baileyForm(path, email string, form url.Values, groups ...string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "https://bailey.example.com"+path, strings.NewReader(form.Encode()))
	r.Host = "bailey.example.com"
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if email != "" {
		r.Header.Set("X-Forwarded-Email", email)
	}
	if len(groups) > 0 {
		r.Header.Set("X-Forwarded-Groups", strings.Join(groups, ","))
	}
	return r
}

const adminGrp = "/Example Org/admin"

// dispatch runs the real router against a zero-value Server. The routes
// under test (whoami, devices, approvals, endpoints, admin/*, and the
// GET side of workspaces) don't touch Server fields.
//
// It first makes the request look like it came from a TRUSTED device, since
// handleBailey's device-trust backstop requires one for every data endpoint.
// That lets these tests exercise their own logic (admin checks, validation,
// ACL) rather than tripping the backstop. The backstop itself is covered
// directly by TestHandleBailey_DeviceTrustBackstop; tests that need the
// untrusted path build requests without going through dispatch.
func dispatch(r *http.Request) *httptest.ResponseRecorder {
	ensureTrustedDeviceForReq(r)
	w := httptest.NewRecorder()
	(&Server{}).handleBailey(w, r)
	return w
}

// ensureTrustedDeviceForReq attaches a valid trusted-device cookie for the
// request's forwarded identity. Best-effort and idempotent: no-ops when there
// is no identity (so no-identity tests still hit the backstop / admin checks)
// or a device cookie is already present.
func ensureTrustedDeviceForReq(r *http.Request) {
	email := r.Header.Get("X-Forwarded-Email")
	if email == "" {
		return
	}
	// Admin is now a LOCAL role (user_roles), not an SSO group. Tests still
	// signal "this caller is an admin" with the admin group header, so translate
	// that into a local admin role for the test's caller.
	if g := r.Header.Get("X-Forwarded-Groups"); g != "" && isAdminGroups(strings.Split(g, ",")) {
		_ = dbSetUserRole(email, roleAdmin, "test")
	}
	// The gate/bootstrap APIs (handleGateAPI) and the public whoami run BEFORE
	// the device-trust backstop and are exactly the routes an untrusted device
	// must reach to become trusted — auto-trusting them would mask the very
	// state those tests assert. Leave them untrusted.
	switch p := r.URL.Path; {
	case p == "/bailey/api/whoami",
		p == "/bailey/api/gate-state",
		p == "/bailey/api/claim",
		p == "/bailey/api/self-trust",
		p == "/bailey/api/recover",
		p == "/bailey/api/backup-codes/regenerate",
		p == "/bailey/api/invite/redeem",
		strings.HasPrefix(p, "/bailey/api/pending-pair"),
		strings.HasPrefix(p, "/bailey/api/totp/"):
		return
	}
	if c, _ := r.Cookie(deviceCookieName); c != nil {
		return
	}
	// Reuse an existing device for this email when there is one, so we don't
	// pollute device-list/count assertions; only mint a fresh device if the
	// caller has none.
	id := ""
	if devs, _ := dbListDevices(email); len(devs) > 0 {
		id = devs[0].ID
	} else if rec, err := addDevice(email, "test-trusted-device"); err == nil {
		id = rec.ID
	} else {
		return
	}
	w0 := httptest.NewRecorder()
	if setDeviceCookie(w0, httptest.NewRequest(http.MethodGet, "https://bailey.example.com/", nil), email, id) == nil {
		for _, c := range w0.Result().Cookies() {
			r.AddCookie(c)
		}
	}
}

// --- whoami / identity --------------------------------------------------

func TestBaileyDispatch_Whoami(t *testing.T) {
	// Non-admin identity: is_admin=false, email echoed back.
	w := dispatch(baileyReq(http.MethodGet, "/bailey/api/whoami", "user@example.com"))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var got struct {
		Headers map[string]string `json:"headers"`
		IsAdmin bool              `json:"is_admin"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v\n%s", err, w.Body.String())
	}
	if got.IsAdmin {
		t.Error("non-admin reported as admin")
	}
	if got.Headers["X-Forwarded-Email"] != "user@example.com" {
		t.Errorf("whoami didn't echo forwarded email: %+v", got.Headers)
	}

	// Admin group flips is_admin true.
	w2 := dispatch(baileyReq(http.MethodGet, "/bailey/api/whoami", "boss@example.com", adminGrp))
	var got2 struct {
		IsAdmin bool `json:"is_admin"`
	}
	if err := json.Unmarshal(w2.Body.Bytes(), &got2); err != nil {
		t.Fatalf("decode admin whoami: %v", err)
	}
	if !got2.IsAdmin {
		t.Error("admin group did not set is_admin=true")
	}
}

func TestBaileyDispatch_Favicon(t *testing.T) {
	// Public to any authenticated caller; no identity header needed.
	w := dispatch(baileyReq(http.MethodGet, "/bailey/favicon.svg", ""))
	if w.Code != http.StatusOK {
		t.Fatalf("favicon status = %d, want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "image/svg+xml" {
		t.Errorf("favicon content-type = %q", ct)
	}
}

func TestBaileyDispatch_NotificationsCount(t *testing.T) {
	// notifications-count is part of the trusted console surface, so an
	// identity-less (hence un-trustable) request is rejected by the
	// device-trust backstop rather than answered with a count.
	if w := dispatch(baileyReq(http.MethodGet, "/bailey/api/notifications-count", "")); w.Code != http.StatusUnauthorized {
		t.Fatalf("no-identity status = %d, want 401", w.Code)
	}
	// A trusted, signed-in user gets a count (0 with nothing pending).
	w := dispatch(baileyReq(http.MethodGet, "/bailey/api/notifications-count", "nc-user@example.com"))
	if w.Code != http.StatusOK {
		t.Fatalf("trusted status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	var got struct {
		Count int `json:"count"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v\n%s", err, w.Body.String())
	}
	if got.Count != 0 {
		t.Errorf("trusted notifications count = %d, want 0", got.Count)
	}
}

// TestHandleBailey_DeviceTrustBackstop is the security invariant: a console
// DATA endpoint is unreachable from an UNtrusted device (no valid device
// cookie), even with a valid OAuth identity — while the same request from a
// trusted device gets through. This is what makes "untrusted device reads
// console data" architecturally impossible, independent of host or client.
func TestHandleBailey_DeviceTrustBackstop(t *testing.T) {
	writeTestConfig(t)
	email := "backstop@example.com"

	// UNtrusted: identity present, no device cookie → 401 on a data endpoint.
	rUntrusted := baileyReq(http.MethodGet, "/bailey/api/workspaces", email)
	wU := httptest.NewRecorder()
	(&Server{}).handleBailey(wU, rUntrusted)
	if wU.Code != http.StatusUnauthorized {
		t.Fatalf("untrusted data request = %d, want 401; body=%s", wU.Code, wU.Body.String())
	}

	// A gate/bootstrap API stays reachable while untrusted (it's how you
	// become trusted).
	wGate := httptest.NewRecorder()
	(&Server{}).handleBailey(wGate, baileyReq(http.MethodGet, "/bailey/api/gate-state", email))
	if wGate.Code != http.StatusOK {
		t.Fatalf("untrusted gate-state = %d, want 200", wGate.Code)
	}

	// Trusted: same data endpoint now passes the backstop.
	rTrusted := baileyReq(http.MethodGet, "/bailey/api/workspaces", email)
	ensureTrustedDeviceForReq(rTrusted)
	wT := httptest.NewRecorder()
	(&Server{}).handleBailey(wT, rTrusted)
	if wT.Code != http.StatusOK {
		t.Fatalf("trusted data request = %d, want 200; body=%s", wT.Code, wT.Body.String())
	}
}

// --- devices: list + remove round-trip ---------------------------------

func TestBaileyDevices_ListAndRemoveRoundTrip(t *testing.T) {
	email := "devices-user@example.com"
	d1, err := addDevice(email, "Laptop")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := addDevice(email, "Phone"); err != nil {
		t.Fatal(err)
	}

	// List: both devices appear under the caller's identity.
	w := dispatch(baileyReq(http.MethodGet, "/bailey/api/devices", email))
	if w.Code != http.StatusOK {
		t.Fatalf("list status = %d, want 200", w.Code)
	}
	var listed struct {
		Devices []baileyDeviceDTO `json:"devices"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode list: %v\n%s", err, w.Body.String())
	}
	if len(listed.Devices) != 2 {
		t.Fatalf("listed %d devices, want 2: %+v", len(listed.Devices), listed.Devices)
	}
	// Listing requires a trusted device (dispatch attaches one for the
	// caller), so exactly one device — the caller's current browser — is
	// flagged current.
	currents := 0
	for _, d := range listed.Devices {
		if d.IsCurrent {
			currents++
		}
		if d.Name == "" || d.PairedAt == "" {
			t.Errorf("device DTO missing fields: %+v", d)
		}
	}
	if currents != 1 {
		t.Errorf("want exactly one current device, got %d: %+v", currents, listed.Devices)
	}

	// Remove d1.
	wr := dispatch(baileyForm("/bailey/api/devices/remove", email, url.Values{"id": {d1.ID}}))
	if wr.Code != http.StatusOK {
		t.Fatalf("remove status = %d, want 200; body=%s", wr.Code, wr.Body.String())
	}
	if !strings.Contains(wr.Body.String(), `"ok":true`) {
		t.Errorf("remove body = %s", wr.Body.String())
	}

	// List again: only the phone remains.
	w2 := dispatch(baileyReq(http.MethodGet, "/bailey/api/devices", email))
	var after struct {
		Devices []baileyDeviceDTO `json:"devices"`
	}
	_ = json.Unmarshal(w2.Body.Bytes(), &after)
	if len(after.Devices) != 1 {
		t.Fatalf("after remove: %d devices, want 1", len(after.Devices))
	}
	if after.Devices[0].ID == d1.ID {
		t.Error("removed device still listed")
	}
}

func TestBaileyDevices_RemoveRequiresID(t *testing.T) {
	w := dispatch(baileyForm("/bailey/api/devices/remove", "u@example.com", url.Values{}))
	if w.Code != http.StatusBadRequest {
		t.Errorf("missing id: status = %d, want 400", w.Code)
	}
}

func TestBaileyDevices_RemoveScopedToCaller(t *testing.T) {
	// dbRemoveDevice is scoped by email; one user can't delete another's
	// device through the non-admin remove route.
	victim := "victim@example.com"
	attacker := "attacker@example.com"
	d, err := addDevice(victim, "Victim Laptop")
	if err != nil {
		t.Fatal(err)
	}
	// Attacker posts the victim's device id under their own identity.
	w := dispatch(baileyForm("/bailey/api/devices/remove", attacker, url.Values{"id": {d.ID}}))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (no-op delete)", w.Code)
	}
	devs, _ := loadDevices(victim)
	found := false
	for _, x := range devs {
		if x.ID == d.ID {
			found = true
		}
	}
	if !found {
		t.Error("attacker removed another user's device via the self-scoped route")
	}
}

// --- approvals round-trip against seeded pending_pairs -----------------

func TestBaileyApprovals_RoundTrip(t *testing.T) {
	requester := "pairing-user@example.com"
	e, err := generatePendingPair(requester)
	if err != nil {
		t.Fatal(err)
	}

	// The requester sees only their own pending pair.
	w := dispatch(baileyReq(http.MethodGet, "/bailey/api/approvals", requester))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var got struct {
		Pending []baileyApprovalDTO `json:"pending"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v\n%s", err, w.Body.String())
	}
	if len(got.Pending) == 0 {
		t.Fatal("requester sees no pending approvals")
	}
	mine := false
	for _, p := range got.Pending {
		if strings.EqualFold(p.Email, requester) {
			mine = true
		}
	}
	if !mine {
		t.Errorf("requester's own pending pair missing: %+v", got.Pending)
	}

	// A different non-admin must NOT see it (visiblePendingRequests
	// filters by approver email unless admin).
	wOther := dispatch(baileyReq(http.MethodGet, "/bailey/api/approvals", "bystander@example.com"))
	var other struct {
		Pending []baileyApprovalDTO `json:"pending"`
	}
	_ = json.Unmarshal(wOther.Body.Bytes(), &other)
	for _, p := range other.Pending {
		if strings.EqualFold(p.Email, requester) {
			t.Error("unrelated non-admin saw another user's pending pair")
		}
	}

	// An admin sees every pending pair, including this one.
	wAdmin := dispatch(baileyReq(http.MethodGet, "/bailey/api/approvals", "boss@example.com", adminGrp))
	var adm struct {
		Pending []baileyApprovalDTO `json:"pending"`
	}
	if err := json.Unmarshal(wAdmin.Body.Bytes(), &adm); err != nil {
		t.Fatal(err)
	}
	admSees := false
	for _, p := range adm.Pending {
		if strings.EqualFold(p.Email, requester) {
			admSees = true
		}
	}
	if !admSees {
		t.Errorf("admin didn't see the pending pair: %+v", adm.Pending)
	}

	// Once approved, it drops out of the visible-pending list.
	if approvePendingPair(requester, e.Code, "boss@example.com", true) == nil {
		t.Fatal("approvePendingPair returned nil")
	}
	wDone := dispatch(baileyReq(http.MethodGet, "/bailey/api/approvals", "boss@example.com", adminGrp))
	var done struct {
		Pending []baileyApprovalDTO `json:"pending"`
	}
	_ = json.Unmarshal(wDone.Body.Bytes(), &done)
	for _, p := range done.Pending {
		if strings.EqualFold(p.Email, requester) {
			t.Error("approved pair still showing as pending")
		}
	}
}

// --- endpoints listing (DB-backed, any signed-in user) -----------------

func TestBaileyDispatch_EndpointsListing(t *testing.T) {
	host := "dispatch-endpoints.example.com"
	if _, err := registerEndpoint(host, "epowner@example.com", "My App", "", "", ""); err != nil {
		t.Fatal(err)
	}
	w := dispatch(baileyReq(http.MethodGet, "/bailey/api/endpoints", "epowner@example.com"))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("content-type = %q", ct)
	}
	var got struct {
		CallerEmail string `json:"caller_email"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v\n%s", err, w.Body.String())
	}
	if got.CallerEmail != "epowner@example.com" {
		t.Errorf("caller_email = %q", got.CallerEmail)
	}
}

func TestBaileyDispatch_EndpointsRejectsPost(t *testing.T) {
	w := dispatch(baileyReq(http.MethodPost, "/bailey/api/endpoints", "u@example.com"))
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /endpoints: status = %d, want 405", w.Code)
	}
}

// --- workspaces GET (empty list in the test env) -----------------------

func TestBaileyDispatch_WorkspacesGet(t *testing.T) {
	// No workspaces dir under the temp HOME → GetWorkspaceList returns an
	// empty (non-error) list, so the route should 200 with valid JSON.
	w := dispatch(baileyReq(http.MethodGet, "/bailey/api/workspaces", "u@example.com"))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	var got struct {
		CallerEmail string `json:"caller_email"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v\n%s", err, w.Body.String())
	}
	if got.CallerEmail != "u@example.com" {
		t.Errorf("caller_email = %q", got.CallerEmail)
	}
}

// --- admin gate: every /bailey/api/admin/* route -----------------------

// adminRoutes are the admin-only routes whose happy path is GET and
// works against the seeded temp DB with no external dependencies.
var adminRoutes = []struct {
	name string
	path string
}{
	{"admin devices", "/bailey/api/admin/devices"},
	{"admin network-map", "/bailey/api/admin/network-map"},
}

func TestBaileyAdmin_NonAdminGets403(t *testing.T) {
	for _, rt := range adminRoutes {
		t.Run(rt.name, func(t *testing.T) {
			w := dispatch(baileyReq(http.MethodGet, rt.path, "user@example.com"))
			if w.Code != http.StatusForbidden {
				t.Errorf("%s as non-admin: status = %d, want 403", rt.path, w.Code)
			}
			if !strings.Contains(w.Body.String(), "admin only") {
				t.Errorf("%s 403 body = %s", rt.path, w.Body.String())
			}
		})
	}
}

func TestBaileyAdmin_NoIdentityGets403(t *testing.T) {
	// No forwarded identity → it can't be a trusted device, so the
	// device-trust backstop rejects it with 401 before any admin check.
	w := dispatch(baileyReq(http.MethodGet, "/bailey/api/admin/devices", ""))
	if w.Code != http.StatusUnauthorized {
		t.Errorf("no-identity admin route: status = %d, want 401", w.Code)
	}
}

func TestBaileyAdmin_AdminGets200(t *testing.T) {
	for _, rt := range adminRoutes {
		t.Run(rt.name, func(t *testing.T) {
			w := dispatch(baileyReq(http.MethodGet, rt.path, "boss@example.com", adminGrp))
			if w.Code != http.StatusOK {
				t.Fatalf("%s as admin: status = %d, want 200; body=%s", rt.path, w.Code, w.Body.String())
			}
			// All these admin GETs return JSON.
			var v any
			if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
				t.Errorf("%s admin body not JSON: %v\n%s", rt.path, err, w.Body.String())
			}
		})
	}
}

func TestBaileyAdmin_DevicesResponseShape(t *testing.T) {
	// Seed a device so the grouped admin response has a user row.
	seedEmail := "admin-listed@example.com"
	if _, err := addDevice(seedEmail, "Workstation"); err != nil {
		t.Fatal(err)
	}
	w := dispatch(baileyReq(http.MethodGet, "/bailey/api/admin/devices", "boss@example.com", adminGrp))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	var resp adminDevicesResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v\n%s", err, w.Body.String())
	}
	found := false
	for _, u := range resp.Users {
		if strings.EqualFold(u.Email, seedEmail) {
			found = true
			if len(u.Devices) == 0 {
				t.Error("seeded user row has no devices")
			}
		}
	}
	if !found {
		t.Errorf("seeded device's user not in admin listing: %+v", resp.Users)
	}
}

func TestBaileyAdmin_DeviceRemove(t *testing.T) {
	// Admin can remove any user's device via the admin remove route.
	owner := "admin-remove-target@example.com"
	d, err := addDevice(owner, "Tablet")
	if err != nil {
		t.Fatal(err)
	}

	// Non-admin is blocked before the handler runs.
	wDeny := dispatch(baileyForm("/bailey/api/admin/devices/remove", "nobody@example.com",
		url.Values{"email": {owner}, "id": {d.ID}}))
	if wDeny.Code != http.StatusForbidden {
		t.Fatalf("non-admin remove: status = %d, want 403", wDeny.Code)
	}

	// Admin remove succeeds.
	w := dispatch(baileyForm("/bailey/api/admin/devices/remove", "boss@example.com",
		url.Values{"email": {owner}, "id": {d.ID}}, adminGrp))
	if w.Code != http.StatusOK {
		t.Fatalf("admin remove: status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"ok":true`) {
		t.Errorf("admin remove body = %s", w.Body.String())
	}
	devs, _ := loadDevices(owner)
	for _, x := range devs {
		if x.ID == d.ID {
			t.Error("admin remove didn't delete the device")
		}
	}
}

func TestBaileyAdmin_DeviceRemoveRequiresEmailAndID(t *testing.T) {
	w := dispatch(baileyForm("/bailey/api/admin/devices/remove", "boss@example.com",
		url.Values{"id": {"abc"}}, adminGrp))
	if w.Code != http.StatusBadRequest {
		t.Errorf("missing email: status = %d, want 400", w.Code)
	}
}

func TestBaileyAdmin_UnknownAdminRouteIs404(t *testing.T) {
	// Past the admin gate, an unrouted admin path is NotFound (proves the
	// admin gate ran before the final NotFound, not a generic 403).
	w := dispatch(baileyReq(http.MethodGet, "/bailey/api/admin/does-not-exist", "boss@example.com", adminGrp))
	if w.Code != http.StatusNotFound {
		t.Errorf("unknown admin route as admin: status = %d, want 404", w.Code)
	}
}

func TestBaileyAdmin_NetworkMapStaticTopology(t *testing.T) {
	// buildNetworkMap always emits the static cloud + ingress chain even
	// without docker, so this exercises the real admin handler end to end.
	w := dispatch(baileyReq(http.MethodGet, "/bailey/api/admin/network-map", "boss@example.com", adminGrp))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var g nmGraph
	if err := json.Unmarshal(w.Body.Bytes(), &g); err != nil {
		t.Fatalf("decode: %v\n%s", err, w.Body.String())
	}
	hasCloud := false
	for _, n := range g.Nodes {
		if n.ID == "cloud" {
			hasCloud = true
		}
	}
	if !hasCloud {
		t.Errorf("network map missing the static cloud node: %+v", g.Nodes)
	}
}

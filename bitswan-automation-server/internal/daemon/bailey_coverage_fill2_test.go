package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// --- bailey_devices_api.go ---------------------------------------------

func TestDevicesAPI_List(t *testing.T) {
	email := "dapi@example.com"
	if _, err := addDevice(email, "D1"); err != nil {
		t.Fatal(err)
	}
	w := dispatch(baileyReq(http.MethodGet, "/bailey/api/devices", email))
	if w.Code != http.StatusOK {
		t.Fatalf("devices list = %d", w.Code)
	}
	var got struct {
		Devices []baileyDeviceDTO `json:"devices"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Devices) < 1 {
		t.Error("no devices returned")
	}
}

func TestDevicesAPI_Remove(t *testing.T) {
	email := "dapirem@example.com"
	rec, err := addDevice(email, "RM")
	if err != nil {
		t.Fatal(err)
	}
	r := baileyForm("/bailey/api/devices/remove", email, parseFormVals("id="+rec.ID))
	w := dispatch(r)
	if w.Code != http.StatusOK {
		t.Fatalf("remove = %d; body=%s", w.Code, w.Body.String())
	}
	if got, _ := findDevice(email, rec.ID); got != nil {
		t.Error("device not removed")
	}
}

func TestDevicesAPI_RemoveMissingID(t *testing.T) {
	r := baileyForm("/bailey/api/devices/remove", "u@example.com", parseFormVals("id="))
	w := dispatch(r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("remove no id = %d, want 400", w.Code)
	}
}

func TestApprovalsAPI(t *testing.T) {
	email := "approvalsapi@example.com"
	_ = dbDeletePendingPairByEmail(email)
	if _, err := generatePendingPair(email); err != nil {
		t.Fatal(err)
	}
	// The user sees their own pending approval.
	w := dispatch(baileyReq(http.MethodGet, "/bailey/api/approvals", email))
	if w.Code != http.StatusOK {
		t.Fatalf("approvals = %d", w.Code)
	}
	var got struct {
		Pending []baileyApprovalDTO `json:"pending"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &got)
	var seen bool
	for _, p := range got.Pending {
		if strings.EqualFold(p.Email, email) {
			seen = true
		}
	}
	if !seen {
		t.Error("own pending approval not listed")
	}
}

// --- bailey_gate_api.go: enroll GET + backup regenerate success ---------

func TestGateAPI_EnrollConflictWhenEnrolled(t *testing.T) {
	markServerClaimed(t)
	email := "enrollconflict@example.com"
	if err := dbSaveTOTP(&totpRecord{Email: email, Secret: "S", CreatedAt: nowRFC3339()}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dbDeleteTOTP(email) })
	w := dispatch(gateAPIReq(http.MethodGet, "/bailey/api/totp/enroll", email))
	if w.Code != http.StatusConflict {
		t.Errorf("enroll when enrolled = %d, want 409", w.Code)
	}
}

func TestGateAPI_BackupRegenerateNoIdentity(t *testing.T) {
	markServerClaimed(t)
	w := dispatch(gateAPIJSON(http.MethodPost, "/bailey/api/backup-codes/regenerate", "", "{}"))
	if w.Code != http.StatusUnauthorized {
		t.Errorf("regenerate no identity = %d, want 401", w.Code)
	}
}

func TestGateAPI_EnrollReusesCandidateCookie(t *testing.T) {
	markServerClaimed(t)
	email := "enrollreuse@example.com"
	_ = dbDeleteTOTP(email)
	// First enroll mints a candidate cookie + secret.
	w1 := dispatch(gateAPIReq(http.MethodGet, "/bailey/api/totp/enroll", email))
	var en1 struct {
		Secret string `json:"secret"`
	}
	_ = json.Unmarshal(w1.Body.Bytes(), &en1)
	var cookie *http.Cookie
	for _, c := range w1.Result().Cookies() {
		if c.Name == gateEnrolCookieName {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatal("no candidate cookie")
	}
	// Second enroll with the cookie reuses the same secret.
	r2 := gateAPIReq(http.MethodGet, "/bailey/api/totp/enroll", email)
	r2.AddCookie(cookie)
	w2 := httptest.NewRecorder()
	(&Server{}).handleBailey(w2, r2)
	var en2 struct {
		Secret string `json:"secret"`
	}
	_ = json.Unmarshal(w2.Body.Bytes(), &en2)
	if en2.Secret != en1.Secret {
		t.Errorf("candidate secret not reused: %q vs %q", en1.Secret, en2.Secret)
	}
}

// --- acl_endpoints_page.go: server-owner viewer path -------------------

func TestEndpoints_ServerOwnerSeesViewerRows(t *testing.T) {
	domain := writeTestConfig(t)
	host := "bailey." + domain
	// Make srvowner the bailey-admin endpoint owner → server owner.
	if err := deleteEndpoint(host); err != nil {
		t.Fatal(err)
	}
	if _, err := registerEndpoint(host, "srvowner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	// A third-party endpoint the server owner has no direct role on.
	other := "viewer-target.example.com"
	if _, err := registerEndpoint(other, "thirdparty@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	r := baileyReq(http.MethodGet, "/bailey/api/endpoints", "srvowner@example.com")
	r.Host = host
	w := httptest.NewRecorder()
	(&Server{}).handleBailey(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("endpoints = %d; body=%s", w.Code, w.Body.String())
	}
	var listing endpointListing
	if err := json.Unmarshal(w.Body.Bytes(), &listing); err != nil {
		t.Fatal(err)
	}
	if !listing.IsServerOwner {
		t.Fatal("caller not recognised as server owner")
	}
	var sawViewer bool
	for _, e := range listing.Endpoints {
		if strings.EqualFold(e.Hostname, other) && e.CallerRole == "viewer" {
			sawViewer = true
		}
	}
	if !sawViewer {
		t.Error("server owner did not get a viewer row for a third-party endpoint")
	}
}

// --- bailey_admin_helpers.go: signoutRedirect --------------------------

func TestSignoutRedirect(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "https://bailey.example.com/bailey/signout", nil)
	r.Host = "bailey.example.com"
	w := httptest.NewRecorder()
	signoutRedirect(w, r, "/")
	if w.Code != http.StatusFound {
		t.Fatalf("signout status = %d, want 302", w.Code)
	}
	loc := w.Header().Get("Location")
	if !strings.Contains(loc, "/oauth2/sign_out") {
		t.Errorf("signout Location = %q", loc)
	}
}

func TestSignoutRedirect_RoutedThroughDispatch(t *testing.T) {
	w := dispatch(baileyReq(http.MethodGet, "/bailey/signout", "u@example.com"))
	if w.Code != http.StatusFound {
		t.Errorf("dispatched signout = %d, want 302", w.Code)
	}
}

// --- bailey_network_map.go: graph with a registered endpoint -----------

func TestNetworkMap_GraphIncludesRegisteredEndpoint(t *testing.T) {
	domain := writeTestConfig(t)
	host := "nm-app-gitops." + domain
	if _, err := registerEndpoint(host, "nmowner@example.com", "NM App", "", endpointKindWorkspace, "production"); err != nil {
		t.Fatal(err)
	}
	g := buildNetworkMap()
	if len(g.Nodes) == 0 {
		t.Fatal("empty graph")
	}
	// The registered endpoint should surface as a node somewhere.
	var sawHost bool
	for _, n := range g.Nodes {
		if strings.EqualFold(n.Hostname, host) || strings.Contains(n.Label, "NM App") {
			sawHost = true
		}
	}
	if !sawHost {
		t.Logf("graph nodes: %+v", g.Nodes)
		t.Error("registered endpoint not represented in network map")
	}
}

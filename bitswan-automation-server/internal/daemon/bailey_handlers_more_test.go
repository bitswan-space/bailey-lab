package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// dispatchSrv runs the real router against a Server with version/startTime
// set, so handlers that read those fields (overview) work.
func dispatchSrv(r *http.Request) *httptest.ResponseRecorder {
	ensureTrustedDeviceForReq(r)
	w := httptest.NewRecorder()
	(&Server{version: "test-1.2.3", startTime: time.Now().Add(-time.Minute)}).handleBailey(w, r)
	return w
}

// --- bailey_overview.go -------------------------------------------------

func TestOverview_AdminOnly(t *testing.T) {
	// Non-admin is 403'd by the dispatcher.
	w := dispatch(baileyReq(http.MethodGet, "/bailey/api/overview", "user@example.com"))
	if w.Code != http.StatusForbidden {
		t.Fatalf("non-admin overview = %d, want 403", w.Code)
	}
}

func TestOverview_AdminGetsCountsIdentityActivity(t *testing.T) {
	writeTestConfig(t)
	markServerClaimed(t)
	// Seed at least one device + one audit event so the feed is non-empty.
	if _, err := addDevice("ovuser@example.com", "ov-dev"); err != nil {
		t.Fatal(err)
	}
	w := dispatchSrv(baileyReq(http.MethodGet, "/bailey/api/overview", "boss@example.com", adminGrp))
	if w.Code != http.StatusOK {
		t.Fatalf("overview status = %d; body=%s", w.Code, w.Body.String())
	}
	var resp overviewResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v\n%s", err, w.Body.String())
	}
	if resp.Identity.Version != "test-1.2.3" {
		t.Errorf("version = %q", resp.Identity.Version)
	}
	if !resp.Identity.Online {
		t.Error("online = false")
	}
	if resp.Identity.UptimeSec < 0 {
		t.Error("uptime negative")
	}
	if resp.Counts.TrustedDevices < 1 {
		t.Error("trusted device count not reflecting seeded device")
	}
}

func TestServerRegion_FromEnv(t *testing.T) {
	t.Setenv("BITSWAN_REGION", "eu-west")
	if serverRegion() != "eu-west" {
		t.Error("serverRegion did not read env")
	}
}

func TestConfiguredProtectedDomain(t *testing.T) {
	domain := writeTestConfig(t)
	if configuredProtectedDomain() != domain {
		t.Errorf("configuredProtectedDomain = %q, want %q", configuredProtectedDomain(), domain)
	}
}

// --- bailey_people.go ---------------------------------------------------

func TestPeople_AdminOnly(t *testing.T) {
	w := dispatch(baileyReq(http.MethodGet, "/bailey/api/people", "user@example.com"))
	if w.Code != http.StatusForbidden {
		t.Fatalf("non-admin people = %d, want 403", w.Code)
	}
}

func TestPeople_RosterIncludesRootAndDeviceOwners(t *testing.T) {
	writeTestConfig(t)
	// Make root@example.com the recorded root admin.
	if err := dbSetSetting(settingRootAdmin, "root@example.com", "root@example.com"); err != nil {
		t.Fatal(err)
	}
	if _, err := addDevice("peopledev@example.com", "p-dev"); err != nil {
		t.Fatal(err)
	}
	w := dispatchSrv(baileyReq(http.MethodGet, "/bailey/api/people", "boss@example.com", adminGrp))
	if w.Code != http.StatusOK {
		t.Fatalf("people status = %d; body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		People []personDTO `json:"people"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	byEmail := map[string]personDTO{}
	for _, p := range resp.People {
		byEmail[strings.ToLower(p.Email)] = p
	}
	root, ok := byEmail["root@example.com"]
	if !ok {
		t.Fatal("root admin not in roster")
	}
	if root.Role != roleAdmin {
		t.Errorf("root role = %q, want admin", root.Role)
	}
	dev, ok := byEmail["peopledev@example.com"]
	if !ok {
		t.Fatal("device owner not in roster")
	}
	if dev.Role != roleMember {
		t.Errorf("device owner role = %q, want member", dev.Role)
	}
	if dev.Devices < 1 {
		t.Error("device count not joined")
	}
}

func TestPeople_InviteRejectsEmptyBody(t *testing.T) {
	// The invite endpoint is implemented (bailey_people_invites.go; full
	// coverage in bailey_invites_test.go) — a bodyless POST is a 400, not
	// the old 501 stub.
	w := dispatchSrv(baileyReq(http.MethodPost, "/bailey/api/people/invite", "boss@example.com", adminGrp))
	if w.Code != http.StatusBadRequest {
		t.Errorf("invite with no body = %d, want 400", w.Code)
	}
}

func TestGatherPeople_DirectIncludesTOTPEnrollee(t *testing.T) {
	writeTestConfig(t)
	email := "totpperson@example.com"
	if err := dbSaveTOTP(&totpRecord{Email: email, Secret: "S", CreatedAt: nowRFC3339()}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dbDeleteTOTP(email) })
	people, _ := gatherPeople(baileyReq(http.MethodGet, "/bailey/api/people", "boss@example.com", adminGrp))
	var found bool
	for _, p := range people {
		if strings.EqualFold(p.Email, email) {
			found = true
		}
	}
	if !found {
		t.Error("TOTP enrollee not surfaced in roster")
	}
}

// --- acl_endpoints_page.go ----------------------------------------------

func TestEndpoints_CallerSeesOwnEndpoint(t *testing.T) {
	writeTestConfig(t)
	owner := "ep-owner@example.com"
	host := "ep-list-test.example.com"
	if _, err := registerEndpoint(host, owner, "Ep Display", "", "", ""); err != nil {
		t.Fatal(err)
	}
	// Add an explicit grant so the owner view's grants slice is populated.
	if err := addGrant(host, "email", "teammate@example.com", string(roleAccess), owner); err != nil {
		t.Fatal(err)
	}
	w := dispatch(baileyReq(http.MethodGet, "/bailey/api/endpoints", owner))
	if w.Code != http.StatusOK {
		t.Fatalf("endpoints status = %d; body=%s", w.Code, w.Body.String())
	}
	var listing endpointListing
	if err := json.Unmarshal(w.Body.Bytes(), &listing); err != nil {
		t.Fatal(err)
	}
	var entry *endpointListEntry
	for i := range listing.Endpoints {
		if strings.EqualFold(listing.Endpoints[i].Hostname, host) {
			entry = &listing.Endpoints[i]
		}
	}
	if entry == nil {
		t.Fatalf("own endpoint not listed: %+v", listing.Endpoints)
	}
	if entry.CallerRole != "owner" {
		t.Errorf("caller role = %q, want owner", entry.CallerRole)
	}
	if len(entry.Grants) == 0 {
		t.Error("owner view should include grants")
	}
}

// The listing carries the grouping data clients use to render endpoints
// under their workspace / business process (#280): parent_endpoint and
// business_process straight from the endpoint row, and workspace resolved
// from the parent dashboard host (or the row's own host for dashboards).
func TestEndpoints_CarriesWorkspaceGrouping(t *testing.T) {
	domain := writeTestConfig(t)
	owner := "group-owner@example.com"
	const wsName = "groupws"
	// A workspace is a directory under ~/.config/bitswan/workspaces; without
	// metadata the dashboard host resolves to the conventional
	// <name>-dashboard.<domain>.
	wsDir := filepath.Join(os.Getenv("HOME"), ".config", "bitswan", "workspaces", wsName)
	if err := os.MkdirAll(wsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(wsDir) })

	dashHost := wsName + "-dashboard." + domain
	appHost := wsName + "-fio-frontend." + domain
	if _, err := registerEndpoint(dashHost, owner, wsName+" (dashboard)", "", endpointKindWorkspace, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := registerEndpoint(appHost, owner, "Fio frontend", dashHost, endpointKindFrontend, "live-dev"); err != nil {
		t.Fatal(err)
	}
	if err := setEndpointSourceBP(appHost, "gitops", "fio"); err != nil {
		t.Fatal(err)
	}

	listing, err := buildEndpointListing(owner, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	byHost := map[string]endpointListEntry{}
	for _, e := range listing.Endpoints {
		byHost[strings.ToLower(e.Hostname)] = e
	}
	app, ok := byHost[strings.ToLower(appHost)]
	if !ok {
		t.Fatalf("frontend endpoint not listed: %+v", listing.Endpoints)
	}
	if app.ParentEndpoint != dashHost {
		t.Errorf("parent_endpoint = %q, want %q", app.ParentEndpoint, dashHost)
	}
	if app.Workspace != wsName {
		t.Errorf("workspace = %q, want %q", app.Workspace, wsName)
	}
	if app.BusinessProcess != "fio" {
		t.Errorf("business_process = %q, want fio", app.BusinessProcess)
	}
	dash, ok := byHost[strings.ToLower(dashHost)]
	if !ok {
		t.Fatalf("dashboard endpoint not listed: %+v", listing.Endpoints)
	}
	if dash.Workspace != wsName {
		t.Errorf("dashboard workspace = %q, want %q", dash.Workspace, wsName)
	}
}

func TestEndpoints_UnrelatedCallerDoesNotSeeIt(t *testing.T) {
	writeTestConfig(t)
	host := "ep-private-test.example.com"
	if _, err := registerEndpoint(host, "secret-owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	w := dispatch(baileyReq(http.MethodGet, "/bailey/api/endpoints", "stranger@example.com"))
	var listing endpointListing
	_ = json.Unmarshal(w.Body.Bytes(), &listing)
	for _, e := range listing.Endpoints {
		if strings.EqualFold(e.Hostname, host) {
			t.Error("stranger saw an endpoint they have no role on")
		}
	}
}

func TestEndpoints_MethodGuard(t *testing.T) {
	w := dispatch(baileyReq(http.MethodPost, "/bailey/api/endpoints", "u@example.com"))
	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST endpoints = %d, want 405", w.Code)
	}
}

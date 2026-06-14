package daemon

import (
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
)

// Focused, hermetic coverage for cheap pure/helper funcs on the new
// stage-2/3 files. These exercise branches the existing suites don't, to
// keep the new-file aggregate comfortably above the CI gate. None of these
// touch docker or the network.

// --- bailey_dispatch.go: isBaileyDataPath ------------------------------

func TestIsBaileyDataPath(t *testing.T) {
	cases := []struct {
		path string
		want bool
	}{
		{"/bailey/api/whoami", true},
		{"/bailey/static/app.js", true},
		{"/bailey/favicon.svg", true},
		{"/bailey/signout", true},
		{gatePathPrefix + "/recovery", true},
		// Non-data paths fall through to the SPA index.html.
		{"/bailey/", false},
		{"/bailey/overview", false},
		{"/", false},
		{"/some/app/path", false},
		{"/bailey/favicon.svgX", false},
	}
	for _, c := range cases {
		if got := isBaileyDataPath(c.path); got != c.want {
			t.Errorf("isBaileyDataPath(%q) = %v, want %v", c.path, got, c.want)
		}
	}
}

// --- bailey_admin_helpers.go: signoutRedirect --------------------------

func TestSignoutRedirect_NoOauthConfig(t *testing.T) {
	// With no oauth config for the bailey client, signout falls back to the
	// local oauth2-proxy sign_out endpoint (no Keycloak end-session URL).
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SUDO_USER", "")
	r := httptest.NewRequest(http.MethodGet, "https://bailey.example.com/bailey/signout", nil)
	r.Host = "bailey.example.com"
	w := httptest.NewRecorder()
	signoutRedirect(w, r, "/")
	if w.Code != http.StatusFound {
		t.Fatalf("signoutRedirect status = %d, want 302", w.Code)
	}
	loc := w.Header().Get("Location")
	if loc != "/oauth2/sign_out" {
		t.Errorf("signoutRedirect Location = %q, want /oauth2/sign_out", loc)
	}
}

// handleBailey dispatches /bailey/signout through signoutRedirect, and
// /bailey/favicon.svg to the inline SVG — both reachable without admin.
func TestHandleBailey_FaviconAndSignout(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SUDO_USER", "")
	srv := &Server{}

	// Favicon.
	rf := httptest.NewRequest(http.MethodGet, "https://bailey.example.com/bailey/favicon.svg", nil)
	rf.Host = "bailey.example.com"
	wf := httptest.NewRecorder()
	srv.handleBailey(wf, rf)
	if wf.Code != http.StatusOK {
		t.Errorf("favicon status = %d", wf.Code)
	}
	if ct := wf.Header().Get("Content-Type"); ct != "image/svg+xml" {
		t.Errorf("favicon content-type = %q", ct)
	}

	// Signout.
	rs := httptest.NewRequest(http.MethodGet, "https://bailey.example.com/bailey/signout", nil)
	rs.Host = "bailey.example.com"
	rs.Header.Set("X-Forwarded-Email", "user@example.com")
	ws := httptest.NewRecorder()
	srv.handleBailey(ws, rs)
	if ws.Code != http.StatusFound {
		t.Errorf("signout status = %d, want 302", ws.Code)
	}
}

// A non-admin caller hitting an admin-only route gets 403 from handleBailey.
func TestHandleBailey_AdminRouteForbiddenForNonAdmin(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SUDO_USER", "")
	r := httptest.NewRequest(http.MethodGet, "https://bailey.example.com/bailey/api/overview", nil)
	r.Host = "bailey.example.com"
	r.Header.Set("X-Forwarded-Email", "nobody@example.com")
	w := httptest.NewRecorder()
	(&Server{}).handleBailey(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("admin route as non-admin = %d, want 403; body=%s", w.Code, w.Body.String())
	}
}

// --- bailey_overview.go: configuredProtectedDomain (no-config branch) --

func TestConfiguredProtectedDomain_NoConfig(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SUDO_USER", "")
	if d := configuredProtectedDomain(); d != "" {
		t.Errorf("configuredProtectedDomain with no config = %q, want empty", d)
	}
}

// --- mfa_pair.go: originRedirectPath -----------------------------------

func TestOriginRedirectPath(t *testing.T) {
	// No origin cookie → "/".
	r1 := httptest.NewRequest(http.MethodGet, "https://app.example.com/x", nil)
	if got := originRedirectPath(r1); got != "/" {
		t.Errorf("originRedirectPath no-cookie = %q, want /", got)
	}
	// Safe same-origin path is preserved.
	r2 := httptest.NewRequest(http.MethodGet, "https://app.example.com/x", nil)
	r2.AddCookie(&http.Cookie{Name: gateOriginCookie, Value: "/deep/link?a=1"})
	if got := originRedirectPath(r2); got != "/deep/link?a=1" {
		t.Errorf("originRedirectPath safe = %q", got)
	}
	// Open-redirect attempt is neutralised to "/".
	r3 := httptest.NewRequest(http.MethodGet, "https://app.example.com/x", nil)
	r3.AddCookie(&http.Cookie{Name: gateOriginCookie, Value: "//evil.example.com/"})
	if got := originRedirectPath(r3); got != "/" {
		t.Errorf("originRedirectPath open-redirect = %q, want /", got)
	}
}

// --- mfa_pair.go: hiddenIf / autofocusIf -------------------------------

func TestHiddenIfAutofocusIf(t *testing.T) {
	if hiddenIf(true) == "" || hiddenIf(false) != "" {
		t.Errorf("hiddenIf branches wrong: true=%q false=%q", hiddenIf(true), hiddenIf(false))
	}
	if autofocusIf(true) == "" || autofocusIf(false) != "" {
		t.Errorf("autofocusIf branches wrong: true=%q false=%q", autofocusIf(true), autofocusIf(false))
	}
}

// --- mfa_gate.go: originForHost ----------------------------------------

func TestOriginForHost(t *testing.T) {
	// HTTPS via TLS.
	r := httptest.NewRequest(http.MethodGet, "https://app.example.com/x", nil)
	r.Host = "app.example.com"
	if got := originForHost(r); !strings.HasPrefix(got, "https://") {
		t.Errorf("originForHost (tls) = %q, want https scheme", got)
	}
	// Plain HTTP: no TLS, no forwarded-proto.
	r2 := httptest.NewRequest(http.MethodGet, "http://app.example.com/x", nil)
	r2.TLS = nil
	r2.Host = "app.example.com"
	if got := originForHost(r2); !strings.HasPrefix(got, "http://") {
		t.Errorf("originForHost (http) = %q, want http scheme", got)
	}
	// Forwarded-proto https on a non-TLS conn.
	r3 := httptest.NewRequest(http.MethodGet, "http://app.example.com/x", nil)
	r3.TLS = nil
	r3.Host = "app.example.com"
	r3.Header.Set("X-Forwarded-Proto", "https")
	if got := originForHost(r3); !strings.HasPrefix(got, "https://") {
		t.Errorf("originForHost (fwd-proto) = %q, want https scheme", got)
	}
}

// --- acl_endpoints_page.go: serverBaileyAdminHost / callerIsServerOwner -

func TestServerBaileyAdminHost(t *testing.T) {
	// Request addressed to a bailey.* host wins.
	domain := writeTestConfig(t)
	r := httptest.NewRequest(http.MethodGet, "https://bailey."+domain+"/bailey/api/overview", nil)
	r.Host = "bailey." + domain
	if got := serverBaileyAdminHost(r); got != "bailey."+domain {
		t.Errorf("serverBaileyAdminHost (request) = %q", got)
	}
	// Non-bailey request host → falls back to the configured domain.
	r2 := httptest.NewRequest(http.MethodGet, "https://app."+domain+"/x", nil)
	r2.Host = "app." + domain
	if got := serverBaileyAdminHost(r2); got != "bailey."+domain {
		t.Errorf("serverBaileyAdminHost (fallback) = %q", got)
	}
	// nil request still resolves from config.
	if got := serverBaileyAdminHost(nil); got != "bailey."+domain {
		t.Errorf("serverBaileyAdminHost (nil) = %q", got)
	}
}

func TestServerBaileyAdminHost_NoConfig(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SUDO_USER", "")
	r := httptest.NewRequest(http.MethodGet, "https://app.example.com/x", nil)
	r.Host = "app.example.com"
	if got := serverBaileyAdminHost(r); got != "" {
		t.Errorf("serverBaileyAdminHost no-config = %q, want empty", got)
	}
}

func TestCallerIsServerOwner_NoHost(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SUDO_USER", "")
	// No config + non-bailey host → serverBaileyAdminHost == "" → not owner.
	r := httptest.NewRequest(http.MethodGet, "https://app.example.com/x", nil)
	r.Host = "app.example.com"
	ok, err := callerIsServerOwner("anyone@example.com", r)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Error("callerIsServerOwner with no admin host should be false")
	}
}

// callerIsServerOwner returns (false, nil) when the bailey-admin endpoint
// isn't registered (sql.ErrNoRows path).
func TestCallerIsServerOwner_EndpointMissing(t *testing.T) {
	domain := writeTestConfig(t)
	host := "bailey." + domain
	r := httptest.NewRequest(http.MethodGet, "https://"+host+"/x", nil)
	r.Host = host
	ok, err := callerIsServerOwner("nobody@example.com", r)
	if err != nil {
		t.Fatalf("unexpected error for missing endpoint: %v", err)
	}
	if ok {
		t.Error("missing endpoint should not yield server owner")
	}
}

// --- bailey_network_map.go: buildNetworkMap base topology --------------

func TestBuildNetworkMap_BaseTopology(t *testing.T) {
	g := buildNetworkMap()
	// The fixed ingress/auth-chain skeleton is always present regardless of
	// docker state.
	wantNodes := map[string]bool{
		"cloud":                           false,
		"ingress:platform-traefik":        false,
		"ingress:bitswan-protected-proxy": false,
		"ingress:bailey-proxy":            false,
		"daemon:automation-server":        false,
	}
	for _, n := range g.Nodes {
		if _, ok := wantNodes[n.ID]; ok {
			wantNodes[n.ID] = true
		}
	}
	for id, seen := range wantNodes {
		if !seen {
			t.Errorf("buildNetworkMap missing base node %q", id)
		}
	}
	if len(g.Edges) < 4 {
		t.Errorf("buildNetworkMap base edges = %d, want >= 4", len(g.Edges))
	}
}

// TestBuildNetworkMap_WithWorkspaceTopology drives the docker-backed and
// ACL-backed sections of buildNetworkMap: a real workspace-stage network
// with a service container, plus registered endpoints (an outer endpoint
// that maps to the workspace container, and an inner host that must be
// skipped). Gated on docker (the macOS/Windows runners skip it); the Linux
// runner that measures coverage exercises it fully.
func TestBuildNetworkMap_WithWorkspaceTopology(t *testing.T) {
	requireDocker(t)
	domain := writeTestConfig(t)

	const ws = "covmapws"
	const stage = "dev"
	netName := ws + "-" + stage
	svc := "editor"
	containerName := ws + "-" + svc

	// Create a real docker network + a long-lived container attached to it so
	// dockerNetworksWithContainers() reports the workspace stage network.
	if out, err := exec.Command("docker", "network", "create", netName).CombinedOutput(); err != nil {
		t.Skipf("cannot create docker network (%v): %s", err, out)
	}
	t.Cleanup(func() { _ = exec.Command("docker", "network", "rm", netName).Run() })

	runOut, err := exec.Command("docker", "run", "-d", "--name", containerName,
		"--network", netName, "alpine:3", "sleep", "120").CombinedOutput()
	if err != nil {
		// No image available offline / cannot run → skip rather than fail.
		t.Skipf("cannot run helper container (%v): %s", err, runOut)
	}
	t.Cleanup(func() { _ = exec.Command("docker", "rm", "-f", containerName).Run() })

	// Register an outer endpoint that maps to the workspace's editor service,
	// plus an inner host (must hit the isInnerHost skip branch).
	outerHost := ws + "-" + svc + "." + domain
	if _, err := registerEndpoint(outerHost, "owner@example.com", "Editor", "", "", stage); err != nil {
		t.Fatal(err)
	}
	innerHost := "x" + innerHostSuffix + "." + domain
	if _, err := registerEndpoint(innerHost, "owner@example.com", "Inner", "", "", stage); err != nil {
		t.Fatal(err)
	}

	g := buildNetworkMap()

	// The workspace + its stage network + the service container should appear.
	wantIDs := []string{
		"ws:" + ws,
		"wstraefik:" + ws,
		"net:" + netName,
		"container:" + containerName,
		"ep:" + outerHost,
	}
	for _, id := range wantIDs {
		if !containsNode(g.Nodes, id) {
			t.Errorf("buildNetworkMap missing node %q", id)
		}
	}
	// The inner host must NOT be rendered as an endpoint node.
	if containsNode(g.Nodes, "ep:"+innerHost) {
		t.Errorf("inner host %q should have been skipped", innerHost)
	}
	// A route edge workspace_traefik → editor container should exist.
	foundRoute := false
	for _, e := range g.Edges {
		if e.Source == "wstraefik:"+ws && e.Target == "container:"+containerName && e.Kind == "route" {
			foundRoute = true
		}
	}
	if !foundRoute {
		t.Errorf("missing workspace_traefik→container route edge for %s", containerName)
	}
}

// handleNetworkMapAPI wraps buildNetworkMap and emits JSON.
func TestHandleNetworkMapAPI(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "https://bailey.example.com/bailey/api/admin/network-map", nil)
	w := httptest.NewRecorder()
	handleNetworkMapAPI(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("network-map status = %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("network-map content-type = %q", ct)
	}
	if !strings.Contains(w.Body.String(), `"cloud"`) {
		t.Errorf("network-map body missing cloud node: %s", w.Body.String())
	}
}

// --- workspace_trash.go: trashMarkerPath + IsWorkspaceTrashed ----------

func TestTrashMarkerPath_Shape(t *testing.T) {
	p, err := trashMarkerPath("somews")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(p, "somews/"+trashMarkerName) {
		t.Errorf("trashMarkerPath = %q", p)
	}
}

func TestIsWorkspaceTrashed_FalseWhenAbsent(t *testing.T) {
	if IsWorkspaceTrashed("no-such-trash-marker-ws") {
		t.Error("IsWorkspaceTrashed should be false for an unknown workspace")
	}
}

// --- workspaces_baileyadmin.go: handleCreateWorkspaceFromBaileyAdmin ---
// early-return validation branches (the deep init pipeline needs docker).

func TestHandleCreateWorkspace_BadJSON(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SUDO_USER", "")
	r := baileyReqBody(http.MethodPost, "/bailey/api/workspaces", "admin@example.com", "{not json")
	w := httptest.NewRecorder()
	(&Server{}).handleCreateWorkspaceFromBaileyAdmin(w, r, "admin@example.com")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad-json create = %d, want 400", w.Code)
	}
}

func TestHandleCreateWorkspace_InvalidName(t *testing.T) {
	writeTestConfig(t)
	r := baileyReqBody(http.MethodPost, "/bailey/api/workspaces", "admin@example.com", `{"name":"Bad_Name"}`)
	w := httptest.NewRecorder()
	(&Server{}).handleCreateWorkspaceFromBaileyAdmin(w, r, "admin@example.com")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("invalid-name create = %d, want 400; body=%s", w.Code, w.Body.String())
	}
}

func TestHandleCreateWorkspace_NoDomainConfigured(t *testing.T) {
	// Valid name but no server domain → 400 before the streaming starts.
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SUDO_USER", "")
	r := baileyReqBody(http.MethodPost, "/bailey/api/workspaces", "admin@example.com", `{"name":"validname"}`)
	w := httptest.NewRecorder()
	(&Server{}).handleCreateWorkspaceFromBaileyAdmin(w, r, "admin@example.com")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("no-domain create = %d, want 400; body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "domain is not configured") {
		t.Errorf("no-domain body = %s", w.Body.String())
	}
}

// --- bailey_store_settings.go: round-trip + delete + record ------------

func TestSettingsStore_RoundTripDeleteRecord(t *testing.T) {
	const key = "fill5-default-image"
	// Initially absent.
	if v, err := dbGetSetting(key); err != nil || v != "" {
		t.Fatalf("dbGetSetting absent = (%q,%v), want empty", v, err)
	}
	rec0, err := dbGetSettingRecord(key)
	if err != nil || rec0 != nil {
		t.Fatalf("dbGetSettingRecord absent = (%v,%v), want nil", rec0, err)
	}
	// Set then read back.
	if err := dbSetSetting(key, "img:v1", "setter@example.com"); err != nil {
		t.Fatal(err)
	}
	if v, _ := dbGetSetting(key); v != "img:v1" {
		t.Errorf("dbGetSetting after set = %q", v)
	}
	rec, err := dbGetSettingRecord(key)
	if err != nil || rec == nil || rec.Value != "img:v1" || rec.UpdatedBy != "setter@example.com" {
		t.Fatalf("dbGetSettingRecord = %+v (err %v)", rec, err)
	}
	// Upsert (ON CONFLICT) path.
	if err := dbSetSetting(key, "img:v2", "setter2@example.com"); err != nil {
		t.Fatal(err)
	}
	if v, _ := dbGetSetting(key); v != "img:v2" {
		t.Errorf("dbGetSetting after upsert = %q", v)
	}
	// Delete.
	if err := dbDeleteSetting(key); err != nil {
		t.Fatal(err)
	}
	if v, _ := dbGetSetting(key); v != "" {
		t.Errorf("dbGetSetting after delete = %q, want empty", v)
	}
}

// --- bailey_store_backupcodes.go: save/consume incl. empty-code skip ---

func TestBackupCodesStore_SaveConsume(t *testing.T) {
	email := "backupfill5@example.com"
	// Save a set that includes blank entries (the normalize-skip branch).
	if err := dbSaveBackupCodes(email, []string{"abcd-1234", "", "  ", "wxyz-9999"}); err != nil {
		t.Fatal(err)
	}
	// Empty/blank code → consume is a no-op false without touching the DB.
	if ok, err := dbConsumeBackupCode(email, "   "); err != nil || ok {
		t.Errorf("consume blank = (%v,%v), want (false,nil)", ok, err)
	}
	// Wrong code → false.
	if ok, err := dbConsumeBackupCode(email, "0000-0000"); err != nil || ok {
		t.Errorf("consume wrong = (%v,%v), want (false,nil)", ok, err)
	}
	// Correct code → burns the row.
	if ok, err := dbConsumeBackupCode(email, "abcd-1234"); err != nil || !ok {
		t.Errorf("consume correct = (%v,%v), want (true,nil)", ok, err)
	}
	// Re-consuming the burned code → false.
	if ok, _ := dbConsumeBackupCode(email, "abcd-1234"); ok {
		t.Error("burned code consumed twice")
	}
	// Re-saving replaces the set (DELETE-then-insert branch).
	if err := dbSaveBackupCodes(email, []string{"newc-0001"}); err != nil {
		t.Fatal(err)
	}
	if ok, _ := dbConsumeBackupCode(email, "wxyz-9999"); ok {
		t.Error("old code survived a re-save")
	}
	if ok, _ := dbConsumeBackupCode(email, "newc-0001"); !ok {
		t.Error("new code not consumable after re-save")
	}
}

// --- bailey_gate_api.go: handleGateTOTPVerify error branches -----------

// Already enrolled → 409, never re-saves.
func TestGateTOTPVerify_AlreadyEnrolled(t *testing.T) {
	markServerClaimed(t)
	email := "verifyenrolled@example.com"
	enrolTOTP(t, email) // record now exists
	w := dispatch(gateAPIJSON(http.MethodPost, "/bailey/api/totp/verify", email, `{"code":"123456"}`))
	if w.Code != http.StatusConflict {
		t.Fatalf("verify already-enrolled = %d, want 409; body=%s", w.Code, w.Body.String())
	}
}

// No enrolment-session cookie → 400 ("start over").
func TestGateTOTPVerify_NoEnrolCookie(t *testing.T) {
	markServerClaimed(t)
	email := "verifynocookie@example.com"
	if err := dbDeleteTOTP(email); err != nil {
		t.Fatal(err)
	}
	w := dispatch(gateAPIJSON(http.MethodPost, "/bailey/api/totp/verify", email, `{"code":"123456"}`))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("verify no-cookie = %d, want 400; body=%s", w.Code, w.Body.String())
	}
}

// Cookie present but the submitted code doesn't match → 401.
func TestGateTOTPVerify_WrongCode(t *testing.T) {
	markServerClaimed(t)
	email := "verifywrong@example.com"
	if err := dbDeleteTOTP(email); err != nil {
		t.Fatal(err)
	}
	r := gateAPIJSON(http.MethodPost, "/bailey/api/totp/verify", email, `{"code":"000000"}`)
	// Attach a candidate-secret enrolment cookie so we reach the validate step.
	r.AddCookie(&http.Cookie{Name: gateEnrolCookieName, Value: "JBSWY3DPEHPK3PXP"})
	w := dispatch(r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("verify wrong-code = %d, want 401; body=%s", w.Code, w.Body.String())
	}
}

// requireIdentity short-circuits anonymous callers with 401.
func TestGateTOTPVerify_Anonymous(t *testing.T) {
	markServerClaimed(t)
	w := dispatch(gateAPIJSON(http.MethodPost, "/bailey/api/totp/verify", "", `{"code":"123456"}`))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("verify anon = %d, want 401; body=%s", w.Code, w.Body.String())
	}
}

// --- mfa_gate.go: safeOriginTarget edge cases --------------------------

func TestSafeOriginTarget(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", "/"},
		{"relative/no/slash", "/"},
		{"//evil.com", "/"},
		{"/\\evil", "/"},
		{"/ok/path", "/ok/path"},
		{"/ok?q=1", "/ok?q=1"},
	}
	for _, c := range cases {
		if got := safeOriginTarget(c.in); got != c.want {
			t.Errorf("safeOriginTarget(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

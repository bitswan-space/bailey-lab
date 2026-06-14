package daemon

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
)

// writeTestConfig drops a minimal automation-server config under
// $HOME/.config/bitswan so ProtectedHostnameDomain() resolves a domain
// (callerOwnsWorkspace needs one to build the gitops host). Returns the
// configured domain.
func writeTestConfig(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(os.Getenv("HOME"), ".config", "bitswan")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	const domain = "test.example.com"
	body := "protected_domain = \"" + domain + "\"\n"
	if err := os.WriteFile(filepath.Join(dir, "automation_server_config.toml"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Remove(filepath.Join(dir, "automation_server_config.toml")) })
	return domain
}

// gitopsHostFor mirrors the host callerOwnsWorkspace computes, so tests
// register endpoints at exactly the hostname the production code checks.
func gitopsHostFor(t *testing.T, workspace string) (string, string) {
	t.Helper()
	sc, _ := config.NewAutomationServerConfig().LoadConfig()
	domain := ""
	if sc != nil {
		domain = sc.ProtectedHostnameDomain()
	}
	return workspace + "-gitops." + domain, workspace + "-dashboard." + domain
}

// --- Finding #1 (HIGH): parent-delegation privilege escalation --------
//
// A user granted only `access` on the workspace DASHBOARD must NOT be
// treated as owner of the gitops endpoint (and therefore must not be
// able to trash/restore/update/empty-trash the workspace). The fix
// resolves the gitops role with directRoleFor (no parent delegation).
func TestCallerOwnsWorkspace_DashboardAccessIsNotOwner(t *testing.T) {
	writeTestConfig(t)
	ws := "delegtest"
	gitopsHost, dashboardHost := gitopsHostFor(t, ws)

	// gitops endpoint owned by the real owner, with the dashboard as its
	// parent (the production registration shape).
	if _, err := registerEndpoint(gitopsHost, "owner@example.com", "", dashboardHost, "", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := registerEndpoint(dashboardHost, "owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	// Grant a teammate plain `access` on the dashboard — the routine way
	// to let them into the workspace.
	if err := addGrant(dashboardHost, "email", "collab@example.com", string(roleAccess), "owner@example.com"); err != nil {
		t.Fatal(err)
	}

	// Sanity: roleFor (the OLD, vulnerable resolver) WOULD promote the
	// access member to owner of gitops via parent delegation.
	if role, _ := roleFor(gitopsHost, "collab@example.com", nil); role != roleOwner {
		t.Fatalf("precondition: roleFor should delegate access→owner, got %q", role)
	}

	// The fix: callerOwnsWorkspace must deny the access-only member.
	if callerOwnsWorkspace("collab@example.com", nil, false, ws) {
		t.Error("dashboard access-role member was treated as workspace owner (privilege escalation)")
	}
	// The real gitops owner still owns it.
	if !callerOwnsWorkspace("owner@example.com", nil, false, ws) {
		t.Error("real gitops owner denied ownership")
	}
	// Server-owner override still works.
	if !callerOwnsWorkspace("anyone@example.com", nil, true, ws) {
		t.Error("server-owner override broken")
	}
}

// EmptyTrashFor must apply the same non-delegating ownership check.
func TestEmptyTrashFor_DashboardAccessSkipped(t *testing.T) {
	ws := "trashdeleg"
	gitopsHost, dashboardHost := gitopsHostFor(t, ws)
	if _, err := registerEndpoint(gitopsHost, "owner2@example.com", "", dashboardHost, "", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := registerEndpoint(dashboardHost, "owner2@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := addGrant(dashboardHost, "email", "collab2@example.com", string(roleAccess), "owner2@example.com"); err != nil {
		t.Fatal(err)
	}

	// EmptyTrashFor scans the workspaces dir for trash markers; with no
	// markers present it removes nothing, but we can still assert the
	// per-entry guard via the resolver it now uses. Direct-role check:
	if role, _ := directRoleFor(gitopsHost, "collab2@example.com", nil); role == roleOwner {
		t.Error("directRoleFor wrongly promoted dashboard access to gitops owner")
	}
	if role, _ := directRoleFor(gitopsHost, "owner2@example.com", nil); role != roleOwner {
		t.Error("directRoleFor denied the real owner")
	}
}

// --- Finding #2 (MEDIUM): path traversal via unvalidated {name} -------
//
// /bailey/api/workspaces/%2e%2e/restore reaches the dispatcher with
// workspaceName=="..". The dispatcher must 400 before any handler runs.
func TestDispatch_WorkspaceNameTraversalRejected(t *testing.T) {
	// Single-segment malformed names (the %2e%2e traversal case included)
	// must be 400'd by the dispatcher's nameRe validation before any
	// handler — filesystem path / compose project sink — runs.
	for _, name := range []string{"..", "Foo.Bar", "UPPER", "with space", "x\x00y", ".git"} {
		// Build the request with an already-decoded path segment, the
		// same state ServeMux hands the handler for %2e%2e etc.
		r := httptest.NewRequest(http.MethodPost, "https://bailey.example.com/x", nil)
		r.URL.Path = "/bailey/api/workspaces/" + name + "/restore"
		r.Host = "bailey.example.com"
		r.Header.Set("X-Forwarded-Email", "owner@example.com")
		w := httptest.NewRecorder()
		(&Server{}).handleBailey(w, r)
		if w.Code != http.StatusBadRequest {
			t.Errorf("name %q: status = %d, want 400 (body=%s)", name, w.Code, w.Body.String())
		}
	}
}

// A well-formed name passes the validation gate (it then proceeds to the
// ownership check, which 403s for a non-owner — proving it got past
// validation and into the handler rather than being 400'd).
func TestDispatch_ValidWorkspaceNamePassesValidation(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "https://bailey.example.com/x", nil)
	r.URL.Path = "/bailey/api/workspaces/good-name/restore"
	r.Host = "bailey.example.com"
	r.Header.Set("X-Forwarded-Email", "stranger@example.com")
	w := httptest.NewRecorder()
	(&Server{}).handleBailey(w, r)
	if w.Code == http.StatusBadRequest {
		t.Errorf("valid name rejected as malformed: %s", w.Body.String())
	}
}

// --- Finding #3 (MEDIUM): open redirect via _bailey_origin -----------
func TestSafeOriginTarget_RejectsOffOrigin(t *testing.T) {
	cases := map[string]string{
		"//evil.example":      "/",
		"/\\evil.example":     "/",
		"https://evil.test":   "/",
		"":                    "/",
		"javascript:alert(1)": "/",
		// Legitimate same-origin paths are preserved.
		"/":               "/",
		"/bailey/":        "/bailey/",
		"/workspaces?x=1": "/workspaces?x=1",
	}
	for in, want := range cases {
		if got := safeOriginTarget(in); got != want {
			t.Errorf("safeOriginTarget(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestOriginRedirect_PlantedCookieGoesHome(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "https://bailey.example.com/2fa-gate/recovery", nil)
	r.AddCookie(&http.Cookie{Name: gateOriginCookie, Value: "//evil.example"})
	w := httptest.NewRecorder()
	originRedirect(w, r)
	if loc := w.Header().Get("Location"); loc != "/" {
		t.Errorf("open redirect not blocked: Location = %q, want /", loc)
	}
}

// --- Finding #4 (MEDIUM): non-admin device self-approval --------------
//
// A first-factor-only (oauth-only, no device cookie, no TOTP session)
// browser must NOT be able to approve a pending pair, even its own.
func TestApprove_FirstFactorOnlyRejected(t *testing.T) {
	approver := "selfapprove@example.com"
	// Stash a pending pair for the same user so the only thing standing
	// between approval and success is the trusted-approver check.
	if _, err := generatePendingPair(approver); err != nil {
		t.Fatal(err)
	}
	e, _ := dbLoadPendingPairByEmail(approver)
	if e == nil {
		t.Fatal("no pending pair generated")
	}

	form := url.Values{"email": {approver}, "code": {e.Code}}
	r := httptest.NewRequest(http.MethodPost, "https://bailey.example.com/2fa-gate/approve",
		strings.NewReader(form.Encode()))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	r.Header.Set("X-Forwarded-Email", approver) // oauth first factor only
	w := httptest.NewRecorder()
	approveHandler(w, r, approver)
	if w.Code != http.StatusForbidden {
		t.Fatalf("first-factor-only self-approval: status = %d, want 403", w.Code)
	}
	// The pair must remain unapproved.
	if got, _ := dbLoadPendingPairByEmail(approver); got == nil || got.ApprovedBy != "" {
		t.Error("pending pair was approved by an untrusted browser")
	}
}

// A browser holding a valid device cookie (already second-factor
// cleared) is allowed to approve its own pending pair.
func TestApprove_TrustedDeviceAllowed(t *testing.T) {
	approver := "trustedapprove@example.com"
	dev, err := addDevice(approver, "trusted-laptop")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := generatePendingPair(approver); err != nil {
		t.Fatal(err)
	}
	e, _ := dbLoadPendingPairByEmail(approver)
	if e == nil {
		t.Fatal("no pending pair generated")
	}

	// Mint the device cookie onto a request.
	w0 := httptest.NewRecorder()
	seed := httptest.NewRequest(http.MethodGet, "https://bailey.example.com/", nil)
	if err := setDeviceCookie(w0, seed, approver, dev.ID); err != nil {
		t.Fatal(err)
	}

	form := url.Values{"email": {approver}, "code": {e.Code}}
	r := httptest.NewRequest(http.MethodPost, "https://bailey.example.com/2fa-gate/approve",
		strings.NewReader(form.Encode()))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	r.Header.Set("X-Forwarded-Email", approver)
	for _, c := range w0.Result().Cookies() {
		r.AddCookie(c)
	}
	w := httptest.NewRecorder()
	approveHandler(w, r, approver)
	if w.Code == http.StatusForbidden {
		t.Fatalf("trusted-device approval was rejected: %s", w.Body.String())
	}
	if got, _ := dbLoadPendingPairByEmail(approver); got == nil || got.ApprovedBy == "" {
		t.Error("trusted-device approval did not approve the pair")
	}
}

// --- Finding #5 (CRITICAL): inbound identity-header strip -------------
func TestStripForwardedIdentityHeaders(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "https://x/", nil)
	for _, h := range forwardedIdentityHeaders {
		r.Header.Set(h, "forged")
	}
	r.Header.Set("X-Other", "keep")
	stripForwardedIdentityHeaders(r)
	for _, h := range forwardedIdentityHeaders {
		if r.Header.Get(h) != "" {
			t.Errorf("identity header %q not stripped", h)
		}
	}
	if r.Header.Get("X-Other") != "keep" {
		t.Error("stripForwardedIdentityHeaders removed a non-identity header")
	}
}

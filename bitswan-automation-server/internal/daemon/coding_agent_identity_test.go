package daemon

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"

	"github.com/bitswan-space/bitswan-workspaces/internal/aoc"
	"github.com/bitswan-space/bitswan-workspaces/internal/config"
)

// stubAgentAccountClient stands in for the AOC.
type stubAgentAccountClient struct {
	ensure      *aoc.AgentAccountResponse
	ensureErr   error
	deleteErr   error
	ensureCalls int
	deleteCalls int
	deletedName string
}

func (s *stubAgentAccountClient) EnsureAgentAccount(workspaceName string) (*aoc.AgentAccountResponse, error) {
	s.ensureCalls++
	if s.ensureErr != nil {
		return nil, s.ensureErr
	}
	return s.ensure, nil
}

func (s *stubAgentAccountClient) DeleteAgentAccount(workspaceName string) error {
	s.deleteCalls++
	s.deletedName = workspaceName
	return s.deleteErr
}

// withStubAOC points the provisioning code at a stub and neutralises the
// chown (tests must never shell out to sudo). Restores both afterwards.
func withStubAOC(t *testing.T, stub *stubAgentAccountClient, ctorErr error) {
	t.Helper()
	prevNew, prevChown := newAgentAccountClient, chownAgentFile
	newAgentAccountClient = func() (agentAccountClient, error) {
		if ctorErr != nil {
			return nil, ctorErr
		}
		return stub, nil
	}
	chownAgentFile = func(string) error { return nil }
	t.Cleanup(func() {
		newAgentAccountClient, chownAgentFile = prevNew, prevChown
	})
}

func credsPath(workspacePath string) string {
	return filepath.Join(workspacePath, "coding-agent-home", agentCredentialsFile)
}

func TestProvisionAgentIdentity_WritesCredentialsAndSeedsTOTP(t *testing.T) {
	ws := t.TempDir()
	email := "coding-agent-prov-test-aaaa1111@srv.agents.invalid"
	_ = dbDeleteTOTP(email)
	stub := &stubAgentAccountClient{
		ensure: &aoc.AgentAccountResponse{Email: email, Password: "pw-secret", Created: true},
	}
	withStubAOC(t, stub, nil)

	if err := provisionAgentIdentity("demo-app", ws); err != nil {
		t.Fatalf("provisionAgentIdentity: %v", err)
	}

	creds, err := readAgentCredentials(ws)
	if err != nil {
		t.Fatalf("readAgentCredentials: %v", err)
	}
	if creds.Email != email || creds.Password != "pw-secret" {
		t.Errorf("credentials round-trip wrong: %+v", creds)
	}
	if creds.SelfTrustPath != "/bailey/api/self-trust" {
		t.Errorf("self_trust_path = %q", creds.SelfTrustPath)
	}

	// The seeded secret must be in the store AND match the copy handed to
	// the agent — if these ever diverge, the agent computes codes that
	// self-trust will reject.
	rec, err := dbLoadTOTP(email)
	if err != nil {
		t.Fatalf("dbLoadTOTP: %v", err)
	}
	if rec.Secret != creds.TOTPSecret {
		t.Fatalf("stored secret != secret given to the agent")
	}

	// The point of the whole seeding step: a code derived from the file
	// the agent holds must actually validate against the stored record,
	// which is exactly what handleGateSelfTrust does.
	code, err := totp.GenerateCode(creds.TOTPSecret, time.Now())
	if err != nil {
		t.Fatalf("GenerateCode: %v", err)
	}
	if !totp.Validate(code, rec.Secret) {
		t.Error("code generated from the agent's secret does not validate against the stored record")
	}
}

// The load-bearing integration: a secret this daemon SEEDED server-side
// (no interactive enrolment, no QR code) must be accepted by the real
// /bailey/api/self-trust handler, and must actually trust the device.
//
// The pre-existing self-trust tests all enrol through the interactive flow
// (enrolTOTP), so none of them cover the seeded path — which is the only
// path an unattended agent can use. If the daemon ever starts storing
// secrets in a different shape (encrypted at rest, different encoding),
// provisioning would still "succeed" and the agent would fail at the gate
// with a code that looks correct. This is the test that catches that.
func TestProvisionedSecretIsAcceptedBySelfTrustGate(t *testing.T) {
	markServerClaimed(t)
	ws := t.TempDir()
	email := "coding-agent-gate-test-9999aaaa@srv.agents.invalid"
	_ = dbDeleteTOTP(email)
	withStubAOC(t, &stubAgentAccountClient{
		ensure: &aoc.AgentAccountResponse{Email: email, Password: "pw", Created: true},
	}, nil)

	if err := provisionAgentIdentity("demo-app", ws); err != nil {
		t.Fatalf("provisionAgentIdentity: %v", err)
	}

	// Use the secret exactly as the agent would: read it out of the
	// credentials file, not out of the store.
	creds, err := readAgentCredentials(ws)
	if err != nil {
		t.Fatalf("readAgentCredentials: %v", err)
	}
	code, err := totp.GenerateCode(creds.TOTPSecret, time.Now())
	if err != nil {
		t.Fatalf("GenerateCode: %v", err)
	}

	w := dispatch(gateAPIJSON(
		http.MethodPost, creds.SelfTrustPath, creds.Email, `{"totp":"`+code+`"}`,
	))
	if w.Code != http.StatusOK {
		t.Fatalf("self-trust status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	assertDeviceCookie(t, w, "self-trust with a daemon-seeded secret")
}

// A wrong code must still be refused for a seeded account — seeding must
// not have created a bypass, which was the whole argument for choosing
// this design over a self-trust exemption.
func TestProvisionedAccountStillRejectsWrongCode(t *testing.T) {
	markServerClaimed(t)
	ws := t.TempDir()
	email := "coding-agent-gate-bad-8888bbbb@srv.agents.invalid"
	_ = dbDeleteTOTP(email)
	withStubAOC(t, &stubAgentAccountClient{
		ensure: &aoc.AgentAccountResponse{Email: email, Password: "pw"},
	}, nil)
	if err := provisionAgentIdentity("demo-app", ws); err != nil {
		t.Fatalf("provisionAgentIdentity: %v", err)
	}

	w := dispatch(gateAPIJSON(http.MethodPost, "/bailey/api/self-trust", email, `{"totp":"000000"}`))
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401 for a wrong code on a seeded account", w.Code)
	}
}

func TestProvisionAgentIdentity_FileIsOwnerOnly(t *testing.T) {
	ws := t.TempDir()
	email := "coding-agent-mode-test-bbbb2222@srv.agents.invalid"
	_ = dbDeleteTOTP(email)
	withStubAOC(t, &stubAgentAccountClient{
		ensure: &aoc.AgentAccountResponse{Email: email, Password: "pw"},
	}, nil)

	if err := provisionAgentIdentity("demo-app", ws); err != nil {
		t.Fatalf("provisionAgentIdentity: %v", err)
	}

	info, err := os.Stat(credsPath(ws))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	// The password and the TOTP seed are both in this file; anything
	// group- or world-readable is a finding, not a nit.
	if perm := info.Mode().Perm(); perm != 0600 {
		t.Errorf("credentials file mode = %o, want 600", perm)
	}
}

func TestProvisionAgentIdentity_RotationReplacesFileAndLeavesNoTemps(t *testing.T) {
	ws := t.TempDir()
	email := "coding-agent-rot-test-cccc3333@srv.agents.invalid"
	_ = dbDeleteTOTP(email)
	stub := &stubAgentAccountClient{
		ensure: &aoc.AgentAccountResponse{Email: email, Password: "first-pw", Created: true},
	}
	withStubAOC(t, stub, nil)

	if err := provisionAgentIdentity("demo-app", ws); err != nil {
		t.Fatalf("first provision: %v", err)
	}
	first, err := readAgentCredentials(ws)
	if err != nil {
		t.Fatalf("read after first: %v", err)
	}

	// Re-provisioning rotates the password AOC-side; the local copy must
	// follow or the agent keeps trying an invalidated password.
	stub.ensure = &aoc.AgentAccountResponse{Email: email, Password: "second-pw", Created: false}
	if err := provisionAgentIdentity("demo-app", ws); err != nil {
		t.Fatalf("second provision: %v", err)
	}
	second, err := readAgentCredentials(ws)
	if err != nil {
		t.Fatalf("read after second: %v", err)
	}
	if second.Password != "second-pw" {
		t.Errorf("password after rotation = %q, want second-pw", second.Password)
	}
	if second.TOTPSecret == first.TOTPSecret {
		t.Error("rotation reused the previous TOTP secret")
	}

	// Atomic write leaves nothing behind: a stray *.tmp holding a
	// password would be a quiet secret leak.
	entries, err := os.ReadDir(filepath.Join(ws, "coding-agent-home"))
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Errorf("temp credentials file left behind: %s", e.Name())
		}
	}
}

func TestProvisionAgentIdentity_AOCErrorWritesNothing(t *testing.T) {
	ws := t.TempDir()
	stub := &stubAgentAccountClient{ensureErr: &aoc.AgentAccountError{
		StatusCode: 404, Code: "unknown_workspace", Message: "no such workspace",
	}}
	withStubAOC(t, stub, nil)

	err := provisionAgentIdentity("ghost-workspace", ws)
	if err == nil {
		t.Fatal("expected an error when the AOC rejects the request")
	}

	// Nothing may be written on failure — a credentials file for an
	// account that was never created is worse than no file, because the
	// agent would try to use it.
	if _, statErr := os.Stat(credsPath(ws)); !os.IsNotExist(statErr) {
		t.Errorf("credentials file exists after a failed provision (stat err = %v)", statErr)
	}
	if stub.ensureCalls != 1 {
		t.Errorf("EnsureAgentAccount called %d times, want exactly 1 (no retry loop)", stub.ensureCalls)
	}

	// The classification the caller relies on to decide not to retry.
	var aerr *aoc.AgentAccountError
	if !errors.As(err, &aerr) {
		t.Fatalf("error does not unwrap to *aoc.AgentAccountError: %v", err)
	}
	if !aerr.Permanent() {
		t.Error("unknown_workspace should classify as permanent")
	}
}

func TestProvisionAgentIdentity_ClientConstructionError(t *testing.T) {
	ws := t.TempDir()
	withStubAOC(t, nil, errors.New("no AOC config"))

	if err := provisionAgentIdentity("demo-app", ws); err == nil {
		t.Fatal("expected an error when the AOC client cannot be built")
	}
	if _, statErr := os.Stat(credsPath(ws)); !os.IsNotExist(statErr) {
		t.Error("credentials file written despite client construction failure")
	}
}

func TestDeprovisionAgentIdentity_RemovesEverything(t *testing.T) {
	ws := t.TempDir()
	email := "coding-agent-deprov-test-dddd4444@srv.agents.invalid"
	_ = dbDeleteTOTP(email)
	stub := &stubAgentAccountClient{
		ensure: &aoc.AgentAccountResponse{Email: email, Password: "pw", Created: true},
	}
	withStubAOC(t, stub, nil)

	if err := provisionAgentIdentity("demo-app", ws); err != nil {
		t.Fatalf("provision: %v", err)
	}
	if err := deprovisionAgentIdentity("demo-app", ws); err != nil {
		t.Fatalf("deprovision: %v", err)
	}

	if stub.deletedName != "demo-app" {
		t.Errorf("DeleteAgentAccount got workspace %q", stub.deletedName)
	}
	if _, err := os.Stat(credsPath(ws)); !os.IsNotExist(err) {
		t.Error("credentials file survived deprovision")
	}
	if _, err := dbLoadTOTP(email); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("TOTP record survived deprovision (err = %v)", err)
	}
}

func TestDeprovisionAgentIdentity_AOCFailureKeepsLocalState(t *testing.T) {
	ws := t.TempDir()
	email := "coding-agent-keep-test-eeee5555@srv.agents.invalid"
	_ = dbDeleteTOTP(email)
	stub := &stubAgentAccountClient{
		ensure: &aoc.AgentAccountResponse{Email: email, Password: "pw", Created: true},
	}
	withStubAOC(t, stub, nil)
	if err := provisionAgentIdentity("demo-app", ws); err != nil {
		t.Fatalf("provision: %v", err)
	}

	stub.deleteErr = errors.New("AOC unreachable")
	if err := deprovisionAgentIdentity("demo-app", ws); err == nil {
		t.Fatal("expected an error when the AOC delete fails")
	}

	// Documented ordering guarantee: if the account may still exist, keep
	// the local record of it rather than destroying the only pointer to
	// what needs cleaning up.
	if _, err := os.Stat(credsPath(ws)); err != nil {
		t.Errorf("credentials file removed despite a failed AOC delete: %v", err)
	}
	if _, err := dbLoadTOTP(email); err != nil {
		t.Errorf("TOTP record removed despite a failed AOC delete: %v", err)
	}
}

func TestDeprovisionAgentIdentity_NoCredentialsFileStillDeletesAccount(t *testing.T) {
	ws := t.TempDir()
	stub := &stubAgentAccountClient{}
	withStubAOC(t, stub, nil)

	// Never provisioned locally (or the file was lost): the AOC-side
	// account must still be cleaned up, and a missing file is not an error.
	if err := deprovisionAgentIdentity("demo-app", ws); err != nil {
		t.Fatalf("deprovision with no local file: %v", err)
	}
	if stub.deleteCalls != 1 {
		t.Errorf("DeleteAgentAccount called %d times, want 1", stub.deleteCalls)
	}
}

func TestReadAgentCredentials_Errors(t *testing.T) {
	ws := t.TempDir()

	if _, err := readAgentCredentials(ws); !os.IsNotExist(err) {
		t.Errorf("missing file should report not-exist, got %v", err)
	}

	homeDir := filepath.Join(ws, "coding-agent-home")
	if err := os.MkdirAll(homeDir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(homeDir, agentCredentialsFile), []byte("{not json"), 0600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := readAgentCredentials(ws); err == nil {
		t.Error("malformed JSON should be an error")
	}
}

func TestWriteAgentCredentials_CreatesMissingHomeDir(t *testing.T) {
	ws := t.TempDir()
	prevChown := chownAgentFile
	chownAgentFile = func(string) error { return nil }
	t.Cleanup(func() { chownAgentFile = prevChown })

	// coding-agent-home does not exist yet — Enable normally creates it,
	// but provisioning must not depend on call order.
	if err := writeAgentCredentials(ws, agentAccountCredentials{
		Email: "a@b.agents.invalid", Password: "pw", TOTPSecret: "S",
	}); err != nil {
		t.Fatalf("writeAgentCredentials: %v", err)
	}
	if _, err := os.Stat(credsPath(ws)); err != nil {
		t.Errorf("credentials file not created: %v", err)
	}
}

func TestChownAgentPath_FallsBackToSudo(t *testing.T) {
	// A path that cannot be chowned directly (it does not exist) forces
	// the fallback branch deterministically, on any uid — the tests must
	// not assume they run as 1000 or as root.
	prev := sudoChown
	called := ""
	sudoChown = func(path string) error { called = path; return nil }
	t.Cleanup(func() { sudoChown = prev })

	missing := filepath.Join(t.TempDir(), "definitely-not-here")
	if err := chownAgentPath(missing); err != nil {
		t.Fatalf("chownAgentPath: %v", err)
	}
	if called != missing {
		t.Errorf("sudo fallback got %q, want %q", called, missing)
	}
}

func TestChownAgentPath_FallbackErrorPropagates(t *testing.T) {
	prev := sudoChown
	sudoChown = func(string) error { return errors.New("sudo: not permitted") }
	t.Cleanup(func() { sudoChown = prev })

	if err := chownAgentPath(filepath.Join(t.TempDir(), "nope")); err == nil {
		t.Error("fallback failure should propagate")
	}
}

func TestChownAgentPath_DirectSuccessSkipsSudo(t *testing.T) {
	if os.Geteuid() != 0 && os.Geteuid() != 1000 {
		t.Skipf("cannot chown to 1000:1000 as uid %d", os.Geteuid())
	}
	prev := sudoChown
	sudoChown = func(string) error {
		t.Error("sudo fallback invoked even though the direct chown could succeed")
		return nil
	}
	t.Cleanup(func() { sudoChown = prev })

	f := filepath.Join(t.TempDir(), "ownable")
	if err := os.WriteFile(f, []byte("x"), 0600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := chownAgentPath(f); err != nil {
		t.Fatalf("chownAgentPath: %v", err)
	}
}

func TestWriteAgentCredentials_HomeDirUncreatable(t *testing.T) {
	// workspacePath is a regular file, so coding-agent-home cannot be
	// created under it.
	ws := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(ws, []byte("x"), 0600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := writeAgentCredentials(ws, agentAccountCredentials{Email: "a@b.agents.invalid"}); err == nil {
		t.Error("expected an error when coding-agent-home cannot be created")
	}
}

func TestWriteAgentCredentials_UnwritableHomeDir(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	ws := t.TempDir()
	homeDir := filepath.Join(ws, "coding-agent-home")
	if err := os.MkdirAll(homeDir, 0500); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(homeDir, 0755) })

	if err := writeAgentCredentials(ws, agentAccountCredentials{Email: "a@b.agents.invalid"}); err == nil {
		t.Error("expected an error when the temp file cannot be created")
	}
}

func TestWriteAgentCredentials_InstallFailureLeavesNoTemp(t *testing.T) {
	prevChown := chownAgentFile
	chownAgentFile = func(string) error { return nil }
	t.Cleanup(func() { chownAgentFile = prevChown })

	ws := t.TempDir()
	homeDir := filepath.Join(ws, "coding-agent-home")
	// A leftover DIRECTORY where the credentials file belongs makes the
	// final rename fail, which is the one error path that happens after a
	// temp file already holds the secrets.
	if err := os.MkdirAll(filepath.Join(homeDir, agentCredentialsFile), 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	if err := writeAgentCredentials(ws, agentAccountCredentials{
		Email: "a@b.agents.invalid", Password: "pw", TOTPSecret: "S",
	}); err == nil {
		t.Fatal("expected the install to fail when the destination is a directory")
	}

	// The deferred cleanup must have removed the temp file — otherwise a
	// failed write leaves a world-readable-by-owner copy of the password
	// lying around under a name nothing ever cleans up.
	entries, err := os.ReadDir(homeDir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Errorf("temp credentials file left behind after a failed install: %s", e.Name())
		}
	}
}

func TestProvisionAgentIdentity_WriteFailurePropagates(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	ws := t.TempDir()
	homeDir := filepath.Join(ws, "coding-agent-home")
	if err := os.MkdirAll(homeDir, 0500); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(homeDir, 0755) })

	email := "coding-agent-writefail-ffff6666@srv.agents.invalid"
	_ = dbDeleteTOTP(email)
	withStubAOC(t, &stubAgentAccountClient{
		ensure: &aoc.AgentAccountResponse{Email: email, Password: "pw"},
	}, nil)

	// A failure to hand the agent its credentials must surface, not be
	// reported as a successful provision.
	if err := provisionAgentIdentity("demo-app", ws); err == nil {
		t.Error("expected provisioning to fail when credentials cannot be written")
	}
}

func TestWriteAgentCredentials_ChownFailureIsFatal(t *testing.T) {
	ws := t.TempDir()
	prevChown := chownAgentFile
	chownAgentFile = func(string) error { return errors.New("chown denied") }
	t.Cleanup(func() { chownAgentFile = prevChown })

	err := writeAgentCredentials(ws, agentAccountCredentials{Email: "a@b.agents.invalid", Password: "pw"})
	if err == nil {
		t.Fatal("chown failure must fail the write")
	}
	// A file the agent cannot read is indistinguishable to it from bad
	// credentials, so it must not be left in place.
	if _, statErr := os.Stat(credsPath(ws)); !os.IsNotExist(statErr) {
		t.Error("credentials file installed despite chown failure")
	}
}

// --- endpoint authorization (the second layer) ------------------------------
//
// An account that can log in but has no ACL role gets Bailey's 403 "Access
// required" on every app, which is what live testing of #232 actually hit.
// These tests pin the grant behaviour that fixes it.

// fakeWorkspace creates a workspace whose metadata names a dashboard URL, so
// workspaceDashboardEndpoint resolves, and returns the dashboard hostname.
// HOME is redirected for the duration of the test, which is also what makes
// registerWorkspaceAgentGrant look inside the temp tree.
func fakeWorkspace(t *testing.T, name, dashboardHost string) (wsPath, dashboard string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	wsPath = filepath.Join(home, ".config", "bitswan", "workspaces", name)
	if err := os.MkdirAll(wsPath, 0o755); err != nil {
		t.Fatal(err)
	}
	url := "https://" + dashboardHost
	md := config.WorkspaceMetadata{Domain: "example.com", DashboardURL: &url}
	if err := md.SaveToFile(filepath.Join(wsPath, "metadata.yaml")); err != nil {
		t.Fatal(err)
	}
	if got := workspaceDashboardEndpoint(name); got != dashboardHost {
		t.Fatalf("precondition: workspaceDashboardEndpoint = %q, want %q", got, dashboardHost)
	}
	return wsPath, dashboardHost
}

func provisionInto(t *testing.T, workspace, wsPath, email string) {
	t.Helper()
	_ = dbDeleteTOTP(email)
	withStubAOC(t, &stubAgentAccountClient{
		ensure: &aoc.AgentAccountResponse{Email: email, Password: "pw", Created: true},
	}, nil)
	if err := provisionAgentIdentity(workspace, wsPath); err != nil {
		t.Fatalf("provisionAgentIdentity: %v", err)
	}
}

// The load-bearing test: ONE grant on the dashboard must reach the apps.
// This is the entire justification for granting on the parent rather than
// per-app — if delegation did not apply to the bot, the design would be
// wrong and every deploy would need its own grant.
func TestAgentDashboardGrantReachesWorkspaceApps(t *testing.T) {
	ws, dash := fakeWorkspace(t, "granted-ws", "granted-ws-dashboard.example.com")
	email := "coding-agent-granted-ws-1111aaaa@srv.agents.invalid"

	if _, err := registerEndpoint(dash, "human@example.com", "Dashboard", "", endpointKindWorkspace, ""); err != nil {
		t.Fatal(err)
	}
	app := "granted-ws-frontend-abcd-live.example.com"
	if _, err := registerEndpoint(app, "human@example.com", "App", dash, endpointKindService, "live"); err != nil {
		t.Fatal(err)
	}

	// Before provisioning the bot is refused on the app — the 403 we saw live.
	if role, err := roleFor(app, email, nil); err != nil || role != roleNone {
		t.Fatalf("precondition: role on app = %q (err %v), want none", role, err)
	}

	provisionInto(t, "granted-ws", ws, email)

	// The grant landed on the DASHBOARD, not on the app.
	grants, err := listGrants(app)
	if err != nil {
		t.Fatal(err)
	}
	for _, g := range grants {
		if strings.EqualFold(g.PrincipalValue, email) {
			t.Error("grant was written directly on the app; it belongs on the dashboard")
		}
	}
	if role, err := roleFor(dash, email, nil); err != nil || role != roleAccess {
		t.Fatalf("role on dashboard = %q (err %v), want access", role, err)
	}

	// ...and delegation carries it to the app.
	role, err := roleFor(app, email, nil)
	if err != nil {
		t.Fatal(err)
	}
	if role != roleAccess {
		t.Errorf("role on app = %q, want access via parent delegation", role)
	}

	// An app deployed AFTER provisioning is covered too — the property a
	// per-app grant could not provide without a deploy-path hook.
	later := "granted-ws-frontend-9999-live.example.com"
	if _, err := registerEndpoint(later, "human@example.com", "Later App", dash, endpointKindService, "live"); err != nil {
		t.Fatal(err)
	}
	if role, err := roleFor(later, email, nil); err != nil || role != roleAccess {
		t.Errorf("role on later-deployed app = %q (err %v), want access", role, err)
	}
}

// The bot must never become an owner: owner can manage sharing, and
// delegation must not upgrade access→owner.
func TestAgentGrantIsAccessNotOwner(t *testing.T) {
	ws, dash := fakeWorkspace(t, "leastpriv-ws", "leastpriv-ws-dashboard.example.com")
	email := "coding-agent-leastpriv-2222bbbb@srv.agents.invalid"
	if _, err := registerEndpoint(dash, "human@example.com", "Dashboard", "", endpointKindWorkspace, ""); err != nil {
		t.Fatal(err)
	}
	provisionInto(t, "leastpriv-ws", ws, email)

	grants, err := listGrants(dash)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, g := range grants {
		if strings.EqualFold(g.PrincipalValue, email) {
			found = true
			if g.Role != roleAccess {
				t.Errorf("bot granted role %q, want %q", g.Role, roleAccess)
			}
			if g.PrincipalType != "email" {
				t.Errorf("principal_type = %q, want email", g.PrincipalType)
			}
		}
	}
	if !found {
		t.Fatal("no grant recorded for the bot")
	}
}

// One workspace's bot must not reach another workspace's apps. This is the
// scoping property that makes an automatic grant acceptable at all.
func TestAgentGrantDoesNotCrossWorkspaces(t *testing.T) {
	ws, dash := fakeWorkspace(t, "mine-ws", "mine-ws-dashboard.example.com")
	email := "coding-agent-mine-3333cccc@srv.agents.invalid"
	if _, err := registerEndpoint(dash, "human@example.com", "Mine", "", endpointKindWorkspace, ""); err != nil {
		t.Fatal(err)
	}
	otherDash := "theirs-ws-dashboard.example.com"
	otherApp := "theirs-ws-frontend-0001-live.example.com"
	if _, err := registerEndpoint(otherDash, "human@example.com", "Theirs", "", endpointKindWorkspace, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := registerEndpoint(otherApp, "human@example.com", "Theirs App", otherDash, endpointKindService, "live"); err != nil {
		t.Fatal(err)
	}

	provisionInto(t, "mine-ws", ws, email)

	if role, err := roleFor(otherApp, email, nil); err != nil || role != roleNone {
		t.Errorf("bot reached another workspace's app with role %q (err %v), want none", role, err)
	}
	if role, err := roleFor(otherDash, email, nil); err != nil || role != roleNone {
		t.Errorf("bot reached another workspace's dashboard with role %q (err %v), want none", role, err)
	}
}

// Provisioning must still succeed when the dashboard endpoint is not
// registered yet (fresh init ordering): the identity is usable, only the
// authorization is pending.
func TestProvisionSucceedsWithoutDashboardEndpoint(t *testing.T) {
	ws, dash := fakeWorkspace(t, "pending-ws", "pending-ws-dashboard.example.com")
	email := "coding-agent-pending-4444dddd@srv.agents.invalid"

	provisionInto(t, "pending-ws", ws, email)

	if _, err := readAgentCredentials(ws); err != nil {
		t.Fatalf("credentials missing after provisioning: %v", err)
	}
	if grants, _ := listGrants(dash); len(grants) != 0 {
		t.Errorf("grant recorded against an unregistered endpoint: %+v", grants)
	}

	// Now the dashboard registers — the top-up closes the window.
	if _, err := registerEndpoint(dash, "human@example.com", "Dashboard", "", endpointKindWorkspace, ""); err != nil {
		t.Fatal(err)
	}
	registerWorkspaceAgentGrant("pending-ws")

	if role, err := roleFor(dash, email, nil); err != nil || role != roleAccess {
		t.Errorf("role after top-up = %q (err %v), want access", role, err)
	}
}

// The top-up must be idempotent and must do nothing for a workspace with no
// coding agent (no credentials file ⇒ nothing to authorize).
func TestRegisterWorkspaceAgentGrantIsSafeAndIdempotent(t *testing.T) {
	ws, dash := fakeWorkspace(t, "idem-ws", "idem-ws-dashboard.example.com")
	email := "coding-agent-idem-5555eeee@srv.agents.invalid"
	if _, err := registerEndpoint(dash, "human@example.com", "Dashboard", "", endpointKindWorkspace, ""); err != nil {
		t.Fatal(err)
	}

	// No credentials file yet: must be a silent no-op, not a grant or a panic.
	registerWorkspaceAgentGrant("idem-ws")
	if grants, _ := listGrants(dash); len(grants) != 0 {
		t.Errorf("granted something without a credentials file: %+v", grants)
	}

	provisionInto(t, "idem-ws", ws, email)
	registerWorkspaceAgentGrant("idem-ws")
	registerWorkspaceAgentGrant("idem-ws")

	grants, _ := listGrants(dash)
	n := 0
	for _, g := range grants {
		if strings.EqualFold(g.PrincipalValue, email) {
			n++
		}
	}
	if n != 1 {
		t.Errorf("%d grants for the bot after repeated top-ups, want 1", n)
	}
}

// Tearing down the agent must take its authorization with it, or a deleted
// bot leaves a live grant behind on the workspace.
func TestDeprovisionRevokesDashboardGrant(t *testing.T) {
	ws, dash := fakeWorkspace(t, "teardown-ws", "teardown-ws-dashboard.example.com")
	email := "coding-agent-teardown-6666ffff@srv.agents.invalid"
	if _, err := registerEndpoint(dash, "human@example.com", "Dashboard", "", endpointKindWorkspace, ""); err != nil {
		t.Fatal(err)
	}
	provisionInto(t, "teardown-ws", ws, email)
	if role, _ := roleFor(dash, email, nil); role != roleAccess {
		t.Fatal("precondition: grant not in place")
	}

	withStubAOC(t, &stubAgentAccountClient{}, nil)
	if err := deprovisionAgentIdentity("teardown-ws", ws); err != nil {
		t.Fatalf("deprovisionAgentIdentity: %v", err)
	}

	if role, err := roleFor(dash, email, nil); err != nil || role != roleNone {
		t.Errorf("grant survived deprovisioning: role = %q (err %v)", role, err)
	}
}

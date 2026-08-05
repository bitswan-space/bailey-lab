package cmd

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/bitswan-space/bitswan-workspaces/internal/daemon"
	"github.com/bitswan-space/bitswan-workspaces/internal/daemon/backup"
)

// `bitswan recover server` runs once, on a bad day, against a machine that is
// either bare or somebody else's. These tests cover the decisions that are only
// exercised then — and where being wrong is expensive:
//
//   - refusing to overwrite a DIFFERENT server that happens to live here;
//   - resuming without burning another one-time password (they are single-use
//     and last ten minutes, so demanding a fresh one mid-incident is a real cost);
//   - failing cheaply, before anything is written, when inputs are wrong;
//   - stopping on the first failed workspace instead of grinding through the rest.

type recoverServerFakes struct {
	dockerOK    bool
	volume      bool
	serverID    string
	token       string
	tokenWorks  bool
	otpCalls    int
	manifest    backup.ServerManifest
	manifestErr error
	probeErr    error
	recovered   []string
	failOn      string

	// calls records the preflight's external effects in order. The ordering is the
	// actual feature here — a probe that runs after the OTP exchange would still
	// pass every outcome-based assertion while being useless.
	calls []string
	// probeCred / manifestCred are the credential each read was made with: the OTP
	// normally, a stored token when resuming.
	probeCred    string
	manifestCred string
}

func installRecoverServerFakes(t *testing.T, f *recoverServerFakes) *recoverServerFakes {
	t.Helper()
	saved := struct {
		dockerAvailable func() bool
		volumeExists    func(context.Context) bool
		readServerID    func(context.Context, string) (string, error)
		readToken       func(context.Context, string) (string, error)
		readManifest    func(context.Context, string, string, string, string, string, string, string) (backup.ServerManifest, string, error)
		probeKey        func(context.Context, string, string, string, string, string, string) error
		exchangeOTP     func(string, string, string) (string, string, error)
		tokenWorks      func(string, string, string) bool
		recoverOne      func(*daemon.Client, daemon.RecoverRequest) error
	}{
		recoverServerDockerAvailable, recoverServerVolumeExists, recoverServerReadServerID,
		recoverServerReadToken, recoverServerReadManifest, recoverServerProbeKey,
		recoverServerExchangeOTP, recoverServerTokenWorks, recoverServerRecoverOneWorkspace,
	}
	t.Cleanup(func() {
		recoverServerDockerAvailable = saved.dockerAvailable
		recoverServerVolumeExists = saved.volumeExists
		recoverServerReadServerID = saved.readServerID
		recoverServerReadToken = saved.readToken
		recoverServerReadManifest = saved.readManifest
		recoverServerProbeKey = saved.probeKey
		recoverServerExchangeOTP = saved.exchangeOTP
		recoverServerTokenWorks = saved.tokenWorks
		recoverServerRecoverOneWorkspace = saved.recoverOne
	})

	// Reports land under $HOME; keep them out of the real one.
	t.Setenv("HOME", t.TempDir())

	recoverServerDockerAvailable = func() bool { return f.dockerOK }
	recoverServerVolumeExists = func(context.Context) bool { return f.volume }
	recoverServerReadServerID = func(context.Context, string) (string, error) { return f.serverID, nil }
	recoverServerReadToken = func(context.Context, string) (string, error) { return f.token, nil }
	recoverServerTokenWorks = func(string, string, string) bool { return f.tokenWorks }
	recoverServerExchangeOTP = func(string, string, string) (string, string, error) {
		f.otpCalls++
		f.calls = append(f.calls, "exchange")
		return "FRESH-token", "2027-01-01T00:00:00Z", nil
	}
	recoverServerProbeKey = func(_ context.Context, _, _, cred, _, _, _ string) error {
		f.calls = append(f.calls, "probe")
		f.probeCred = cred
		return f.probeErr
	}
	recoverServerReadManifest = func(_ context.Context, _, _, cred, _, _, _, _ string) (backup.ServerManifest, string, error) {
		f.calls = append(f.calls, "manifest")
		f.manifestCred = cred
		return f.manifest, "", f.manifestErr
	}
	recoverServerRecoverOneWorkspace = func(_ *daemon.Client, req daemon.RecoverRequest) error {
		f.recovered = append(f.recovered, req.Workspace)
		if req.Workspace == f.failOn {
			return fmt.Errorf("snapshot unreadable")
		}
		return nil
	}
	return f
}

func recoverOpts(t *testing.T, extra func(*recoverServerOpts)) recoverServerOpts {
	t.Helper()
	keyFile := filepath.Join(t.TempDir(), "key")
	if err := os.WriteFile(keyFile, []byte("the-key\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	o := recoverServerOpts{
		aocAPI:   "https://api.example.com",
		serverID: "srv-123",
		otp:      "OTP-abc",
		keyFile:  keyFile,
		yes:      true,
		dryRun:   true,
	}
	if extra != nil {
		extra(&o)
	}
	return o
}

func TestRecoverServerRequiresItsIdentityFlags(t *testing.T) {
	err := runRecoverServer(context.Background(), recoverServerOpts{aocAPI: "https://x"})
	if err == nil || !strings.Contains(err.Error(), "--server-id") {
		t.Fatalf("err = %v, want it to name the missing flag", err)
	}
}

func TestRecoverServerRefusesToOverwriteADifferentServer(t *testing.T) {
	// The expensive mistake: running the command on a machine that is already
	// somebody else's automation server.
	f := installRecoverServerFakes(t, &recoverServerFakes{
		dockerOK: true, volume: true, serverID: "srv-SOMEONE-ELSE",
	})

	err := runRecoverServer(context.Background(), recoverOpts(t, nil))
	if err == nil {
		t.Fatal("expected a refusal")
	}
	for _, want := range []string{"srv-SOMEONE-ELSE", "srv-123"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error should name both servers, missing %q: %v", want, err)
		}
	}
	if f.otpCalls != 0 {
		t.Error("a refused recovery must not spend the one-time password")
	}
}

func TestRecoverServerProceedsWhenTheVolumeHoldsThisServer(t *testing.T) {
	// A matching id is a half-finished recovery, not a conflict.
	installRecoverServerFakes(t, &recoverServerFakes{
		dockerOK: true, volume: true, serverID: "srv-123",
		manifest: backup.ServerManifest{ServerID: "srv-123", Domain: "acme.bswn.io"},
	})
	if err := runRecoverServer(context.Background(), recoverOpts(t, nil)); err != nil {
		t.Fatalf("recovery should proceed: %v", err)
	}
}

func TestRecoverServerResumesWithoutBurningAnotherOTP(t *testing.T) {
	f := installRecoverServerFakes(t, &recoverServerFakes{
		dockerOK: true, volume: true, serverID: "srv-123",
		token: "STORED-token", tokenWorks: true,
		manifest: backup.ServerManifest{ServerID: "srv-123"},
	})

	// No --otp at all: the stored token is enough.
	o := recoverOpts(t, func(o *recoverServerOpts) { o.otp = "" })
	if err := runRecoverServer(context.Background(), o); err != nil {
		t.Fatalf("resume should not need an OTP: %v", err)
	}
	if f.otpCalls != 0 {
		t.Errorf("resume spent %d OTP(s); they are single-use", f.otpCalls)
	}
}

func TestRecoverServerDemandsAnOTPWhenTheStoredTokenIsDead(t *testing.T) {
	// A token that the AOC no longer accepts is worthless — say so plainly
	// rather than failing later, deep inside restic.
	installRecoverServerFakes(t, &recoverServerFakes{
		dockerOK: true, volume: true, serverID: "srv-123",
		token: "STALE-token", tokenWorks: false,
	})

	o := recoverOpts(t, func(o *recoverServerOpts) { o.otp = "" })
	err := runRecoverServer(context.Background(), o)
	if err == nil {
		t.Fatal("expected a demand for an OTP")
	}
	if !strings.Contains(err.Error(), "authenticate") {
		t.Errorf("error should explain the credential problem: %v", err)
	}
}

func TestRecoverServerFailsBeforeTouchingAnythingWhenTheKeyIsWrong(t *testing.T) {
	f := installRecoverServerFakes(t, &recoverServerFakes{
		dockerOK: true, manifest: backup.ServerManifest{ServerID: "srv-123"},
	})

	o := recoverOpts(t, func(o *recoverServerOpts) { o.keyFile = "/nonexistent/key" })
	err := runRecoverServer(context.Background(), o)
	if err == nil {
		t.Fatal("expected a failure")
	}
	// A --key-file that was given but is unreadable must be an error, never a
	// silent fall-through to prompting — that would hang an unattended run.
	if !strings.Contains(err.Error(), "encryption key") {
		t.Errorf("error should be about the key: %v", err)
	}
	if len(f.recovered) != 0 {
		t.Error("nothing should have been recovered")
	}
}

func TestRecoverServerReportsAnUnreadableBackupClearly(t *testing.T) {
	installRecoverServerFakes(t, &recoverServerFakes{
		dockerOK:    true,
		manifestErr: fmt.Errorf("wrong password or no key for repository"),
	})
	err := runRecoverServer(context.Background(), recoverOpts(t, nil))
	if err == nil || !strings.Contains(err.Error(), "could not read the backup") {
		t.Fatalf("err = %v, want a clear could-not-read-the-backup failure", err)
	}
}

// The point of the probe: a key that cannot open the repository costs nothing.
// Before it existed, the OTP was already spent and the server's access token
// already rotated by the time the key was first exercised.
func TestRecoverServerAWrongKeyCostsNothing(t *testing.T) {
	f := installRecoverServerFakes(t, &recoverServerFakes{
		dockerOK: true,
		probeErr: &exec.ExitError{ProcessState: fakeExitState(t, resticExitBadPassword)},
	})

	err := runRecoverServer(context.Background(), recoverOpts(t, nil))
	if err == nil {
		t.Fatal("expected the recovery to stop at the probe")
	}
	if f.otpCalls != 0 {
		t.Error("a probe failure must not spend the one-time password — that is the whole feature")
	}
	for _, want := range []string{"does not open", "Nothing has been changed", "still valid"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error should say %q, got: %v", want, err)
		}
	}
	// Nothing beyond the probe should have been attempted.
	if got := strings.Join(f.calls, ","); got != "probe" {
		t.Errorf("calls = %q, want the run to stop at the probe", got)
	}
}

// runPreflight drives phase 0 alone. The ordering inside it is what this change is
// about, and the phases after it need a real docker and a real AOC.
func runPreflight(t *testing.T, o recoverServerOpts) error {
	t.Helper()
	st := &recoverServerState{
		opts:   o,
		report: &daemon.RecoverReport{Workspace: "(server) " + o.serverID, DryRun: o.dryRun},
	}
	return recoverServerPreflight(context.Background(), st, newStepPrinter(st.report))
}

// Ordering is the feature. A probe that ran after the exchange would satisfy every
// outcome-based assertion above while protecting nothing.
func TestRecoverServerVerifiesBeforeItRotatesTheToken(t *testing.T) {
	f := installRecoverServerFakes(t, &recoverServerFakes{
		dockerOK: true,
		manifest: backup.ServerManifest{ServerID: "srv-123"},
	})

	if err := runPreflight(t, recoverOpts(t, func(o *recoverServerOpts) { o.dryRun = false })); err != nil {
		t.Fatalf("preflight failed: %v", err)
	}
	if got := strings.Join(f.calls, ","); got != "probe,manifest,exchange" {
		t.Fatalf("calls = %q, want both reads before the exchange", got)
	}
	// Both reads must go out on the OTP, not on a token that does not exist yet.
	if f.probeCred != "OTP-abc" || f.manifestCred != "OTP-abc" {
		t.Errorf("reads used probe=%q manifest=%q, want the OTP for both",
			f.probeCred, f.manifestCred)
	}
}

// A dry run does read-only work only, so it must not rotate the token. It used to,
// because the exchange happened before the dry-run check.
func TestRecoverServerDryRunSpendsNothing(t *testing.T) {
	f := installRecoverServerFakes(t, &recoverServerFakes{
		dockerOK: true,
		manifest: backup.ServerManifest{ServerID: "srv-123"},
	})

	if err := runRecoverServer(context.Background(), recoverOpts(t, nil)); err != nil {
		t.Fatalf("dry run failed: %v", err)
	}
	if f.otpCalls != 0 {
		t.Error("a dry run must not exchange the OTP — it changes nothing else either")
	}
	if got := strings.Join(f.calls, ","); got != "probe,manifest" {
		t.Errorf("calls = %q, want reads only", got)
	}
}

// Resuming must not need an OTP at all, so the reads go out on the stored token.
func TestRecoverServerResumingProbesWithTheStoredToken(t *testing.T) {
	f := installRecoverServerFakes(t, &recoverServerFakes{
		dockerOK: true, volume: true, serverID: "srv-123",
		token: "STORED-token", tokenWorks: true,
		manifest: backup.ServerManifest{ServerID: "srv-123"},
	})

	err := runPreflight(t, recoverOpts(t, func(o *recoverServerOpts) {
		o.otp = "" // resuming, so none was supplied
		o.dryRun = false
	}))
	if err != nil {
		t.Fatalf("resume failed: %v", err)
	}
	if f.otpCalls != 0 {
		t.Error("resuming must not exchange an OTP")
	}
	if f.probeCred != "STORED-token" {
		t.Errorf("probeCred = %q, want the stored token", f.probeCred)
	}
	if got := strings.Join(f.calls, ","); got != "probe,manifest" {
		t.Errorf("calls = %q, want no exchange when resuming", got)
	}
}

// The three failures worth telling apart must actually read differently — at 3am
// "wrong key" and "this server never backed up" lead to opposite actions.
func TestRecoverServerProbeFailuresAreDistinguishable(t *testing.T) {
	for _, tc := range []struct {
		name string
		code int
		want string
	}{
		{"bad password", resticExitBadPassword, "does not open"},
		{"no repository", resticExitNoRepository, "never completed a backup"},
		{"locked", resticExitRepoLocked, "locked by another operation"},
		{"docker itself failed", 125, "could not reach"},
		{"not a process failure", 0, "could not reach"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var probeErr error = fmt.Errorf("transport blew up")
			if tc.code != 0 {
				probeErr = &exec.ExitError{ProcessState: fakeExitState(t, tc.code)}
			}
			f := installRecoverServerFakes(t, &recoverServerFakes{
				dockerOK: true, probeErr: probeErr,
			})
			err := runRecoverServer(context.Background(), recoverOpts(t, nil))
			if err == nil {
				t.Fatal("expected a failure")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error should contain %q, got: %v", tc.want, err)
			}
			if f.otpCalls != 0 {
				t.Error("no probe failure may spend the OTP")
			}
		})
	}
}

// The probe runs before the OTP is exchanged, so it authenticates with the OTP —
// which the AOC allows reads only. restic locks even to read, and taking a lock is
// a write, so without --no-lock the probe dies on a 403 that says nothing about the
// key. Verified live against the AOC (403 without, 200 with); this pins it.
func TestTheProbeDoesNotLockTheRepository(t *testing.T) {
	var hasNoLock bool
	for _, a := range resticProbeArgs {
		if a == "--no-lock" {
			hasNoLock = true
		}
	}
	if !hasNoLock {
		t.Errorf("resticProbeArgs = %v, must include --no-lock: an OTP-authenticated "+
			"caller cannot write, and restic's lock is a write", resticProbeArgs)
	}
}

// fakeExitState produces a *os.ProcessState with the given exit code by running a
// real process that exits with it — there is no way to construct one directly, and
// the exit-code mapping is worth testing through exec.ExitError rather than around it.
func fakeExitState(t *testing.T, code int) *os.ProcessState {
	t.Helper()
	cmd := exec.Command("sh", "-c", fmt.Sprintf("exit %d", code))
	err := cmd.Run()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("sh -c 'exit %d' did not produce an ExitError: %v", code, err)
	}
	return exitErr.ProcessState
}

func TestRecoverServerWorkspaceScopeHonoursTheFilter(t *testing.T) {
	st := &recoverServerState{
		opts: recoverServerOpts{only: []string{"prod"}},
		manifest: backup.ServerManifest{Workspaces: []backup.ManifestWorkspace{
			{Name: "dev"}, {Name: "prod"}, {Name: "staging"},
		}},
	}
	if got := recoverServerWorkspaceNames(st); len(got) != 1 || got[0] != "prod" {
		t.Errorf("--workspace filter ignored: %v", got)
	}

	st.opts.only = nil
	got := recoverServerWorkspaceNames(st)
	if strings.Join(got, ",") != "dev,prod,staging" {
		t.Errorf("all workspaces expected in a stable order, got %v", got)
	}
}

func TestRecoverServerStopsAtTheFirstFailedWorkspace(t *testing.T) {
	// Fail-fast: a workspace failing usually means something systemic, and
	// grinding through the rest buries the cause.
	f := installRecoverServerFakes(t, &recoverServerFakes{failOn: "second"})
	st := &recoverServerState{
		opts: recoverServerOpts{},
		manifest: backup.ServerManifest{Workspaces: []backup.ManifestWorkspace{
			{Name: "first"}, {Name: "second"}, {Name: "third"},
		}},
		report: &daemon.RecoverReport{},
	}

	err := recoverServerWorkspaces(context.Background(), st, newStepPrinter(st.report))
	if err == nil {
		t.Fatal("expected the run to stop")
	}
	if !strings.Contains(err.Error(), "second") {
		t.Errorf("error should name the workspace that failed: %v", err)
	}
	if strings.Join(f.recovered, ",") != "first,second" {
		t.Errorf("third workspace should not have been attempted: %v", f.recovered)
	}
	// Re-running is the documented remedy, so the error has to say so.
	if !strings.Contains(err.Error(), "re-run") {
		t.Errorf("error should point at re-running: %v", err)
	}
}

func TestRecoverServerRebuildsImagesUnlessOptedOut(t *testing.T) {
	// On a rebuilt host the images are gone, so the default has to be to build
	// them — otherwise the converge fails on a pull of a local-only tag.
	var reqs []daemon.RecoverRequest
	f := installRecoverServerFakes(t, &recoverServerFakes{})
	recoverServerRecoverOneWorkspace = func(_ *daemon.Client, req daemon.RecoverRequest) error {
		reqs = append(reqs, req)
		f.recovered = append(f.recovered, req.Workspace)
		return nil
	}

	newState := func(skip bool) *recoverServerState {
		return &recoverServerState{
			opts:     recoverServerOpts{skipBuild: skip},
			manifest: backup.ServerManifest{Workspaces: []backup.ManifestWorkspace{{Name: "dev"}}},
			report:   &daemon.RecoverReport{},
		}
	}

	st := newState(false)
	if err := recoverServerWorkspaces(context.Background(), st, newStepPrinter(st.report)); err != nil {
		t.Fatal(err)
	}
	if !reqs[0].RebuildImages {
		t.Error("images must be rebuilt by default")
	}
	if !reqs[0].Force {
		t.Error("recovery replaces the workspace, so Force is required")
	}

	reqs = nil
	st = newState(true)
	if err := recoverServerWorkspaces(context.Background(), st, newStepPrinter(st.report)); err != nil {
		t.Fatal(err)
	}
	if reqs[0].RebuildImages {
		t.Error("--skip-image-rebuild must be honoured")
	}
	if len(st.todo) == 0 || !strings.Contains(strings.Join(st.todo, " "), "rebuild") {
		t.Errorf("skipping the rebuild must leave a to-do for the operator: %v", st.todo)
	}
}

// TestRecoveryCapabilityMatchesTheCommandTree keeps daemon.SupportsServerRecovery
// honest. The daemon reports that flag to the AOC, and the AOC pins a recovery to
// the reported version only when it is set — so if `recover server` were removed
// while the flag stayed true, every recovery would fetch a binary that cannot run
// the command it is about to be handed.
func TestRecoveryCapabilityMatchesTheCommandTree(t *testing.T) {
	var found bool
	for _, sub := range newRecoverCmd().Commands() {
		if sub.Name() == "server" {
			found = true
		}
	}
	if found != daemon.SupportsServerRecovery {
		t.Fatalf("`recover server` present=%v but daemon.SupportsServerRecovery=%v — "+
			"the AOC would pin versions on a false promise", found, daemon.SupportsServerRecovery)
	}
}

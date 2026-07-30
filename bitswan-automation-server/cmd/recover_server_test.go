package cmd

import (
	"context"
	"fmt"
	"os"
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
	recovered   []string
	failOn      string
}

func installRecoverServerFakes(t *testing.T, f *recoverServerFakes) *recoverServerFakes {
	t.Helper()
	saved := struct {
		dockerAvailable func() bool
		volumeExists    func(context.Context) bool
		readServerID    func(context.Context, string) (string, error)
		readToken       func(context.Context, string) (string, error)
		readManifest    func(context.Context, string, string, string, string, string, string, string) (backup.ServerManifest, string, error)
		exchangeOTP     func(string, string, string) (string, string, error)
		tokenWorks      func(string, string, string) bool
		recoverOne      func(*daemon.Client, daemon.RecoverRequest) error
	}{
		recoverServerDockerAvailable, recoverServerVolumeExists, recoverServerReadServerID,
		recoverServerReadToken, recoverServerReadManifest, recoverServerExchangeOTP,
		recoverServerTokenWorks, recoverServerRecoverOneWorkspace,
	}
	t.Cleanup(func() {
		recoverServerDockerAvailable = saved.dockerAvailable
		recoverServerVolumeExists = saved.volumeExists
		recoverServerReadServerID = saved.readServerID
		recoverServerReadToken = saved.readToken
		recoverServerReadManifest = saved.readManifest
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
		return "FRESH-token", "2027-01-01T00:00:00Z", nil
	}
	recoverServerReadManifest = func(context.Context, string, string, string, string, string, string, string) (backup.ServerManifest, string, error) {
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

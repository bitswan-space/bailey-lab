package daemon

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
	"github.com/bitswan-space/bitswan-workspaces/internal/daemon/backup"
)

// recoverHarness replaces every external effect with a recorder so the
// orchestrator's ordering and failure policy can be tested without docker,
// restic or a network.
type recoverHarness struct {
	calls []string

	filesErr    error
	gitopsErr   error
	applyErr    error
	postgresErr error

	dashboardCompose bool
	set              backup.SnapshotSet
	enabled          map[string]bool // "service:stage" → enabled
	versionWarning   string          // what the manifest's version check reports
}

func (h *recoverHarness) note(format string, args ...interface{}) {
	h.calls = append(h.calls, fmt.Sprintf(format, args...))
}

func (h *recoverHarness) index(name string) int {
	for i, c := range h.calls {
		if c == name {
			return i
		}
	}
	return -1
}

// install swaps every seam and restores them on cleanup.
func (h *recoverHarness) install(t *testing.T) {
	t.Helper()
	saved := struct {
		stop      func(string, io.Writer)
		byLabel   func(string, io.Writer) error
		named     func([]string, io.Writer) error
		composeUp func(string, string, string, io.Writer) error
		waitGit   func(config.WorkspaceMetadata, string, io.Writer, time.Duration) error
		deploy    func(context.Context, string, string, string, io.Writer) error
		subTraef  func(string, string, bool) (bool, error)
		repush    func(string)
		sel       func(context.Context, string, string, []string, []string) (backup.SnapshotSet, error)
		files     func(context.Context, string, backup.FilesSnapshot, []string) error
		waitSvc   func(context.Context, string, string, string, time.Duration) error
		pg        func(context.Context, string, string, string) (string, error)
		couch     func(context.Context, string, string, string) (string, error)
		garage    func(context.Context, string, string, string, bool) (string, error)
		keys      func(context.Context, string, string) (string, error)
		volDirs   func(string) []string
		enabledFn func(string, string, string) bool
		skew      func(context.Context, string) string
		rebuild   func(context.Context, string, string, string, io.Writer) error
	}{
		recoverStopContainers, recoverRemoveByLabel, recoverRemoveNamed, recoverComposeUp,
		recoverWaitForGitops, recoverDeploy, recoverInitSubTraefik, recoverRepushRoutes,
		recoverSelect, recoverRestoreFiles, recoverWaitService, recoverRestorePostgres,
		recoverRestoreCouchDB, recoverRestoreGarage, recoverGarageKeyCheck,
		recoverEnsureVolumeDirs, recoverServiceEnabled, recoverVersionSkew,
		recoverRebuildAndDeploy,
	}
	t.Cleanup(func() {
		recoverStopContainers, recoverRemoveByLabel, recoverRemoveNamed, recoverComposeUp = saved.stop, saved.byLabel, saved.named, saved.composeUp
		recoverWaitForGitops, recoverDeploy, recoverInitSubTraefik, recoverRepushRoutes = saved.waitGit, saved.deploy, saved.subTraef, saved.repush
		recoverSelect, recoverRestoreFiles, recoverWaitService, recoverRestorePostgres = saved.sel, saved.files, saved.waitSvc, saved.pg
		recoverRestoreCouchDB, recoverRestoreGarage, recoverGarageKeyCheck = saved.couch, saved.garage, saved.keys
		recoverEnsureVolumeDirs, recoverServiceEnabled = saved.volDirs, saved.enabledFn
		recoverVersionSkew = saved.skew
		recoverRebuildAndDeploy = saved.rebuild
	})

	recoverStopContainers = func(ws string, w io.Writer) { h.note("stop") }
	recoverRemoveByLabel = func(label string, w io.Writer) error { h.note("rm-label:%s", label); return nil }
	recoverRemoveNamed = func(names []string, w io.Writer) error { h.note("rm-named"); return nil }
	recoverComposeUp = func(dir, file, project string, w io.Writer) error {
		h.note("compose:%s", project)
		return nil
	}
	recoverWaitForGitops = func(_ config.WorkspaceMetadata, ws string, w io.Writer, d time.Duration) error {
		h.note("gitops")
		return h.gitopsErr
	}
	recoverDeploy = func(_ context.Context, _, _, ws string, w io.Writer) error {
		h.note("apply")
		return h.applyErr
	}
	recoverRebuildAndDeploy = func(_ context.Context, _, _, ws string, w io.Writer) error {
		h.note("rebuild+apply")
		return h.applyErr
	}
	recoverInitSubTraefik = func(ws, domain string, verbose bool) (bool, error) {
		h.note("sub-traefik")
		return true, nil
	}
	recoverRepushRoutes = func(ws string) { h.note("repush") }
	recoverSelect = func(_ context.Context, ws, id string, svc, stages []string) (backup.SnapshotSet, error) {
		h.note("select")
		return h.set, nil
	}
	recoverRestoreFiles = func(_ context.Context, ws string, _ backup.FilesSnapshot, _ []string) error {
		h.note("files")
		if h.filesErr != nil {
			return h.filesErr
		}
		// A successful restore must materialize a usable tree.
		writeRecoverableTree(nil, ws)
		return nil
	}
	recoverWaitService = func(_ context.Context, ws, svc, stage string, d time.Duration) error { return nil }
	recoverRestorePostgres = func(_ context.Context, ws, stage, id string) (string, error) {
		h.note("postgres:%s", stage)
		return "ok", h.postgresErr
	}
	recoverRestoreCouchDB = func(_ context.Context, ws, stage, id string) (string, error) {
		h.note("couchdb:%s", stage)
		return "ok", nil
	}
	recoverRestoreGarage = func(_ context.Context, ws, stage, id string, mirror bool) (string, error) {
		h.note("garage:%s", stage)
		return "ok", nil
	}
	recoverGarageKeyCheck = func(_ context.Context, ws, stage string) (string, error) {
		h.note("garage-keys:%s", stage)
		return "ok", nil
	}
	recoverEnsureVolumeDirs = func(ws string) []string { h.note("volume-dirs"); return nil }
	recoverVersionSkew = func(context.Context, string) string { return h.versionWarning }
	recoverServiceEnabled = func(ws, service, stage string) bool {
		if h.enabled == nil {
			return service == "postgres" && stage == "production"
		}
		return h.enabled[service+":"+stage]
	}
}

// writeRecoverableTree lays down the minimum verifyRestoredTree demands.
func writeRecoverableTree(t *testing.T, ws string) {
	dir := filepath.Join(config.WorkspacesDir(), ws)
	for _, sub := range []string{"deployment", "secrets", "workspace"} {
		_ = os.MkdirAll(filepath.Join(dir, sub), 0o755)
	}
	_ = os.WriteFile(filepath.Join(dir, "metadata.yaml"),
		[]byte("domain: example.com\ngitops-url: https://ws1-gitops.example.com\ngitops-secret: s\n"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "deployment", "docker-compose.yml"),
		[]byte("services:\n  bitswan-gitops:\n    image: bitswan/gitops-dev:latest\n"), 0o644)
}

func newRecoverHarness(t *testing.T) *recoverHarness {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	savedBackoff := recoverDataBackoff
	recoverDataBackoff = time.Millisecond
	t.Cleanup(func() { recoverDataBackoff = savedBackoff })
	h := &recoverHarness{set: backup.SnapshotSet{
		Files: backup.FilesSnapshot{ID: "files-1", ShortID: "f1", Time: time.Now().UTC()},
		Dumps: map[string]map[string]backup.DumpSnapshot{
			"postgres": {"production": {ID: "pg-1", ShortID: "p1"}},
			"couchdb":  {"production": {ID: "cd-1"}},
			"garage":   {"production": {ID: "g-1"}},
		},
	}}
	h.install(t)
	return h
}

func recoverReq(ws string) RecoverRequest {
	return RecoverRequest{Workspace: ws, Force: true, Stages: []string{"production"}}
}

// The full happy path must run the steps in the only order that works.
func TestRecoverStepOrder(t *testing.T) {
	h := newRecoverHarness(t)
	s := &Server{}

	report, err := s.recoverWorkspace(context.Background(), recoverReq("ws1"), func(string) {})
	if err != nil {
		t.Fatalf("recoverWorkspace: %v", err)
	}
	if !report.OK {
		t.Fatalf("report not OK: %+v", report.Steps)
	}

	order := []string{"select", "stop", "files", "volume-dirs", "compose:ws1-site", "gitops", "sub-traefik", "apply", "postgres:production"}
	last := -1
	for _, name := range order {
		i := h.index(name)
		if i < 0 {
			t.Fatalf("%s never ran (calls: %v)", name, h.calls)
		}
		if i < last {
			t.Errorf("%s ran out of order (calls: %v)", name, h.calls)
		}
		last = i
	}

	// The BP/infra containers live outside the daemon's compose projects and
	// must be removed by label, or they keep the replaced tree's inode.
	if h.index("rm-label:gitops.workspace=ws1") < 0 {
		t.Error("BP/infra containers were never removed by label")
	}
	// Data must follow the apply: fresh service volumes come up empty.
	if h.index("apply") > h.index("postgres:production") {
		t.Error("data restore ran before the apply")
	}
	// Garage must follow the apply too — it re-mints the _system key.
	if h.index("apply") > h.index("garage:production") && h.index("garage:production") >= 0 {
		t.Error("garage restore ran before the apply")
	}
}

// A failed file restore must abort before touching containers and roll the
// workspace back byte-for-byte.
func TestRecoverAbortsAndRollsBackOnFilesFailure(t *testing.T) {
	h := newRecoverHarness(t)
	h.filesErr = fmt.Errorf("restic exploded")
	s := &Server{}

	// A live workspace with a sentinel that must survive the failed recovery.
	writeRecoverableTree(t, "ws1")
	sentinel := filepath.Join(config.WorkspacesDir(), "ws1", "sentinel.txt")
	if err := os.WriteFile(sentinel, []byte("original"), 0o644); err != nil {
		t.Fatal(err)
	}

	_, err := s.recoverWorkspace(context.Background(), recoverReq("ws1"), func(string) {})
	if err == nil {
		t.Fatal("expected an error when the file restore failed")
	}
	if h.index("compose:ws1-site") >= 0 {
		t.Error("containers were started despite the failed restore")
	}
	data, readErr := os.ReadFile(sentinel)
	if readErr != nil || string(data) != "original" {
		t.Errorf("workspace was not rolled back: %v / %q", readErr, data)
	}
}

// gitops never coming up must stop the chain before the apply.
func TestRecoverAbortsWhenGitopsUnreachable(t *testing.T) {
	h := newRecoverHarness(t)
	h.gitopsErr = fmt.Errorf("timeout")
	s := &Server{}

	if _, err := s.recoverWorkspace(context.Background(), recoverReq("ws1"), func(string) {}); err == nil {
		t.Fatal("expected an error when gitops never became reachable")
	}
	if h.index("apply") >= 0 {
		t.Error("applied despite gitops being unreachable")
	}
}

// One stage's database failure must not stop the rest, but must fail the report.
func TestRecoverContinuesPastDataFailure(t *testing.T) {
	h := newRecoverHarness(t)
	h.postgresErr = fmt.Errorf("psql refused")
	h.enabled = map[string]bool{"postgres:production": true, "garage:production": true}
	s := &Server{}

	report, err := s.recoverWorkspace(context.Background(), recoverReq("ws1"), func(string) {})
	if err != nil {
		t.Fatalf("a data failure must not abort the recovery: %v", err)
	}
	if report.OK {
		t.Error("report.OK is true despite a failed step")
	}
	if h.index("garage:production") < 0 {
		t.Error("garage was skipped after the postgres failure")
	}
}

// A disabled sidecar is not a failure.
func TestRecoverSkipsAbsentSidecars(t *testing.T) {
	newRecoverHarness(t)
	s := &Server{}

	report, err := s.recoverWorkspace(context.Background(), recoverReq("ws1"), func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	for _, step := range report.Steps {
		if strings.HasPrefix(step.Name, "sidecar:") {
			if !step.Skipped {
				t.Errorf("%s should be skipped when its compose file is absent", step.Name)
			}
			if !step.Success {
				t.Errorf("%s marked failed; an absent sidecar is not a failure", step.Name)
			}
		}
	}
}

// The quarantined tree must not live under workspaces/, or it becomes a phantom
// workspace that gets listed, backed up and reported to AOC.
func TestRecoverQuarantineIsOutsideWorkspacesDir(t *testing.T) {
	newRecoverHarness(t)
	s := &Server{}
	writeRecoverableTree(t, "ws1")

	report, err := s.recoverWorkspace(context.Background(), recoverReq("ws1"), func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	if report.QuarantineDir == "" {
		t.Fatal("no quarantine recorded although the workspace existed")
	}
	if strings.HasPrefix(report.QuarantineDir, config.WorkspacesDir()) {
		t.Errorf("quarantine %q is inside %q", report.QuarantineDir, config.WorkspacesDir())
	}

	entries, err := os.ReadDir(config.WorkspacesDir())
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "ws1" {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("workspaces dir holds %v, want only ws1", names)
	}
}

// A dry run reports the plan and changes nothing.
func TestRecoverDryRun(t *testing.T) {
	h := newRecoverHarness(t)
	s := &Server{}

	req := recoverReq("ws1")
	req.DryRun = true
	report, err := s.recoverWorkspace(context.Background(), req, func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	if !report.DryRun || !report.OK {
		t.Errorf("dry run report = %+v", report)
	}
	if h.index("stop") >= 0 || h.index("files") >= 0 {
		t.Errorf("dry run changed things: %v", h.calls)
	}
}

// A version difference between the binary running the recovery and the one
// that made the backup is worth saying, but never worth refusing over: an
// operator mid-disaster must not be blocked by a diagnostic.
func TestRecoverWarnsOnVersionSkewWithoutFailing(t *testing.T) {
	h := newRecoverHarness(t)
	h.versionWarning = "version skew: this backup was made by bitswan 1.2.3 but 2.0.0 is performing the recovery"
	s := &Server{}

	report, err := s.recoverWorkspace(context.Background(), recoverReq("ws1"), func(string) {})
	if err != nil {
		t.Fatalf("recoverWorkspace: %v", err)
	}
	if !report.OK {
		t.Errorf("skew must not fail the recovery: %+v", report.Steps)
	}

	var found *RecoverStep
	for i := range report.Steps {
		if report.Steps[i].Name == "version" {
			found = &report.Steps[i]
		}
	}
	if found == nil {
		t.Fatalf("no version step in report: %+v", report.Steps)
	}
	if !found.Success || !strings.Contains(found.Output, "1.2.3") {
		t.Errorf("version step = %+v", *found)
	}
	if len(report.Warnings) == 0 || !strings.Contains(strings.Join(report.Warnings, " "), "version skew") {
		t.Errorf("warning not surfaced in the report: %v", report.Warnings)
	}
}

// Matching versions add no step at all — no noise in the normal case.
func TestRecoverSilentWhenVersionsMatch(t *testing.T) {
	h := newRecoverHarness(t)
	h.versionWarning = ""
	s := &Server{}

	report, err := s.recoverWorkspace(context.Background(), recoverReq("ws1"), func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	for _, step := range report.Steps {
		if step.Name == "version" {
			t.Errorf("unexpected version step: %+v", step)
		}
	}
}

// On a rebuilt host the images are gone, so the converge has to build them
// first. Default behaviour must be unchanged — this only fires when asked.
func TestRecoverRebuildsImagesOnlyWhenRequested(t *testing.T) {
	h := newRecoverHarness(t)
	s := &Server{}

	if _, err := s.recoverWorkspace(context.Background(), recoverReq("ws1"), func(string) {}); err != nil {
		t.Fatal(err)
	}
	if h.index("apply") < 0 || h.index("rebuild+apply") >= 0 {
		t.Errorf("default recovery must use the plain converge: %v", h.calls)
	}

	h2 := newRecoverHarness(t)
	req := recoverReq("ws2")
	req.RebuildImages = true
	report, err := (&Server{}).recoverWorkspace(context.Background(), req, func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	if h2.index("rebuild+apply") < 0 || h2.index("apply") >= 0 {
		t.Errorf("RebuildImages must route at the rebuilding converge: %v", h2.calls)
	}
	// The step is named for what it did, so a recovery log says whether images
	// were rebuilt.
	var found bool
	for _, step := range report.Steps {
		if step.Name == "rebuild+apply" {
			found = true
			if !strings.Contains(step.Output, "images rebuilt") {
				t.Errorf("step output should say images were rebuilt: %q", step.Output)
			}
		}
	}
	if !found {
		t.Errorf("no rebuild+apply step in the report: %+v", report.Steps)
	}
}

// The whole-server marker has to hold across the gaps between per-workspace
// recoveries: that is when the AOC list sync would see a half-restored server
// and delete the workspaces it can't see, Keycloak clients and all.
func TestServerRecoveryGuardSuppressesTheAOCSync(t *testing.T) {
	if anyRecoveryInProgress() {
		t.Fatal("registry should start clean")
	}

	beginServerRecovery()
	if !serverRecoveryInProgress() || !anyRecoveryInProgress() {
		t.Error("a server recovery must register as in-progress")
	}
	// No workspace is individually recovering, yet the sync must still stand
	// aside — the gap between workspaces is exactly the dangerous window.
	if workspaceUnderRecovery("ws1") {
		t.Error("no workspace should be marked by the server-level guard")
	}

	endServerRecovery()
	if serverRecoveryInProgress() || anyRecoveryInProgress() {
		t.Error("the marker must clear, or the sync stays disabled forever")
	}
}

// Two recoveries of the same workspace must not overlap.
func TestRecoveryRegistryIsExclusive(t *testing.T) {
	if err := beginRecovery("ws1"); err != nil {
		t.Fatal(err)
	}
	defer endRecovery("ws1")

	if err := beginRecovery("ws1"); err != ErrRecoveryInProgress {
		t.Errorf("second begin = %v, want ErrRecoveryInProgress", err)
	}
	if !workspaceUnderRecovery("ws1") || !anyRecoveryInProgress() {
		t.Error("registry does not report the in-flight recovery")
	}
	if workspaceUnderRecovery("other") {
		t.Error("unrelated workspace reported as recovering")
	}
}

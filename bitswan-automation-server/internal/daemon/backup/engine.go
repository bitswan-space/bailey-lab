package backup

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
	_ "modernc.org/sqlite"
)

// StepResult is one backed-up unit's outcome, shaped like gitops's per-step
// results so consumers (console, CLI) render the same way.
type StepResult struct {
	Success bool `json:"success"`
	// Warning marks a step that did not fail but did not capture everything it
	// was asked to either.
	//
	// The case that forced this: a service whose stage IS configured (its secrets
	// file exists) but whose container was down when the run reached it. Its data
	// is simply not in this backup. Reporting that green is how a backup grows a
	// hole nobody notices until a restore; reporting it red would make every
	// deliberately-stopped workspace cry wolf every night. Neither is the truth,
	// so there is a third state.
	Warning bool   `json:"warning,omitempty"`
	Output  string `json:"output"`
}

// WorkspaceReport maps step name (files, postgres, couchdb, garage) → result.
type WorkspaceReport map[string]StepResult

// RunReport is what a whole nightly run produced; persisted as
// last_run.json and surfaced by the status API.
type RunReport struct {
	StartedAt   time.Time                  `json:"started_at"`
	FinishedAt  time.Time                  `json:"finished_at"`
	OK          bool                       `json:"ok"`
	Workspaces  map[string]WorkspaceReport `json:"workspaces"`
	ServerState StepResult                 `json:"server_state"`
	// Images is the built business-process image archive. Omitted when image
	// backups are switched off, so an older report deserialises unchanged.
	Images    StepResult `json:"images,omitempty"`
	Retention StepResult `json:"retention"`
}

// Engine serializes backup runs (nightly vs run-now) and executes them.
type Engine struct {
	mu          sync.Mutex
	running     bool
	reservedFor string // non-empty when held by a recovery rather than a run

	// Version is the bitswan binary version, stamped into the manifest so a
	// recovery can warn about version skew. Set by the daemon at startup.
	Version string

	// ManifestBuilder produces the server manifest. It lives in the daemon
	// package (it needs the workspace list, image pins and route table), which
	// imports this one — hence a hook rather than a direct call.
	ManifestBuilder func() ([]byte, error)

	// VersionReporter tells the AOC which binary made this run.
	//
	// Called on every run — nightly, catch-up and manual alike — because the
	// version worth recording is the one that wrote the newest recovery point,
	// and that is decided here rather than on a clock. A recovery installs the
	// binary the AOC names, so the two copies of the version (the manifest's,
	// inside the encrypted repo, and the AOC's, which is the only one a recovery
	// can read before it has a binary) agree by construction.
	//
	// Same layering reason as ManifestBuilder: the AOC client lives in the daemon
	// package, which imports this one.
	VersionReporter func()
}

// ErrAlreadyRunning distinguishes the 409 case for the API layer.
var ErrAlreadyRunning = fmt.Errorf("a backup run is already in progress")

// Running reports whether a run is in flight.
func (e *Engine) Running() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.running
}

func (e *Engine) begin() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.running {
		return ErrAlreadyRunning
	}
	e.running = true
	return nil
}

func (e *Engine) end() {
	e.mu.Lock()
	e.running = false
	e.mu.Unlock()
}

// TryReserve claims the engine for something OTHER than a backup run — a
// recovery, which reads the same restic repo and rewrites the very trees a run
// would capture. Holding this blocks the nightly scheduler (and a manual run)
// from starting mid-recovery and capturing a torn workspace as that day's file
// snapshot. reason surfaces in the 409 the blocked caller gets.
func (e *Engine) TryReserve(reason string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.running {
		return ErrAlreadyRunning
	}
	e.running = true
	e.reservedFor = reason
	return nil
}

// Release drops a TryReserve claim.
func (e *Engine) Release() {
	e.mu.Lock()
	e.running = false
	e.reservedFor = ""
	e.mu.Unlock()
}

// ReservedFor reports why the engine is busy ("" when it is a plain backup run).
func (e *Engine) ReservedFor() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.reservedFor
}

func stagingRoot() string { return filepath.Join(Dir(), "staging") }

// listWorkspaces enumerates workspace names (dirs under workspaces/), the
// same walk GetWorkspaceList does.
func listWorkspaces() ([]string, error) {
	entries, err := os.ReadDir(config.WorkspacesDir())
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var names []string
	for _, entry := range entries {
		if entry.IsDir() && !strings.HasPrefix(entry.Name(), ".") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	return names, nil
}

// RunAll performs one full server-level backup: per workspace the whole
// file tree + per-stage DB dumps, then server state, then retention. One
// workspace's (or one step's) failure never aborts the run — it is recorded
// and the run continues. log receives human-readable progress lines.
func (e *Engine) RunAll(ctx context.Context, log func(string)) (*RunReport, error) {
	if err := e.begin(); err != nil {
		return nil, err
	}
	defer e.end()

	report := &RunReport{
		StartedAt:  time.Now().UTC(),
		Workspaces: map[string]WorkspaceReport{},
	}

	status, err := EnsureEnabled(ctx)
	if err != nil && status.Runnable() {
		// Advisory (e.g. key escrow failed) — proceed, but surface it.
		log("Warning: " + err.Error())
	} else if err != nil {
		return nil, err
	}
	if !status.Runnable() {
		return nil, fmt.Errorf("backups not runnable: %s", status.Reason)
	}

	target, err := LoadAOCTarget()
	if err != nil {
		return nil, err
	}
	key, err := LoadKey()
	if err != nil {
		return nil, err
	}
	cfg, _, err := LoadConfig()
	if err != nil {
		return nil, err
	}
	restic := NewRestic(target, key)

	// The daemon is the repo's only writer: a pre-existing lock is a
	// leftover from an interrupted run.
	if err := restic.Unlock(ctx); err != nil {
		log("Warning: restic unlock failed: " + err.Error())
	}

	if err := os.RemoveAll(stagingRoot()); err != nil {
		log("Warning: could not clear staging dir: " + err.Error())
	}

	workspaces, err := listWorkspaces()
	if err != nil {
		return nil, err
	}

	for _, ws := range workspaces {
		log("Backing up workspace " + ws)
		report.Workspaces[ws] = e.backupWorkspace(ctx, restic, ws, log)
	}

	// Before the server state, because that step writes the manifest carrying the
	// same version: reporting here keeps the AOC's copy and the snapshot's copy
	// describing one binary. Placed after the workspace loop only because nothing
	// in that loop can abort the run, so this is reached whenever a run happens
	// at all.
	if e.VersionReporter != nil {
		e.VersionReporter()
	}

	log("Backing up server state")
	report.ServerState = e.backupServerState(ctx, restic)

	// After the workspaces, whose file trees hold the sources these images were
	// built from: a snapshot set where the archive is newer than the trees can be
	// reconciled (the tags say which revision they came from), one where it is
	// older cannot.
	if cfg.Images {
		log("Backing up business-process images")
		report.Images = e.backupImages(ctx, restic)
	}

	log("Applying retention policy")
	report.Retention = applyRetention(ctx, restic, cfg.Retention)

	report.FinishedAt = time.Now().UTC()
	report.OK = report.ServerState.Success && report.Retention.Success
	if cfg.Images {
		report.OK = report.OK && report.Images.Success
	}
	for _, wr := range report.Workspaces {
		for _, step := range wr {
			report.OK = report.OK && step.Success
		}
	}

	if err := writeLastRun(report); err != nil {
		log("Warning: could not persist last-run report: " + err.Error())
	}
	_ = os.RemoveAll(stagingRoot())

	if report.OK {
		log("Backup run completed")
	} else {
		log("Backup run finished with errors")
	}
	return report, nil
}

// resticStep runs one `restic backup` and folds its outcome into a StepResult.
func resticStep(ctx context.Context, restic *Restic, tags []string, path string) StepResult {
	stdout, stderr, err := restic.Run(ctx, restic.BackupArgs(tags, path)...)
	output := strings.TrimSpace(stdout)
	if output == "" {
		output = strings.TrimSpace(stderr)
	}
	if err != nil {
		return StepResult{Success: false, Output: err.Error()}
	}
	// restic output is multi-line; keep the informative last line.
	if lines := strings.Split(output, "\n"); len(lines) > 1 {
		output = strings.TrimSpace(lines[len(lines)-1])
	}
	return StepResult{Success: true, Output: output}
}

// backupWorkspace captures one workspace: its whole tree (secrets included —
// the entire point of server-level backups), then per-stage DB dumps.
func (e *Engine) backupWorkspace(ctx context.Context, restic *Restic, ws string, log func(string)) WorkspaceReport {
	report := WorkspaceReport{}

	report["files"] = resticStep(ctx, restic, []string{"files", "ws:" + ws}, workspaceDir(ws))

	client, wctx, err := driverForWorkspace(ws)
	if err != nil {
		// No driver access (e.g. workspace never redeployed and no compose
		// file): file capture above still succeeded/failed on its own; the
		// dump steps fail with the reason.
		msg := StepResult{Success: false, Output: "infra-driver unavailable: " + err.Error()}
		report["postgres"], report["couchdb"], report["garage"] = msg, msg, msg
		return report
	}

	warn := func(msg string) { log("Warning: [" + ws + "] " + msg) }

	type dumper struct {
		service string
		dump    func(stage, stagingDir string) (string, error)
	}
	dumpers := []dumper{
		{"postgres", func(stage, dir string) (string, error) {
			return dumpPostgresStage(ctx, client, wctx, ws, stage, dir)
		}},
		{"couchdb", func(stage, dir string) (string, error) {
			return dumpCouchDBStage(ctx, client, wctx, ws, stage, dir)
		}},
		{"garage", func(stage, dir string) (string, error) {
			return dumpGarageStage(ctx, client, wctx, ws, stage, dir, warn)
		}},
	}

	for _, d := range dumpers {
		report[d.service] = e.backupServiceStages(ctx, restic, ws, d.service, d.dump)
	}
	return report
}

// backupServiceStages runs one service's dump on every enabled stage and
// aggregates the per-stage outcomes into one StepResult (port of gitops's
// _aggregate_stages).
func (e *Engine) backupServiceStages(ctx context.Context, restic *Restic, ws, service string, dump func(stage, stagingDir string) (string, error)) StepResult {
	perStage := map[string]StepResult{}
	for _, stage := range stages {
		if serviceSecrets(ws, service, stage) == nil {
			continue // not enabled on this stage
		}
		stagingDir := filepath.Join(stagingRoot(), ws, stage, service)
		artifact, err := dump(stage, stagingDir)
		switch {
		case err != nil:
			perStage[stage] = StepResult{Success: false, Output: err.Error()}
		case artifact == "":
			// Not "disabled" — the enabled check above already passed, so this
			// stage is configured and its container is simply down. Say what that
			// costs rather than the neutral "skipped" it used to report.
			perStage[stage] = StepResult{
				Success: true,
				Warning: true,
				Output:  "container not running — this stage's data is NOT in this backup",
			}
		default:
			perStage[stage] = resticStep(ctx, restic,
				[]string{service, "ws:" + ws, "stage:" + stage}, artifact)
			os.RemoveAll(stagingDir)
		}
	}

	if len(perStage) == 0 {
		return StepResult{Success: true, Output: service + " not enabled on any stage, skipped"}
	}
	success := true
	warning := false
	var stageNames []string
	for stage := range perStage {
		stageNames = append(stageNames, stage)
	}
	sort.Strings(stageNames)
	var lines []string
	for _, stage := range stageNames {
		r := perStage[stage]
		success = success && r.Success
		// One caveated stage caveats the service: the aggregate is what the
		// console renders, and a hole in production is not cancelled out by dev
		// having gone fine.
		warning = warning || r.Warning
		tail := r.Output
		if parts := strings.Split(strings.TrimSpace(tail), "\n"); len(parts) > 0 {
			tail = parts[len(parts)-1]
		}
		if tail == "" {
			tail = "ok"
		}
		lines = append(lines, stage+": "+tail)
	}
	return StepResult{Success: success, Warning: warning, Output: strings.Join(lines, "; ")}
}

// bitswanConfigDir is the daemon's state root (the `bitswan` volume).
func bitswanConfigDir() string {
	return filepath.Join(os.Getenv("HOME"), ".config", "bitswan")
}

// baileySnapshotPath is where the consistent bailey.db copy is written. It sits
// beside the live DB ON PURPOSE: the snapshot then records a real path, so a
// restore lands it next to where it belongs and only needs a rename — no
// un-nesting of a staging tree.
func baileySnapshotPath() string {
	return filepath.Join(bitswanConfigDir(), "bailey.db.snapshot")
}

// serverManifestPath is the manifest's home — inside the snapshot and readable
// on the live host without restic.
func serverManifestPath() string {
	return filepath.Join(bitswanConfigDir(), "server-manifest.json")
}

// serverStatePaths is everything the server snapshot captures, enumerated
// explicitly rather than "the config dir minus excludes".
//
// Explicit inclusion is the safer shape: no exclude bug can ever sweep in
// backup/pre-recover (whole quarantined workspace trees), backup/restores, or —
// worst of all — backup/restic-key, which would put the repo's own decryption
// key inside the repo it decrypts.
//
// Deliberately NOT captured, each for a reason:
//   - ~/.local/share/mkcert — holds a CA PRIVATE KEY; kept out of off-site
//     storage by policy. Its fingerprint goes in the manifest so a post-restore
//     mismatch is detectable.
//   - backup/{restic-key,staging,pre-recover,restores,recoveries,*-restore-*}
//     — circular, transient, or potentially enormous.
//   - backup/last_run.json — written AFTER this step, so it would always record
//     the previous run.
//   - workspaces/ — each workspace has its own files,ws:<name> snapshot.
//   - bailey.db / -wal / -shm — torn reads; the VACUUM INTO copy replaces them.
//   - grype / Athens / Verdaccio / proxy-redis volumes — rebuildable caches.
//   - the local image store, /etc/hosts, host-side CLI config — re-created by
//     install/register.
func serverStatePaths() []string {
	cfg := bitswanConfigDir()
	return []string{
		filepath.Join(cfg, "automation_server_config.toml"), // identity: AOC url, server id, token, relay
		baileySnapshotPath(),                        // users, devices, MFA, ACL, audit, image defaults
		filepath.Join(cfg, "traefik"),               // rest-state.json (the route table), acme/, certs/
		filepath.Join(cfg, "protected-proxy"),       // cookie-secret (session + CSRF key)
		filepath.Join(cfg, "certauthorities"),       // operator CAs mounted into every workspace
		filepath.Join(cfg, "backup", "config.json"), // enabled + retention policy
		// The operator's "I saved the key" acknowledgement. Captured because a
		// recovered server would otherwise warn that the key was never saved --
		// on a machine that demonstrably just recovered *using* that key. A
		// warning that cries wolf is a warning nobody reads.
		keyAcknowledgedPath(),
		serverManifestPath(), // what this server was, for recovery
	}
}

// backupServerState captures the server's own state at REAL absolute paths, so
// a recovery can `restic restore --target /` it straight into the `bitswan`
// volume — the same shape RestoreFilesInPlace already relies on.
func (e *Engine) backupServerState(ctx context.Context, restic *Restic) StepResult {
	// A crashed previous run could have left a stale copy behind.
	os.Remove(baileySnapshotPath())

	// Problems along the way are collected rather than returned: everything
	// here is one part of the server's state, and losing the route table and
	// the config because the database could not be read would turn one broken
	// thing into a snapshot with nothing in it. The step still reports red.
	var warnings []string

	baileyDB := filepath.Join(bitswanConfigDir(), "bailey.db")
	if _, err := os.Stat(baileyDB); err == nil {
		// VACUUM INTO makes a consistent single-file copy even while the
		// daemon has the DB open (torn-write-safe, unlike a plain cp, which
		// would race the WAL).
		if err := sqliteVacuumInto(ctx, baileyDB, baileySnapshotPath()); err != nil {
			warnings = append(warnings, "bailey.db snapshot FAILED: "+err.Error())
		} else {
			defer os.Remove(baileySnapshotPath())
		}
	}

	if e.ManifestBuilder != nil {
		data, err := e.ManifestBuilder()
		switch {
		case err != nil:
			// A manifest is a recovery convenience, not the backup itself.
			warnings = append(warnings, "manifest unavailable: "+err.Error())
		default:
			if err := os.WriteFile(serverManifestPath(), data, 0o600); err != nil {
				warnings = append(warnings, "manifest not written: "+err.Error())
			}
		}
	}

	result := e.resticServerStep(ctx, restic, strings.Join(warnings, "; "))
	// A missing database copy is a real gap in a recoverable server, so it
	// fails the run even when restic itself succeeded.
	if len(warnings) > 0 && strings.Contains(warnings[0], "bailey.db snapshot FAILED") {
		result.Success = false
	}
	return result
}

// resticServerStep backs up whichever of the server paths exist, reporting what
// was captured and what was absent. A missing optional path (e.g. an empty
// certauthorities) is never a failure.
func (e *Engine) resticServerStep(ctx context.Context, restic *Restic, warning string) StepResult {
	var present, absent []string
	for _, path := range serverStatePaths() {
		if _, err := os.Stat(path); err == nil {
			present = append(present, path)
		} else {
			absent = append(absent, filepath.Base(path))
		}
	}
	if len(present) == 0 {
		return StepResult{Success: false, Output: "no server state found to back up"}
	}

	args := append([]string{"backup", "--host", restic.Target.ServerID, "--tag", "server-config"}, present...)
	stdout, stderr, err := restic.Run(ctx, args...)

	names := make([]string, 0, len(present))
	for _, path := range present {
		names = append(names, filepath.Base(path))
	}
	detail := "captured " + strings.Join(names, ", ")
	if len(absent) > 0 {
		detail += "; absent " + strings.Join(absent, ", ")
	}
	if warning != "" {
		detail += "; " + warning
	}

	if err != nil {
		return StepResult{Success: false, Output: detail + "; " + err.Error()}
	}
	summary := strings.TrimSpace(stdout)
	if summary == "" {
		summary = strings.TrimSpace(stderr)
	}
	if lines := strings.Split(summary, "\n"); len(lines) > 1 {
		summary = strings.TrimSpace(lines[len(lines)-1])
	}
	return StepResult{Success: true, Warning: warning != "", Output: detail + "; " + summary}
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func sqliteVacuumInto(ctx context.Context, src, dst string) error {
	os.Remove(dst) // VACUUM INTO refuses an existing target
	db, err := sql.Open("sqlite", "file:"+src+"?mode=ro")
	if err != nil {
		return err
	}
	defer db.Close()
	_, err = db.ExecContext(ctx, "VACUUM INTO ?", dst)
	return err
}

// applyRetention prunes every series to the policy (port of gitops's
// _apply_retention): --group-by host,tags makes each (workspace × service ×
// stage) tag set its own series; multiple --tag flags OR the series in.
func applyRetention(ctx context.Context, restic *Restic, retention Retention) StepResult {
	args := []string{"forget", "--prune", "--group-by", "host,tags"}
	for _, tag := range []string{"files", "postgres", "couchdb", "garage", "server-config"} {
		args = append(args, "--tag", tag)
	}
	args = append(args,
		"--keep-daily", fmt.Sprintf("%d", retention.Daily),
		"--keep-monthly", fmt.Sprintf("%d", retention.Monthly),
	)
	stdout, stderr, err := restic.Run(ctx, args...)
	if err != nil {
		return StepResult{Success: false, Output: err.Error()}
	}
	output := strings.TrimSpace(stdout)
	if output == "" {
		output = strings.TrimSpace(stderr)
	}
	if lines := strings.Split(output, "\n"); len(lines) > 1 {
		output = strings.TrimSpace(lines[len(lines)-1])
	}
	return StepResult{Success: true, Output: output}
}

// writeLastRun persists the run outcome beside the config (captured by the
// NEXT run's server-config step for free).
func writeLastRun(report *RunReport) error {
	if err := ensureDir(); err != nil {
		return err
	}
	data, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(lastRunPath(), data, 0o600)
}

// LoadLastRun returns the last run's report, or nil when none exists.
func LoadLastRun() (*RunReport, error) {
	data, err := os.ReadFile(lastRunPath())
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var report RunReport
	if err := json.Unmarshal(data, &report); err != nil {
		return nil, err
	}
	return &report, nil
}

// Snapshots relays `restic snapshots --json`, optionally tag-filtered
// (e.g. "ws:<name>").
func Snapshots(ctx context.Context, tags ...string) (json.RawMessage, error) {
	target, err := LoadAOCTarget()
	if err != nil {
		return nil, err
	}
	key, err := LoadKey()
	if err != nil {
		return nil, err
	}
	if key == "" {
		return nil, fmt.Errorf("no backup key")
	}
	restic := NewRestic(target, key)
	args := []string{"snapshots", "--json"}
	for _, tag := range tags {
		if tag != "" {
			args = append(args, "--tag", tag)
		}
	}
	stdout, _, err := restic.Run(ctx, args...)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(stdout), nil
}

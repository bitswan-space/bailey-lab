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
	Success bool   `json:"success"`
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
	Retention   StepResult                 `json:"retention"`
}

// Engine serializes backup runs (nightly vs run-now) and executes them.
type Engine struct {
	mu      sync.Mutex
	running bool
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

	log("Backing up server state")
	report.ServerState = e.backupServerState(ctx, restic)

	log("Applying retention policy")
	report.Retention = applyRetention(ctx, restic, cfg.Retention)

	report.FinishedAt = time.Now().UTC()
	report.OK = report.ServerState.Success && report.Retention.Success
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
			perStage[stage] = StepResult{Success: true, Output: "container not running, skipped"}
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
	var stageNames []string
	for stage := range perStage {
		stageNames = append(stageNames, stage)
	}
	sort.Strings(stageNames)
	var lines []string
	for _, stage := range stageNames {
		r := perStage[stage]
		success = success && r.Success
		tail := r.Output
		if parts := strings.Split(strings.TrimSpace(tail), "\n"); len(parts) > 0 {
			tail = parts[len(parts)-1]
		}
		if tail == "" {
			tail = "ok"
		}
		lines = append(lines, stage+": "+tail)
	}
	return StepResult{Success: success, Output: strings.Join(lines, "; ")}
}

// backupServerState stages the server's own files (config TOML + a
// consistent bailey.db copy) and backs them up under the server-config tag.
func (e *Engine) backupServerState(ctx context.Context, restic *Restic) StepResult {
	staging := filepath.Join(stagingRoot(), "server")
	if err := os.MkdirAll(staging, 0o700); err != nil {
		return StepResult{Success: false, Output: err.Error()}
	}

	home := os.Getenv("HOME")
	configPath := filepath.Join(home, ".config", "bitswan", "automation_server_config.toml")
	if err := copyFile(configPath, filepath.Join(staging, "automation_server_config.toml")); err != nil && !os.IsNotExist(err) {
		return StepResult{Success: false, Output: "config copy failed: " + err.Error()}
	}

	baileyDB := filepath.Join(home, ".config", "bitswan", "bailey.db")
	if _, err := os.Stat(baileyDB); err == nil {
		// VACUUM INTO makes a consistent single-file copy even while the
		// daemon has the DB open (torn-write-safe, unlike a plain cp).
		if err := sqliteVacuumInto(ctx, baileyDB, filepath.Join(staging, "bailey.db")); err != nil {
			return StepResult{Success: false, Output: "bailey.db snapshot failed: " + err.Error()}
		}
	}

	result := resticStep(ctx, restic, []string{"server-config"}, staging)
	os.RemoveAll(staging)
	return result
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

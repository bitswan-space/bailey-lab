package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
	"github.com/bitswan-space/bitswan-workspaces/internal/daemon/backup"
)

// Workspace recovery: take a workspace from destroyed-or-broken back to
// running-with-its-data in one operation.
//
// This automates the procedure in docs/backup_restore_runbook.md, which a real
// destroy-and-recover drill proved correct but tedious and trap-laden. The
// traps, all encoded below:
//
//   - Docker binds volume-SUBPATH mounts to the directory inode at container
//     create time. Every container that mounts anything under the workspace
//     tree must be recreated after the tree is replaced, or it silently reads
//     the deleted inode. That is four projects, not one: site, dashboard,
//     coding-agent, and the sub-traefik (which mounts traefik.yml/dynamic.yml
//     as single FILES), plus the driver-owned BP/infra containers.
//   - `workspace update` regenerates the compose and re-resolves images, which
//     discards the restored pins — fatal for a --dev workspace. Recovery brings
//     the restored compose up as-is.
//   - The driver apply that recreates infra services and BP containers outlives
//     any client timeout, so this runs as a job.
//   - Fresh service volumes come up EMPTY: the data restores must follow the
//     apply, and Garage must follow it too because the apply re-mints the
//     _system key the restore authenticates with.
//
// It is also the inner loop of server recovery: that is identity bootstrap plus
// this, once per workspace.

// RecoverRequest is the recovery's inputs.
type RecoverRequest struct {
	Workspace  string `json:"workspace"`
	SnapshotID string `json:"snapshot_id,omitempty"` // files snapshot anchoring the set
	Force      bool   `json:"force,omitempty"`       // replace an existing tree

	Stages []string `json:"stages,omitempty"` // empty = every enabled stage

	SkipFiles       bool `json:"skip_files,omitempty"`
	SkipContainers  bool `json:"skip_containers,omitempty"`
	SkipPostgres    bool `json:"skip_postgres,omitempty"`
	SkipCouchDB     bool `json:"skip_couchdb,omitempty"`
	SkipGarage      bool `json:"skip_garage,omitempty"`

	GarageMirror  bool `json:"garage_mirror,omitempty"`  // rclone sync (deletes extraneous)
	DiscardBackup bool `json:"discard_backup,omitempty"` // drop the quarantined tree on success
	DryRun        bool `json:"dry_run,omitempty"`

	// RebuildImages makes the converge BUILD each business process's images
	// before starting its containers, instead of assuming they are already in the
	// local image store.
	//
	// Needed on a rebuilt host and nowhere else. Per-BP images are not in the
	// backup — they only ever existed locally — and the ordinary converge does not
	// build: the compiler emits `image:` with no `build:` and no pull_policy, so
	// compose tries to PULL `internal/…` from Docker Hub and the whole converge
	// fails. Each missing image is rebuilt from the git revision its deployment
	// records, and the tag is a pure content address of that source tree, so the
	// rebuild reproduces exactly the tag bitswan.yaml pins — which is what makes
	// this recovery rather than redeployment.
	RebuildImages bool `json:"rebuild_images,omitempty"`
}

// RecoverStep is one step's outcome. Field names match backup.StepResult so
// existing rendering carries over.
type RecoverStep struct {
	Name     string `json:"name"`
	Success  bool   `json:"success"`
	Skipped  bool   `json:"skipped,omitempty"`
	Output   string `json:"output"`
	Duration string `json:"duration,omitempty"`
}

// RecoverReport is the ordered story of one recovery.
type RecoverReport struct {
	Workspace     string             `json:"workspace"`
	StartedAt     time.Time          `json:"started_at"`
	FinishedAt    time.Time          `json:"finished_at"`
	OK            bool               `json:"ok"`
	DryRun        bool               `json:"dry_run,omitempty"`
	Snapshots     backup.SnapshotSet `json:"snapshots"`
	DriverImage   string             `json:"driver_image,omitempty"`
	QuarantineDir string             `json:"quarantine_dir,omitempty"`
	Steps         []RecoverStep      `json:"steps"`
	Warnings      []string           `json:"warnings,omitempty"`
}

// ErrRecoveryInProgress is the 409 case.
var ErrRecoveryInProgress = fmt.Errorf("a recovery of this workspace is already in progress")

// Recovery registry. Package-level rather than a Server field because the
// background subsystems that must stand aside (the service reconciler and the
// AOC list sync) are package-level functions.
var (
	recoveryMu sync.Mutex
	// recoveringWS holds the workspaces currently mid-recovery.
	recoveringWS = map[string]bool{}
	// serverRecoveryUntil is the DEADLINE of a whole-server recovery, or the zero
	// time when none is running. A whole-server recovery spans many per-workspace
	// recoveries with gaps between them; without covering the gaps, the AOC list
	// sync would see a half-restored server (see anyRecoveryInProgress).
	//
	// A deadline rather than a bool because the marker is opened and closed by a
	// CLI over HTTP, and the close is a deferred call in a process that can be
	// SIGKILLed, lose its network or have its terminal shut. The daemon it is
	// talking to was deployed BY that recovery, so it will not restart and clear
	// the flag on its own. A marker stuck on silently disables the AOC list sync
	// and the backup catch-up run — silently, because neither logs when it stands
	// aside. Expiry makes that self-healing.
	serverRecoveryUntil time.Time
)

// serverRecoveryWindow bounds how long the marker may hold without being closed.
//
// Generous on purpose: a recovery that rebuilds many workspaces legitimately
// runs for hours, and cutting one short would let the catch-up backup snapshot a
// half-restored server — the exact thing the marker prevents. It only has to be
// short enough that an abandoned marker heals well inside a day.
const serverRecoveryWindow = 6 * time.Hour

func beginRecovery(ws string) error {
	recoveryMu.Lock()
	defer recoveryMu.Unlock()
	if recoveringWS[ws] {
		return ErrRecoveryInProgress
	}
	recoveringWS[ws] = true
	return nil
}

func endRecovery(ws string) {
	recoveryMu.Lock()
	delete(recoveringWS, ws)
	recoveryMu.Unlock()
}

// workspaceUnderRecovery reports whether a specific workspace is mid-recovery.
func workspaceUnderRecovery(ws string) bool {
	recoveryMu.Lock()
	defer recoveryMu.Unlock()
	return recoveringWS[ws]
}

// beginServerRecovery marks a whole-server recovery as in flight, for its entire
// duration — through the daemon deploy, the ingress bring-up and every
// per-workspace recovery.
//
// Two things are held off while it is set: the AOC list sync (see
// anyRecoveryInProgress) and the backup scheduler's catch-up run, which would
// otherwise fire five minutes after the daemon boots and make a half-restored
// server the newest recovery point.
func beginServerRecovery() {
	recoveryMu.Lock()
	serverRecoveryUntil = time.Now().Add(serverRecoveryWindow)
	recoveryMu.Unlock()
}

// endServerRecovery clears the whole-server marker. Callers must defer it: a
// stuck marker silently disables the AOC list sync.
func endServerRecovery() {
	recoveryMu.Lock()
	serverRecoveryUntil = time.Time{}
	recoveryMu.Unlock()
}

// serverRecoveryInProgress reports whether a whole-server recovery is running.
func serverRecoveryInProgress() bool {
	recoveryMu.Lock()
	deadline := serverRecoveryUntil
	expired := !deadline.IsZero() && time.Now().After(deadline)
	if expired {
		serverRecoveryUntil = time.Time{}
	}
	recoveryMu.Unlock()

	if expired {
		// Said out loud, once. The states this marker suppresses are both silent,
		// so an abandoned recovery would otherwise leave no trace of why the AOC
		// stopped seeing workspace changes.
		fmt.Printf("Server-recovery marker expired after %s without being closed — "+
			"the recovery command probably died. Resuming normal AOC sync and backups.\n",
			serverRecoveryWindow)
	}
	return !deadline.IsZero() && !expired
}

// ServerRecoveryDeadline is when the current whole-server recovery marker lapses,
// or the zero time when none is held. Surfaced in backup status so an abandoned
// marker is visible rather than something an operator has to infer from backups
// quietly not happening.
func ServerRecoveryDeadline() time.Time {
	recoveryMu.Lock()
	defer recoveryMu.Unlock()
	return serverRecoveryUntil
}

// anyRecoveryInProgress reports whether ANY recovery is in flight. The AOC list
// sync consults this: it reports whatever workspace directories exist right now
// and AOC deletes anything unreported, which would destroy the workspace's
// Keycloak client, editor group and MQTT topics — state that is NOT in the
// backup. A deferred sync is harmless; a wrong one is not.
func anyRecoveryInProgress() bool {
	// serverRecoveryInProgress takes the lock itself (and may expire the marker),
	// so it must be called before we take it here.
	if serverRecoveryInProgress() {
		return true
	}
	recoveryMu.Lock()
	defer recoveryMu.Unlock()
	return len(recoveringWS) > 0
}

// Seams: every external effect goes through a var so tests need no docker.
var (
	recoverStopContainers   = stopWorkspaceContainers
	recoverRemoveByLabel    = removeContainersByLabel
	recoverRemoveNamed      = removeContainersNamed
	recoverComposeUp        = composeUpProject
	recoverWaitForGitops    = waitForGitopsWithin
	recoverDeploy           = deployAutomationsCtx
	recoverRebuildAndDeploy = rebuildAndDeployCtx
	recoverInitSubTraefik   = initWorkspaceTraefik
	recoverRepushRoutes     = repushWorkspaceRoutesToSubTraefik
	recoverSelect           = backup.SelectSnapshotSet
	recoverRestoreFiles     = backup.RestoreFilesInPlace
	recoverWaitService      = backup.WaitForServiceContainer
	recoverRestorePostgres  = backup.RestorePostgres
	recoverRestoreCouchDB   = backup.RestoreCouchDB
	recoverRestoreGarage    = backup.RestoreGarage
	recoverGarageKeyCheck   = checkGarageKeys
	recoverEnsureVolumeDirs = ensureWorkspaceVolumeDirsReporting
	recoverServiceEnabled   = backup.ServiceEnabled
	recoverVersionSkew      = versionSkewWarning
)

// versionSkewWarning compares the binary running this recovery against the one
// that made the backup, as recorded in the server manifest. Any failure to read
// the manifest returns "": an old snapshot simply has none, and a recovery must
// never be held up by a diagnostic.
func versionSkewWarning(ctx context.Context, running string) string {
	target, err := backup.LoadAOCTarget()
	if err != nil {
		return ""
	}
	key, err := backup.LoadKey()
	if err != nil || key == "" {
		return ""
	}
	manifest, err := backup.ReadServerManifest(ctx, backup.NewRestic(target, key), "")
	if err != nil {
		return ""
	}
	return backup.CheckVersionSkew(manifest, running)
}

const (
	recoverGitopsTimeout  = 5 * time.Minute
	recoverApplyTimeout   = 60 * time.Minute
	recoverServiceTimeout = 5 * time.Minute
	recoverDataAttempts   = 3
)

// recoverDataBackoff spaces the data-restore retries. "Container running but
// the service not yet accepting connections" is a real transient right after an
// apply. A var so tests need not sleep.
var recoverDataBackoff = 10 * time.Second

// composeUpProject brings one compose project up. --force-recreate is
// mandatory: after the tree is replaced, an existing container keeps the
// deleted directory's inode and compose will not recreate it on its own
// because the compose content is unchanged.
func composeUpProject(deploymentDir, composeFile, project string, writer io.Writer) error {
	args := []string{"compose"}
	if composeFile != "" {
		args = append(args, "-f", composeFile)
	}
	args = append(args, "-p", project, "up", "-d", "--pull", "missing", "--force-recreate", "--remove-orphans")
	cmd := exec.Command("docker", args...)
	cmd.Dir = deploymentDir
	cmd.Stdout = writer
	cmd.Stderr = writer
	return cmd.Run()
}

// removeContainersByLabel force-removes every container carrying a label. The
// driver stamps gitops.workspace on BP and infra containers, which live in the
// driver's own compose project and therefore survive stopWorkspaceContainers.
// Removing them is safe: their data is in named volumes and the apply recreates
// them.
func removeContainersByLabel(label string, writer io.Writer) error {
	out, err := exec.Command("docker", "ps", "-aq", "--filter", "label="+label).Output()
	if err != nil {
		return err
	}
	ids := strings.Fields(string(out))
	if len(ids) == 0 {
		return nil
	}
	fmt.Fprintf(writer, "Removing %d container(s) labelled %s\n", len(ids), label)
	return exec.Command("docker", append([]string{"rm", "-f"}, ids...)...).Run()
}

// removeContainersNamed force-removes containers by name, ignoring absent ones.
func removeContainersNamed(names []string, writer io.Writer) error {
	for _, name := range names {
		_ = exec.Command("docker", "rm", "-f", name).Run()
	}
	return nil
}

// ensureWorkspaceVolumeDirsReporting creates the standard subdirs and chowns
// ONLY the ones it had to create. A restored tree can predate a subdir this
// daemon version expects (workspaceVolumeSubdirs grows across releases), and a
// strict volume-subpath mount fails the container when its source is missing.
// MkdirAll leaves new dirs root-owned while their restored siblings are uid
// 1000, which would EACCES gitops — hence the targeted chown. A recursive chown
// is deliberately avoided; it takes minutes on a large tree.
func ensureWorkspaceVolumeDirsReporting(ws string) []string {
	var created []string
	base := filepath.Join(config.WorkspacesDir(), ws)
	for _, sub := range workspaceVolumeSubdirs {
		path := filepath.Join(base, sub)
		if _, err := os.Stat(path); err == nil {
			continue
		}
		if err := os.MkdirAll(path, 0o755); err != nil {
			continue
		}
		_ = os.Chown(path, 1000, 1000)
		created = append(created, sub)
	}
	return created
}

// checkGarageKeys reports Garage access keys named by the workspace's secrets
// that Garage itself does not have. Restoring secrets onto a rebuilt Garage
// (whose metadata volume holds buckets AND keys) leaves them dangling; the
// driver self-heals this, but only from the release that fixed it, so a restored
// compose pinning an older driver image stays broken with "No such key: GK…".
func checkGarageKeys(ctx context.Context, ws, stage string) (string, error) {
	return backup.CheckGarageKeys(ctx, ws, stage)
}

func (s *Server) recoverWorkspace(ctx context.Context, req RecoverRequest, log func(string)) (*RecoverReport, error) {
	ws := req.Workspace
	report := &RecoverReport{Workspace: ws, StartedAt: time.Now().UTC(), DryRun: req.DryRun}

	writer := logWriter{log: log}
	step := func(name string, fn func() (string, error)) bool {
		started := time.Now()
		out, err := fn()
		entry := RecoverStep{Name: name, Success: err == nil, Output: out,
			Duration: time.Since(started).Round(time.Millisecond).String()}
		if err != nil {
			entry.Output = strings.TrimSpace(out + " " + err.Error())
		}
		report.Steps = append(report.Steps, entry)
		if err != nil {
			log(fmt.Sprintf("[%s] FAILED: %s", name, entry.Output))
		} else if out != "" {
			log(fmt.Sprintf("[%s] %s", name, out))
		} else {
			log(fmt.Sprintf("[%s] ok", name))
		}
		persistRecoverReport(report)
		return err == nil
	}
	skip := func(name, why string) {
		report.Steps = append(report.Steps, RecoverStep{Name: name, Success: true, Skipped: true, Output: why})
		log(fmt.Sprintf("[%s] skipped: %s", name, why))
	}

	wsDir := filepath.Join(config.WorkspacesDir(), ws)

	// --- 1. select the recovery point -------------------------------------
	var set backup.SnapshotSet
	if !step("select", func() (string, error) {
		var err error
		set, err = recoverSelect(ctx, ws, req.SnapshotID, nil, req.Stages)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("files %s from %s", set.Files.ShortID,
			set.Files.Time.UTC().Format(time.RFC3339)), nil
	}) {
		return finishRecover(report), fmt.Errorf("could not choose a recovery point")
	}
	report.Snapshots = set
	report.Warnings = append(report.Warnings, set.Warnings...)
	for _, w := range set.Warnings {
		log("Warning: " + w)
	}

	// --- 1b. version skew: a warning, never a refusal ---------------------
	// Restores are expected to work across versions, and blocking a recovery
	// over a version difference would be worse than the risk it names. But if
	// something behaves oddly afterwards, this is the first thing to check —
	// so say it up front rather than leaving it to be discovered.
	if warning := recoverVersionSkew(ctx, s.version); warning != "" {
		report.Warnings = append(report.Warnings, warning)
		log("Warning: " + warning)
		report.Steps = append(report.Steps, RecoverStep{
			Name: "version", Success: true, Output: warning})
	}

	report.DriverImage = driverImageFromCompose(ws)

	if req.DryRun {
		log("Dry run: nothing was changed.")
		report.OK = true
		return finishRecover(report), nil
	}

	// --- 2. stop everything that could hold a stale inode -----------------
	if req.SkipContainers {
		skip("stop", "--skip-containers")
	} else {
		step("stop", func() (string, error) {
			recoverStopContainers(ws, writer)
			if err := recoverRemoveByLabel("gitops.workspace="+ws, writer); err != nil {
				return "", err
			}
			// Both spellings exist across releases.
			_ = recoverRemoveNamed([]string{ws + "__traefik", "bitswan-" + strings.ToLower(ws) + "-traefik"}, writer)
			return "containers stopped and removed", nil
		})
	}

	// --- 3. replace the tree ---------------------------------------------
	quarantine := ""
	if req.SkipFiles {
		skip("files", "--skip-files")
	} else {
		if !step("files", func() (string, error) {
			q, err := quarantineWorkspaceTree(ws)
			if err != nil {
				return "", err
			}
			quarantine = q
			report.QuarantineDir = q

			if err := recoverRestoreFiles(ctx, ws, set.Files, nil); err != nil {
				rollbackQuarantine(ws, q, log)
				report.QuarantineDir = ""
				return "", err
			}
			if q != "" {
				return "tree restored (previous tree kept at " + q + ")", nil
			}
			return "tree restored", nil
		}) {
			return finishRecover(report), fmt.Errorf("file restore failed; the workspace was left as it was")
		}

		if !step("verify-tree", func() (string, error) { return verifyRestoredTree(ws) }) {
			rollbackQuarantine(ws, quarantine, log)
			report.QuarantineDir = ""
			return finishRecover(report), fmt.Errorf("the restored tree is not usable; the workspace was rolled back")
		}

		step("volume-dirs", func() (string, error) {
			created := recoverEnsureVolumeDirs(ws)
			if len(created) == 0 {
				return "all present", nil
			}
			return "created " + strings.Join(created, ", "), nil
		})
	}

	// --- 4. containers ----------------------------------------------------
	if req.SkipContainers {
		skip("site", "--skip-containers")
	} else {
		metadata, err := config.GetWorkspaceMetadata(ws)
		if err != nil {
			report.Steps = append(report.Steps, RecoverStep{Name: "site", Output: err.Error()})
			return finishRecover(report), err
		}
		deploymentDir := filepath.Join(wsDir, "deployment")

		if !step("site", func() (string, error) {
			if err := recoverComposeUp(deploymentDir, "", strings.ToLower(ws)+"-site", writer); err != nil {
				return "", fmt.Errorf("%w — if this is a pull failure the restored compose pins an image this host lacks; "+
					"`bitswan workspace update %s [--dev|--staging]` re-resolves images but DISCARDS the restored pins", err, ws)
			}
			return "gitops + infra-driver up", nil
		}) {
			return finishRecover(report), fmt.Errorf("could not start the workspace's core containers")
		}

		if !step("gitops", func() (string, error) {
			if err := recoverWaitForGitops(metadata, ws, writer, recoverGitopsTimeout); err != nil {
				return gitopsTailLogs(ws), err
			}
			return "reachable", nil
		}) {
			return finishRecover(report), fmt.Errorf("gitops did not become reachable")
		}

		for _, sidecar := range []struct{ name, file, suffix string }{
			{"dashboard", "docker-compose-dashboard.yml", "-dashboard"},
			{"coding-agent", "docker-compose-coding-agent.yml", "-coding-agent"},
		} {
			composePath := filepath.Join(deploymentDir, sidecar.file)
			if _, err := os.Stat(composePath); err != nil {
				skip("sidecar:"+sidecar.name, "not enabled for this workspace")
				continue
			}
			sc := sidecar
			step("sidecar:"+sc.name, func() (string, error) {
				if err := recoverComposeUp(deploymentDir, sc.file, strings.ToLower(ws)+sc.suffix, writer); err != nil {
					return "", err
				}
				return "recreated", nil
			})
		}

		step("sub-traefik", func() (string, error) {
			if _, err := recoverInitSubTraefik(ws, metadata.Domain, false); err != nil {
				return "", err
			}
			recoverRepushRoutes(ws)
			return "recreated and routes re-pushed", nil
		})

		// --- 5. the apply that recreates infra services and BP containers ---
		// With RebuildImages this also BUILDS each BP's images first, which on a
		// rebuilt host is the difference between converging and failing on a
		// pull of a local-only `internal/…` tag.
		stepName, applyResult := "apply", "workspace converged"
		if req.RebuildImages {
			stepName, applyResult = "rebuild+apply", "images rebuilt and workspace converged"
		}
		step(stepName, func() (string, error) {
			applyCtx, cancel := context.WithTimeout(ctx, recoverApplyTimeout)
			defer cancel()
			deploy := recoverDeploy
			if req.RebuildImages {
				deploy = recoverRebuildAndDeploy
			}
			if err := deploy(applyCtx, metadata.GitopsURL, metadata.GitopsSecret, ws, writer); err != nil {
				// A partial apply usually still created the infra services, and
				// every data step verifies its own container, so keep going.
				report.Warnings = append(report.Warnings, stepName+" reported: "+err.Error())
				return "", err
			}
			return applyResult, nil
		})
	}

	// --- 6. data, per enabled stage --------------------------------------
	s.recoverData(ctx, req, set, report, step, skip, log)

	report.OK = true
	for _, st := range report.Steps {
		if !st.Success {
			report.OK = false
			break
		}
	}
	if report.OK && quarantine != "" && req.DiscardBackup {
		_ = os.RemoveAll(quarantine)
		report.QuarantineDir = ""
	}
	return finishRecover(report), nil
}

// recoverData restores the databases and object storage for every enabled
// stage. Each (service, stage) is isolated: one failure never stops the others,
// mirroring the backup engine's per-stage aggregation.
func (s *Server) recoverData(ctx context.Context, req RecoverRequest, set backup.SnapshotSet,
	report *RecoverReport, step func(string, func() (string, error)) bool, skip func(string, string), log func(string)) {

	ws := req.Workspace
	stages := req.Stages
	if len(stages) == 0 {
		stages = []string{"dev", "staging", "production"}
	}

	type svc struct {
		name    string
		skipped bool
		restore func(ctx context.Context, stage, snapshotID string) (string, error)
	}
	services := []svc{
		{"postgres", req.SkipPostgres, func(ctx context.Context, stage, id string) (string, error) {
			return recoverRestorePostgres(ctx, ws, stage, id)
		}},
		{"couchdb", req.SkipCouchDB, func(ctx context.Context, stage, id string) (string, error) {
			return recoverRestoreCouchDB(ctx, ws, stage, id)
		}},
		{"garage", req.SkipGarage, func(ctx context.Context, stage, id string) (string, error) {
			return recoverRestoreGarage(ctx, ws, stage, id, req.GarageMirror)
		}},
	}

	for _, stage := range stages {
		// Garage keys first: a dangling key makes the Garage restore (and the
		// workspace's own apps) fail with AccessDenied, and knowing that up
		// front explains everything that follows.
		if !req.SkipGarage && recoverServiceEnabled(ws, "garage", stage) {
			step("garage-keys:"+stage, func() (string, error) {
				return recoverGarageKeyCheck(ctx, ws, stage)
			})
		}

		for _, service := range services {
			name := service.name + ":" + stage
			if service.skipped {
				skip(name, "--skip-"+service.name)
				continue
			}
			if !recoverServiceEnabled(ws, service.name, stage) {
				skip(name, "not enabled on this stage")
				continue
			}
			dump, ok := set.Dump(service.name, stage)
			if !ok {
				skip(name, "no snapshot in the selected backup run")
				continue
			}

			sv, st, id := service, stage, dump.ID
			step(name, func() (string, error) {
				if err := recoverWaitService(ctx, ws, sv.name, st, recoverServiceTimeout); err != nil {
					return "", err
				}
				var out string
				var err error
				for attempt := 1; attempt <= recoverDataAttempts; attempt++ {
					out, err = sv.restore(ctx, st, id)
					if err == nil {
						return out, nil
					}
					if attempt < recoverDataAttempts {
						log(fmt.Sprintf("[%s] attempt %d failed (%v) — retrying in %s",
							name, attempt, err, recoverDataBackoff))
						select {
						case <-ctx.Done():
							return out, ctx.Err()
						case <-time.After(recoverDataBackoff):
						}
					}
				}
				return out, err
			})
		}
	}
}

// PersistServerRecoverReport writes a whole-server recovery's report.
//
// Exported because that recovery runs from the CLI, before any daemon exists, yet
// should leave the same on-disk record a workspace recovery does. It lands in the
// operator's own ~/.config/bitswan/backup/recoveries rather than the daemon's
// volume — which is the honest place for it, since the host is where the command
// ran and the volume may not have existed when it started.
func PersistServerRecoverReport(report *RecoverReport) { persistRecoverReport(report) }

// finishRecover stamps the end time and persists the final report.
//
// Free functions rather than methods: a whole-server recovery writes reports of
// the same shape, and it runs on the host before any *Server exists.
func finishRecover(report *RecoverReport) *RecoverReport {
	report.FinishedAt = time.Now().UTC()
	persistRecoverReport(report)
	return report
}

// persistRecoverReport writes the report after every step: the job manager is
// in-memory, so a daemon restart mid-recovery would otherwise lose the record
// of what had already been done.
func persistRecoverReport(report *RecoverReport) {
	dir := filepath.Join(backup.Dir(), "recoveries")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return
	}
	data, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return
	}
	name := fmt.Sprintf("%s-%s.json", report.Workspace, report.StartedAt.Format("2006-01-02_15-04-05"))
	_ = os.WriteFile(filepath.Join(dir, name), data, 0o600)
}

// quarantineWorkspaceTree renames the live tree aside so the in-place restore
// lands in an empty directory (restic restore merges rather than replaces).
//
// Two subtleties: the destination is OUTSIDE workspaces/ because
// GetWorkspaceList enumerates that directory and a sibling would become a
// phantom workspace that gets listed, backed up and reported to AOC; and a
// placeholder directory carrying metadata.yaml goes back immediately, so the
// workspace never disappears from the listing while a concurrent AOC sync could
// see it (AOC deletes unreported workspaces along with their Keycloak client).
func quarantineWorkspaceTree(ws string) (string, error) {
	wsDir := filepath.Join(config.WorkspacesDir(), ws)
	if _, err := os.Stat(wsDir); os.IsNotExist(err) {
		return "", nil // nothing to preserve — a cold recovery
	}

	dest := filepath.Join(backup.Dir(), "pre-recover",
		fmt.Sprintf("%s-%s", ws, time.Now().UTC().Format("2006-01-02_15-04-05")))
	if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
		return "", err
	}
	if err := os.Rename(wsDir, dest); err != nil {
		return "", fmt.Errorf("could not move the existing workspace aside: %w", err)
	}

	if err := os.MkdirAll(wsDir, 0o755); err == nil {
		_ = os.Chown(wsDir, 1000, 1000)
		if data, err := os.ReadFile(filepath.Join(dest, "metadata.yaml")); err == nil {
			_ = os.WriteFile(filepath.Join(wsDir, "metadata.yaml"), data, 0o644)
		}
	}
	return dest, nil
}

// rollbackQuarantine puts the original tree back after a failed restore. With
// no quarantine (cold recovery) it removes the partial tree instead, so the next
// attempt needs no --force and the nightly cannot capture a half-restored tree.
func rollbackQuarantine(ws, quarantine string, log func(string)) {
	wsDir := filepath.Join(config.WorkspacesDir(), ws)
	if quarantine == "" {
		if err := os.RemoveAll(wsDir); err != nil {
			log("Warning: could not remove the partially restored tree: " + err.Error())
		}
		return
	}
	if err := os.RemoveAll(wsDir); err != nil {
		log("Warning: could not clear the failed restore: " + err.Error())
		return
	}
	if err := os.Rename(quarantine, wsDir); err != nil {
		log(fmt.Sprintf("Warning: COULD NOT ROLL BACK — the original tree is still at %s: %v", quarantine, err))
		return
	}
	log("Rolled the workspace back to its pre-recovery state.")
}

// verifyRestoredTree gates everything that follows the file restore. restic
// exits 0 when --include matches nothing, so a silent no-op has to be caught
// here rather than surfacing later as a confusing container failure.
func verifyRestoredTree(ws string) (string, error) {
	wsDir := filepath.Join(config.WorkspacesDir(), ws)
	for _, required := range []string{"metadata.yaml", "deployment/docker-compose.yml", "secrets", "workspace"} {
		if _, err := os.Stat(filepath.Join(wsDir, required)); err != nil {
			return "", fmt.Errorf("restored tree is missing %s", required)
		}
	}

	metadata, err := config.GetWorkspaceMetadata(ws)
	if err != nil {
		return "", fmt.Errorf("restored metadata.yaml does not parse: %w", err)
	}
	// An empty GitopsSecret would make the readiness probe send "Bearer " and
	// gitops answer 401, which the probe counts as ready (<500) — the failure
	// would then surface much later as a puzzling deploy 401.
	if metadata.GitopsSecret == "" || metadata.GitopsURL == "" || metadata.Domain == "" {
		return "", fmt.Errorf("restored metadata.yaml is incomplete (needs domain, gitops-url and gitops-secret)")
	}

	// Recovering INTO a trashed state is never the intent.
	if marker, err := trashMarkerPath(ws); err == nil {
		if _, statErr := os.Stat(marker); statErr == nil {
			_ = os.Remove(marker)
			return "ok (cleared the restored trash marker)", nil
		}
	}
	return "ok", nil
}

// driverImageFromCompose reports the infra-driver image the restored compose
// pins. Recorded in the report because an older pin predates the Garage
// key self-heal fix, which explains dangling-key symptoms.
func driverImageFromCompose(ws string) string {
	path := filepath.Join(config.WorkspacesDir(), ws, "deployment", "docker-compose.yml")
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "image:") && strings.Contains(line, "infra-driver") {
			return strings.TrimSpace(strings.TrimPrefix(line, "image:"))
		}
	}
	return ""
}

func gitopsTailLogs(ws string) string {
	out, err := exec.Command("docker", "logs", "--tail", "50", ws+"-gitops").CombinedOutput()
	if err != nil {
		return ""
	}
	return "gitops logs:\n" + string(out)
}

// logWriter adapts the job's log function to io.Writer for the compose and
// deploy helpers, which stream their output.
type logWriter struct{ log func(string) }

func (w logWriter) Write(p []byte) (int, error) {
	for _, line := range strings.Split(strings.TrimRight(string(p), "\n"), "\n") {
		if strings.TrimSpace(line) != "" {
			w.log(line)
		}
	}
	return len(p), nil
}

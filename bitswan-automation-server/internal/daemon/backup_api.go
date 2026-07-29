package daemon

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
	"github.com/bitswan-space/bitswan-workspaces/internal/daemon/backup"
)

// Socket API for server-level backups (CLI + console data source). Reads are
// socket-trusted like the rest of the socket surface; anything that returns
// or mutates the encryption key demands the admin token — the socket is
// bind-mounted into every workspace's gitops/driver container, and the key
// decrypts backups that now contain workspace secrets (same rule as
// workspace-list passwords, #128).

// BackupStatusResponse is GET /backup/status — shaped close to gitops's old
// GET /backups/config so console/CLI rendering stays familiar.
type BackupStatusResponse struct {
	AOCConnected bool              `json:"aoc_connected"`
	Enabled      bool              `json:"enabled"`
	Configured   bool              `json:"configured"` // config file exists
	HasKey       bool              `json:"has_key"`
	KeyMirrored  *bool             `json:"key_mirrored,omitempty"` // nil = could not check
	Running      bool              `json:"running"`
	Retention    backup.Retention  `json:"retention"`
	Reason       string            `json:"reason,omitempty"` // why not runnable
	LastRun      *backup.RunReport `json:"last_run,omitempty"`
}

func (s *Server) backupStatus(ctx context.Context) BackupStatusResponse {
	cfg, exists, _ := backup.LoadConfig()
	resp := BackupStatusResponse{
		Enabled:    cfg.Enabled,
		Configured: exists,
		Retention:  cfg.Retention,
		Running:    s.backupEngine.Running(),
	}

	target, err := backup.LoadAOCTarget()
	if err != nil {
		resp.Reason = "server is not registered with an AOC"
	} else {
		resp.AOCConnected = true
	}

	key, _ := backup.LoadKey()
	resp.HasKey = key != ""

	if target != nil && resp.HasKey {
		checkCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		if mirrored, err := target.KeyMirrored(checkCtx); err == nil {
			resp.KeyMirrored = &mirrored
		}
	}

	if last, err := backup.LoadLastRun(); err == nil && last != nil {
		resp.LastRun = last
	}

	if resp.Reason == "" && !cfg.Enabled {
		resp.Reason = "backups explicitly disabled"
	}
	return resp
}

// handleBackup routes /backup/*.
func (s *Server) handleBackup(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/backup")
	path = strings.TrimSuffix(path, "/")

	switch {
	case path == "/status" && r.Method == http.MethodGet:
		writeJSON(w, s.backupStatus(r.Context()))

	case path == "/config" && r.Method == http.MethodGet:
		cfg, _, err := backup.LoadConfig()
		if err != nil {
			writeJSONError(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, cfg)

	case path == "/config" && r.Method == http.MethodPost:
		s.handleBackupConfigUpdate(w, r)

	case path == "/run" && r.Method == http.MethodPost:
		s.handleBackupRun(w, r)

	case path == "/snapshots" && r.Method == http.MethodGet:
		s.handleBackupSnapshots(w, r)

	case path == "/key" && r.Method == http.MethodGet:
		s.handleBackupKeyGet(w, r)

	case path == "/key/mirror":
		s.handleBackupKeyMirror(w, r)

	case path == "/restore" && r.Method == http.MethodPost:
		s.handleBackupRestore(w, r)

	case path == "/recover/workspace" && r.Method == http.MethodPost:
		s.handleBackupRecoverWorkspace(w, r)

	case path == "/fetch-snapshot" && r.Method == http.MethodPost:
		s.handleBackupFetchSnapshot(w, r)

	case path == "/offsite-snapshots" && r.Method == http.MethodGet:
		s.handleBackupOffsiteSnapshots(w, r)

	default:
		writeJSONError(w, "not found", http.StatusNotFound)
	}
}

// workspaceSecretOK verifies the caller presented workspace ws's gitops
// secret (X-Bitswan-Workspace-Secret). The socket peer alone proves nothing
// — every workspace container can reach it — so gitops-facing routes prove
// workspace identity with the secret only that workspace's env carries.
func workspaceSecretOK(r *http.Request, ws string) bool {
	presented := r.Header.Get("X-Bitswan-Workspace-Secret")
	if presented == "" {
		return false
	}
	metadata, err := config.GetWorkspaceMetadata(ws)
	if err != nil || metadata.GitopsSecret == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(presented), []byte(metadata.GitopsSecret)) == 1
}

// handleBackupRestore runs a targeted restore as a job (admin only —
// restores overwrite live data).
func (s *Server) handleBackupRestore(w http.ResponseWriter, r *http.Request) {
	if !s.callerHasAdminToken(r) {
		writeJSONError(w, "admin token required", http.StatusForbidden)
		return
	}
	var req struct {
		Type       string `json:"type"` // files | postgres | couchdb | garage
		Workspace  string `json:"workspace"`
		Stage      string `json:"stage"`
		SnapshotID string `json:"snapshot_id"`
		Mirror     bool   `json:"mirror"` // garage: sync (deletes extraneous) instead of copy
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.Workspace == "" {
		writeJSONError(w, "workspace is required", http.StatusBadRequest)
		return
	}
	if req.Stage == "" {
		req.Stage = "production"
	}

	var run func(ctx context.Context) (string, error)
	switch req.Type {
	case "files":
		run = func(ctx context.Context) (string, error) {
			dest, err := backup.RestoreWorkspaceFiles(ctx, req.Workspace, req.SnapshotID)
			if err != nil {
				return "", err
			}
			return "Files restored to " + dest + " (NOT applied to the live tree — see the restore runbook)", nil
		}
	case "postgres":
		run = func(ctx context.Context) (string, error) {
			return backup.RestorePostgres(ctx, req.Workspace, req.Stage, req.SnapshotID)
		}
	case "couchdb":
		run = func(ctx context.Context) (string, error) {
			return backup.RestoreCouchDB(ctx, req.Workspace, req.Stage, req.SnapshotID)
		}
	case "garage":
		run = func(ctx context.Context) (string, error) {
			return backup.RestoreGarage(ctx, req.Workspace, req.Stage, req.SnapshotID, req.Mirror)
		}
	default:
		writeJSONError(w, "type must be files, postgres, couchdb or garage", http.StatusBadRequest)
		return
	}

	job := GetJobManager().CreateJob("backup_restore_" + req.Type)
	job.SetState(JobStateRunning)
	go func() {
		defer func() {
			if rec := recover(); rec != nil {
				job.Complete(errAsErr(rec))
			}
		}()
		ctx, cancel := context.WithTimeout(context.Background(), backupRunTimeout)
		defer cancel()
		msg, err := run(ctx)
		if msg != "" {
			job.Log("info", msg)
		}
		job.Complete(err)
	}()

	w.WriteHeader(http.StatusAccepted)
	writeJSON(w, map[string]string{"job_id": job.ID})
}

// handleBackupRecoverWorkspace runs a full workspace recovery as a job. The
// most destructive route in the daemon: it replaces a workspace's entire tree
// and recreates every one of its containers.
func (s *Server) handleBackupRecoverWorkspace(w http.ResponseWriter, r *http.Request) {
	if !s.callerHasAdminToken(r) {
		writeJSONError(w, "admin token required", http.StatusForbidden)
		return
	}
	var req RecoverRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.Workspace == "" {
		writeJSONError(w, "workspace is required", http.StatusBadRequest)
		return
	}
	// The name becomes a path segment, a compose project and a restic tag.
	if strings.ContainsAny(req.Workspace, "/\\") || req.Workspace == ".." {
		writeJSONError(w, "invalid workspace name", http.StatusBadRequest)
		return
	}
	for _, stage := range req.Stages {
		switch stage {
		case "dev", "staging", "production":
		default:
			writeJSONError(w, "unknown stage "+stage, http.StatusBadRequest)
			return
		}
	}
	// Leaving the containers up while replacing the tree under them means
	// gitops keeps writing into the quarantined directory — silent divergence
	// with no error anywhere.
	if req.SkipContainers && !req.SkipFiles {
		writeJSONError(w,
			"--skip-containers requires --skip-files: replacing the tree while the containers keep running "+
				"leaves them bound to the old directory", http.StatusBadRequest)
		return
	}

	wsDir := filepath.Join(config.WorkspacesDir(), req.Workspace)
	if _, err := os.Stat(wsDir); err == nil && !req.Force && !req.DryRun {
		writeJSONError(w, fmt.Sprintf(
			"workspace %q already exists on this server — pass force to replace it "+
				"(this destroys its current tree and containers)", req.Workspace), http.StatusBadRequest)
		return
	}

	// A recovery reads the same restic repo and rewrites the very trees a
	// backup run captures, so the two must not overlap in either direction.
	if err := beginRecovery(req.Workspace); err != nil {
		writeJSONError(w, err.Error(), http.StatusConflict)
		return
	}
	if !req.DryRun {
		if err := s.backupEngine.TryReserve("recovering workspace " + req.Workspace); err != nil {
			endRecovery(req.Workspace)
			writeJSONError(w, "a backup run is in progress — retry when it finishes", http.StatusConflict)
			return
		}
	}

	job := GetJobManager().CreateJob("backup_recover_workspace")
	job.SetState(JobStateRunning)
	go func() {
		defer endRecovery(req.Workspace)
		if !req.DryRun {
			defer s.backupEngine.Release()
		}
		defer func() {
			if rec := recover(); rec != nil {
				job.Complete(errAsErr(rec))
			}
		}()
		ctx, cancel := context.WithTimeout(context.Background(), backupRunTimeout)
		defer cancel()

		report, err := s.recoverWorkspace(ctx, req, func(line string) { job.Log("info", line) })
		if err == nil && report != nil && !report.OK {
			err = &backupRunError{"recovery finished with errors (see the step list above)"}
		}
		job.Complete(err)
	}()

	w.WriteHeader(http.StatusAccepted)
	writeJSON(w, map[string]string{"job_id": job.ID})
}

// handleBackupFetchSnapshot restores a pruned per-BP snapshot back onto the
// shared volume for DR rehearsal. Called by gitops (workspace-secret auth);
// synchronous — gitops runs it inside its own task machinery.
func (s *Server) handleBackupFetchSnapshot(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Workspace  string `json:"workspace"`
		BP         string `json:"bp"`
		Stage      string `json:"stage"`
		SnapshotID string `json:"snapshot_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.Workspace == "" || req.BP == "" || req.Stage == "" || req.SnapshotID == "" {
		writeJSONError(w, "workspace, bp, stage and snapshot_id are all required", http.StatusBadRequest)
		return
	}
	// Path traversal guard: each field becomes one path segment.
	for _, field := range []string{req.Workspace, req.BP, req.Stage, req.SnapshotID} {
		if strings.ContainsAny(field, "/\\") || field == ".." {
			writeJSONError(w, "invalid path component", http.StatusBadRequest)
			return
		}
	}
	if !workspaceSecretOK(r, req.Workspace) {
		writeJSONError(w, "workspace secret required", http.StatusForbidden)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
	defer cancel()
	if err := backup.FetchSnapshot(ctx, req.Workspace, req.BP, req.Stage, req.SnapshotID); err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]bool{"fetched": true})
}

// handleBackupOffsiteSnapshots lists a BP's snapshots present in the nightly
// captures (gitops's "remote-only" listing source; workspace-secret auth).
func (s *Server) handleBackupOffsiteSnapshots(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	ws, bp, stage := query.Get("workspace"), query.Get("bp"), query.Get("stage")
	if ws == "" || bp == "" || stage == "" {
		writeJSONError(w, "workspace, bp and stage are all required", http.StatusBadRequest)
		return
	}
	if !workspaceSecretOK(r, ws) {
		writeJSONError(w, "workspace secret required", http.StatusForbidden)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	refs, err := backup.ListOffsiteSnapshots(ctx, ws, bp, stage)
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if refs == nil {
		refs = []backup.OffsiteSnapshotRef{}
	}
	writeJSON(w, map[string]interface{}{"snapshots": refs})
}

func (s *Server) handleBackupConfigUpdate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Enabled          *bool `json:"enabled"`
		RetentionDaily   *int  `json:"retention_daily"`
		RetentionMonthly *int  `json:"retention_monthly"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}
	cfg, _, err := backup.LoadConfig()
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if req.Enabled != nil {
		cfg.Enabled = *req.Enabled
	}
	if req.RetentionDaily != nil {
		if *req.RetentionDaily < 1 {
			writeJSONError(w, "retention_daily must be >= 1", http.StatusBadRequest)
			return
		}
		cfg.Retention.Daily = *req.RetentionDaily
	}
	if req.RetentionMonthly != nil {
		if *req.RetentionMonthly < 0 {
			writeJSONError(w, "retention_monthly must be >= 0", http.StatusBadRequest)
			return
		}
		cfg.Retention.Monthly = *req.RetentionMonthly
	}
	if err := backup.SaveConfig(cfg); err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, cfg)
}

// handleBackupRun starts a run as a job (409 when one is in flight); the
// caller streams progress through the existing /jobs endpoints.
func (s *Server) handleBackupRun(w http.ResponseWriter, r *http.Request) {
	if s.backupEngine.Running() {
		writeJSONError(w, "a backup run is already in progress", http.StatusConflict)
		return
	}

	job := GetJobManager().CreateJob("backup_run")
	job.SetState(JobStateRunning)
	go func() {
		defer func() {
			if rec := recover(); rec != nil {
				job.Complete(errAsErr(rec))
			}
		}()
		ctx, cancel := context.WithTimeout(context.Background(), backupRunTimeout)
		defer cancel()
		report, err := s.backupEngine.RunAll(ctx, func(line string) {
			job.Log("info", line)
		})
		if err == nil && report != nil && !report.OK {
			err = errBackupHadErrors
		}
		job.Complete(err)
	}()

	w.WriteHeader(http.StatusAccepted)
	writeJSON(w, map[string]string{"job_id": job.ID})
}

var errBackupHadErrors = &backupRunError{"backup run finished with errors (see last_run for details)"}

type backupRunError struct{ msg string }

func (e *backupRunError) Error() string { return e.msg }

func errAsErr(rec interface{}) error {
	if err, ok := rec.(error); ok {
		return err
	}
	return &backupRunError{msg: "panic in backup run"}
}

func (s *Server) handleBackupSnapshots(w http.ResponseWriter, r *http.Request) {
	// Snapshot listings expose every workspace's paths — admin only (the
	// socket is workspace-reachable).
	if !s.callerHasAdminToken(r) {
		writeJSONError(w, "admin token required", http.StatusForbidden)
		return
	}
	var tags []string
	if ws := r.URL.Query().Get("workspace"); ws != "" {
		tags = append(tags, "ws:"+ws)
	}
	if tag := r.URL.Query().Get("tag"); tag != "" {
		tags = append(tags, tag)
	}
	raw, err := backup.Snapshots(r.Context(), tags...)
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(raw)
}

func (s *Server) handleBackupKeyGet(w http.ResponseWriter, r *http.Request) {
	if !s.callerHasAdminToken(r) {
		writeJSONError(w, "admin token required", http.StatusForbidden)
		return
	}
	key, err := backup.LoadKey()
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if key == "" {
		writeJSONError(w, "no backup key exists", http.StatusNotFound)
		return
	}
	writeJSON(w, map[string]string{"key": key})
}

func (s *Server) handleBackupKeyMirror(w http.ResponseWriter, r *http.Request) {
	target, err := backup.LoadAOCTarget()
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusServiceUnavailable)
		return
	}

	switch r.Method {
	case http.MethodGet:
		mirrored, err := target.KeyMirrored(r.Context())
		if err != nil {
			writeJSONError(w, err.Error(), http.StatusBadGateway)
			return
		}
		writeJSON(w, map[string]bool{"mirrored": mirrored})

	case http.MethodPost:
		if !s.callerHasAdminToken(r) {
			writeJSONError(w, "admin token required", http.StatusForbidden)
			return
		}
		key, err := backup.LoadKey()
		if err != nil || key == "" {
			writeJSONError(w, "no backup key exists", http.StatusNotFound)
			return
		}
		if err := target.MirrorKey(r.Context(), key); err != nil {
			writeJSONError(w, err.Error(), http.StatusBadGateway)
			return
		}
		writeJSON(w, map[string]bool{"mirrored": true})

	case http.MethodDelete:
		if !s.callerHasAdminToken(r) {
			writeJSONError(w, "admin token required", http.StatusForbidden)
			return
		}
		if err := target.DeleteMirroredKey(r.Context()); err != nil {
			writeJSONError(w, err.Error(), http.StatusBadGateway)
			return
		}
		writeJSON(w, map[string]bool{"mirrored": false})

	default:
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

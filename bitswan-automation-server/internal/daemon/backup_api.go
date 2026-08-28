package daemon

import (
	"context"
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
	AOCConnected    bool             `json:"aoc_connected"`
	Enabled         bool             `json:"enabled"`
	Configured      bool             `json:"configured"` // config file exists
	HasKey          bool             `json:"has_key"`
	KeyAcknowledged bool             `json:"key_acknowledged"`
	KeyWarning      string           `json:"key_warning,omitempty"` // set while the key is unsaved
	Running         bool             `json:"running"`
	Retention       backup.Retention `json:"retention"`
	// Images reports whether each run also archives the built business-process
	// images. On by default and worth surfacing: it is the difference between a
	// backup that restores the bytes that were running and one that has gitops
	// rebuild them, and it is the largest single thing in the repo.
	Images bool   `json:"images"`
	Reason string `json:"reason,omitempty"` // why not runnable
	// ServerRecoveryUntil is set while a whole-server recovery holds the marker
	// that stands the AOC list sync and the catch-up backup down. Reported so an
	// abandoned marker is visible: both of those go quiet without saying why.
	ServerRecoveryUntil *time.Time        `json:"server_recovery_until,omitempty"`
	LastRun             *backup.RunReport `json:"last_run,omitempty"`
}

func (s *Server) backupStatus(ctx context.Context) BackupStatusResponse {
	cfg, exists, _ := backup.LoadConfig()
	resp := BackupStatusResponse{
		Enabled:    cfg.Enabled,
		Configured: exists,
		Retention:  cfg.Retention,
		Images:     cfg.Images,
		Running:    s.backupEngine.Running(),
	}

	if _, err := backup.LoadAOCTarget(); err != nil {
		resp.Reason = "server is not registered with an AOC"
	} else {
		resp.AOCConnected = true
	}

	key, _ := backup.LoadKey()
	resp.HasKey = key != ""
	resp.KeyAcknowledged = backup.KeyAcknowledged()
	resp.KeyWarning = backup.UnsavedKeyWarning()

	if deadline := ServerRecoveryDeadline(); !deadline.IsZero() {
		resp.ServerRecoveryUntil = &deadline
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

	case path == "/manifest" && r.Method == http.MethodGet:
		s.handleBackupManifest(w, r)

	case path == "/key" && r.Method == http.MethodGet:
		s.handleBackupKeyGet(w, r)

	case path == "/key/acknowledge" && r.Method == http.MethodPost:
		s.handleBackupKeyAcknowledge(w, r)

	case path == "/restore" && r.Method == http.MethodPost:
		s.handleBackupRestore(w, r)

	case path == "/recover/workspace" && r.Method == http.MethodPost:
		s.handleBackupRecoverWorkspace(w, r)

	case path == "/recover/server/begin" && r.Method == http.MethodPost:
		s.handleServerRecoveryMark(w, r, true)

	case path == "/recover/server/end" && r.Method == http.MethodPost:
		s.handleServerRecoveryMark(w, r, false)

	default:
		writeJSONError(w, "not found", http.StatusNotFound)
	}
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

func (s *Server) handleBackupConfigUpdate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Enabled          *bool `json:"enabled"`
		Images           *bool `json:"images"`
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
	if req.Images != nil {
		cfg.Images = *req.Images
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

// handleServerRecoveryMark opens and closes the whole-server recovery window.
//
// `bitswan recover server` holds this from the moment the daemon comes up until
// the last workspace is done. While it is set, the AOC list sync is suppressed
// (it would report a half-restored server and the AOC deletes anything
// unreported, taking Keycloak clients and MQTT topics with it) and so is the
// scheduler's catch-up backup, which would otherwise make a half-restored server
// the newest recovery point.
//
// Admin-gated like the rest of the recovery surface: the socket is
// workspace-reachable, and a workspace must not be able to disable the sync.
func (s *Server) handleServerRecoveryMark(w http.ResponseWriter, r *http.Request, begin bool) {
	if !s.callerHasAdminToken(r) {
		writeJSONError(w, "admin token required", http.StatusForbidden)
		return
	}
	if begin {
		beginServerRecovery()
	} else {
		endServerRecovery()
	}
	writeJSON(w, map[string]bool{"server_recovery_in_progress": serverRecoveryInProgress()})
}

// handleBackupManifest reads the server manifest out of a snapshot — what this
// server WAS at backup time. Admin only: it lists every workspace and the
// server's identity.
//
// Reading it here, on a live server, is the same operation a disaster recovery
// performs first on a bare machine; the difference is only where restic runs.
func (s *Server) handleBackupManifest(w http.ResponseWriter, r *http.Request) {
	if !s.callerHasAdminToken(r) {
		writeJSONError(w, "admin token required", http.StatusForbidden)
		return
	}
	target, err := backup.LoadAOCTarget()
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	key, err := backup.LoadKey()
	if err != nil || key == "" {
		writeJSONError(w, "no backup key exists yet", http.StatusNotFound)
		return
	}
	manifest, err := backup.ReadServerManifest(
		r.Context(), backup.NewRestic(target, key), r.URL.Query().Get("snapshot"))
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]interface{}{
		"manifest": manifest,
		// The recovery would run on THIS binary, so report the skew the same
		// way a recovery does rather than leaving the caller to compare.
		"version_warning": backup.CheckVersionSkew(manifest, s.version),
	})
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

func (s *Server) handleBackupKeyAcknowledge(w http.ResponseWriter, r *http.Request) {
	if !s.callerHasAdminToken(r) {
		writeJSONError(w, "admin token required", http.StatusForbidden)
		return
	}
	key, err := backup.LoadKey()
	if err != nil || key == "" {
		writeJSONError(w, "no backup key exists yet", http.StatusNotFound)
		return
	}
	if err := backup.AcknowledgeKey(); err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]bool{"acknowledged": true})
}

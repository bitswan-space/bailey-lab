package daemon

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

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

	default:
		writeJSONError(w, "not found", http.StatusNotFound)
	}
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

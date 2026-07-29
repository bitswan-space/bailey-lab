package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/bitswan-space/bitswan-workspaces/internal/daemon/backup"
)

// Bailey admin /backups endpoints — the console surface for server-level
// backups. All of these sit inside bailey_dispatch's isAdmin gate (the gate
// verified the admin's session/device; unlike the socket API no extra token
// is needed — the key download here is the deliberate admin escape hatch).
//
//   GET    /bailey/api/admin/backups              status + last-run breakdown
//   POST   /bailey/api/admin/backups/run          start a run (409 while running)
//   POST   /bailey/api/admin/backups/retention    {"daily":30,"monthly":12}
//   POST   /bailey/api/admin/backups/enabled      {"enabled":true|false}
//   GET    /bailey/api/admin/backups/key          the restic encryption key
//   POST   /bailey/api/admin/backups/key/acknowledge  confirm the key is saved
//
// Run progress is followed by polling GET .../backups (running flips false,
// last_run carries the outcome) — the same poll-until-done shape the old
// dashboard card used.

func (s *Server) handleAdminBackupsStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.backupStatus(r.Context()))
}

func (s *Server) handleAdminBackupsRun(w http.ResponseWriter, r *http.Request, by string) {
	if s.backupEngine.Running() {
		writeJSONError(w, "a backup run is already in progress", http.StatusConflict)
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), backupRunTimeout)
		defer cancel()
		if _, err := s.backupEngine.RunAll(ctx, func(line string) {
			fmt.Println("[backup] " + line)
		}); err != nil {
			fmt.Printf("Warning: console-triggered backup run (by %s) failed: %v\n", by, err)
		}
	}()
	w.WriteHeader(http.StatusAccepted)
	writeJSON(w, map[string]bool{"started": true})
}

func (s *Server) handleAdminBackupsRetention(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Daily   int `json:"daily"`
		Monthly int `json:"monthly"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "bad request", http.StatusBadRequest)
		return
	}
	if req.Daily < 1 || req.Monthly < 0 {
		writeJSONError(w, "daily must be >= 1 and monthly >= 0", http.StatusBadRequest)
		return
	}
	cfg, _, err := backup.LoadConfig()
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	cfg.Retention = backup.Retention{Daily: req.Daily, Monthly: req.Monthly}
	if err := backup.SaveConfig(cfg); err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, cfg)
}

func (s *Server) handleAdminBackupsEnabled(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "bad request", http.StatusBadRequest)
		return
	}
	cfg, _, err := backup.LoadConfig()
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	cfg.Enabled = req.Enabled
	if err := backup.SaveConfig(cfg); err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, cfg)
}

func (s *Server) handleAdminBackupsKey(w http.ResponseWriter, r *http.Request) {
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

// handleAdminBackupsKeyAcknowledge records that an admin has saved the key off
// this server. There is no escrow, so this acknowledgement is the only signal
// that the key exists anywhere but here.
func (s *Server) handleAdminBackupsKeyAcknowledge(w http.ResponseWriter, r *http.Request) {
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

package daemon

import (
	"encoding/json"
	"net/http"
)

// handleAdminUpdates powers the admin "Updates" view and its nav notification
// bubble: which components on this server are behind the latest on their track.
// Admin-only (gated by the dispatcher).
//
// Workspace updates are appliable from the GUI (the daemon can pull those
// containers). The server's own binary is NOT — the daemon runs from a
// read-only bind-mount of the host binary and can't replace itself — so we
// report availability + the host-side CLI to apply it (`bitswan self-update`).
func (s *Server) handleAdminUpdates(w http.ResponseWriter, r *http.Request) {
	server := detectServerVersion(s.version)

	type wsUpdate struct {
		Name     string            `json:"name"`
		Versions workspaceVersions `json:"versions"`
	}
	updates := []wsUpdate{}
	if full, err := GetWorkspaceList(false, false); err == nil && full != nil {
		for _, ws := range full.Workspaces {
			wv := detectWorkspaceVersions(ws.Name)
			if wv.UpdateAvailable {
				updates = append(updates, wsUpdate{Name: ws.Name, Versions: wv})
			}
		}
	}

	count := len(updates)
	if server.UpdateAvailable {
		count++
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"server":            server,
		"workspaces":        updates,
		"count":             count,
		"server_update_cmd": "bitswan self-update",
	})
}

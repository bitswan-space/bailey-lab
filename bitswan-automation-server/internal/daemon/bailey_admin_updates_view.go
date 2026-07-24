package daemon

import (
	"encoding/json"
	"net/http"
)

// handleAdminUpdates powers the admin "Updates" view and its nav notification
// bubble: which components on this server are behind the latest on their track.
// Admin-only (gated by the dispatcher).
//
// Both workspace updates and the server's own binary are appliable from the
// GUI: workspace updates pull new containers, and the server self-update writes
// the new binary to the host and recreates the daemon container (POST
// /bailey/api/admin/server-update). We also surface the host-side
// `bitswan self-update` command as an alternative for operators.
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

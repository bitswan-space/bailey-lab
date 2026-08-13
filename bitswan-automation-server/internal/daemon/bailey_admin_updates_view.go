package daemon

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
)

// handleAdminUpdates powers the admin "Updates" view and its nav notification
// bubble: which components on this server are behind the latest on their track.
// Admin-only (gated by the dispatcher).
//
// Both workspace updates and the server's own binary are appliable from the
// GUI: workspace updates pull new containers, and the server self-update writes
// the new binary to the host and recreates the daemon container (POST
// /bailey/api/admin/server-update). The response also carries the version
// ledger (who/when/which version) that backs the Updates-page audit log and its
// bounded (updateRollbackDepth) rollback controls.
//
// Being an admin is NOT the same as being able to apply a workspace update:
// handleUpgradeWorkspace and handleBaileyWorkspaceRollback are owner-gated, so
// an admin who doesn't own a workspace gets a 403 back. Issue #367 — the view
// used to offer every stale workspace to every admin, which turned the Update
// button into a guaranteed "only the workspace owner can update it" toast. Each
// row therefore carries the caller's own capability (can_update / can_rollback,
// resolved with the SAME helper the write handlers enforce) and the badge count
// only counts what this caller can actually apply.
func (s *Server) handleAdminUpdates(w http.ResponseWriter, r *http.Request) {
	server := detectServerVersion(s.version)

	email, groups := identityFromHeaders(r)
	serverOwner, _ := callerIsServerOwner(email, r)
	sc, _ := config.NewAutomationServerConfig().LoadConfig()
	domain := ""
	if sc != nil {
		domain = sc.ProtectedHostnameDomain()
	}
	// The caller's role is resolved once per workspace and reused for that
	// workspace's history rows, so one Updates render costs one ACL lookup per
	// workspace rather than one per row.
	roleCache := map[string]endpointRole{}
	callerRole := func(name string) endpointRole {
		key := strings.ToLower(name)
		if v, ok := roleCache[key]; ok {
			return v
		}
		v := roleNone
		if domain != "" {
			v = workspaceRoleFor(name, domain, email, groups)
		}
		roleCache[key] = v
		return v
	}
	// Mirrors callerOwnsWorkspace — the check handleUpgradeWorkspace and
	// handleBaileyWorkspaceRollback actually enforce.
	callerOwns := func(name string) bool { return serverOwner || callerRole(name) == roleOwner }

	type wsUpdate struct {
		Name      string            `json:"name"`
		Versions  workspaceVersions `json:"versions"`
		Owner     string            `json:"owner,omitempty"`
		CanUpdate bool              `json:"can_update"`
	}
	updates := []wsUpdate{}
	actionable := 0
	if full, err := GetWorkspaceList(false, false); err == nil && full != nil {
		for _, ws := range full.Workspaces {
			wv := detectWorkspaceVersions(ws.Name)
			if !wv.UpdateAvailable {
				continue
			}
			can := callerOwns(ws.Name)
			// Don't list workspaces the caller has no relationship with at all —
			// the same visibility rule handleListAccessibleWorkspaces applies.
			if !can && callerRole(ws.Name) == roleNone {
				continue
			}
			if can {
				actionable++
			}
			updates = append(updates, wsUpdate{
				Name:      ws.Name,
				Versions:  wv,
				Owner:     workspaceOwnerEmail(ws.Name+"-dashboard."+domain, ws.Name+"-gitops."+domain),
				CanUpdate: can,
			})
		}
	}

	// The nav bubble is a call to action, so it counts only what this caller can
	// actually apply. The server binary is admin-gated, not owner-gated.
	count := actionable
	if server.UpdateAvailable {
		count++
	}

	// Version ledger: the last updateRollbackDepth rows per target, newest first.
	// Backs the audit log (who/when/which version) and the rollback controls. The
	// Artifact field is json:"-", so restorable-state paths never reach the client.
	type historyRow struct {
		updateHistoryEntry
		CanRollback bool `json:"can_rollback"`
	}
	raw, _ := dbListRecentUpdateHistory(updateRollbackDepth)
	history := []historyRow{}
	for _, h := range raw {
		// Server rollbacks are admin-gated (handleAdminServerRollback), workspace
		// rollbacks owner-gated (handleBaileyWorkspaceRollback).
		can := h.TargetKind == updateTargetServer || callerOwns(h.TargetName)
		history = append(history, historyRow{updateHistoryEntry: h, CanRollback: can})
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"server":         server,
		"workspaces":     updates,
		"count":          count,
		"history":        history,
		"rollback_depth": updateRollbackDepth,
	})
}

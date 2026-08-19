package daemon

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/workspace"
)

// Rollback endpoints for the Updates page. Both are bounded to the 3-deep window
// (updateHistoryRollbackTarget rejects anything older): the UI only ever offers
// the retained rows, and the server re-checks here so a stale/forged id can't
// reach beyond what's kept.

// rollbackIDFromRequest parses {"id": <n>} from a JSON body.
func rollbackIDFromRequest(r *http.Request) (int64, bool) {
	var body struct {
		ID int64 `json:"id"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&body); err != nil {
		return 0, false
	}
	return body.ID, body.ID > 0
}

// handleAdminServerRollback restores a retained previous server binary and
// restarts the daemon onto it — the browser equivalent of a bounded
// `self-update --rollback`. NDJSON progress, same restart dance as the update.
// Admin-only (gated by the dispatcher).
func (s *Server) handleAdminServerRollback(w http.ResponseWriter, r *http.Request) {
	actor, _ := identityFromHeaders(r)
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	var mu sync.Mutex
	emit := func(m map[string]any) {
		mu.Lock()
		defer mu.Unlock()
		line, _ := json.Marshal(m)
		_, _ = w.Write(append(line, '\n'))
		if flusher != nil {
			flusher.Flush()
		}
	}
	fail := func(msg string) { emit(map[string]any{"event": "error", "error": msg}) }

	// Serialise with self-update: a rollback and an update must not race on the
	// binary swap.
	if !s.serverUpdateMu.TryLock() {
		fail("a server update is already in progress")
		return
	}
	defer s.serverUpdateMu.Unlock()

	id, ok := rollbackIDFromRequest(r)
	if !ok {
		fail("a valid version id is required")
		return
	}
	target, err := updateHistoryRollbackTarget(id)
	if err != nil {
		fail("could not read the version history: " + err.Error())
		return
	}
	if target == nil || target.TargetKind != updateTargetServer {
		fail("that version is no longer available to roll back to — only the last 3 are kept")
		return
	}

	emit(map[string]any{"event": "progress", "fraction": 0.1, "message": "Loading the saved binary…"})
	// Read the target binary into memory BEFORE recording (recording prunes the
	// window and may delete this artifact file — we already hold the bytes).
	targetBytes, err := os.ReadFile(target.Artifact)
	if err != nil || len(targetBytes) == 0 {
		fail("the saved binary for that version is missing — it may have aged out of the 3-version window")
		return
	}

	binPath := hostBinaryPath()
	dir := filepath.Dir(binPath)
	currentBytes, _ := os.ReadFile(binPath)
	currentVer := detectServerVersion(s.version).Current

	// Record the rollback (saves the CURRENT binary as the new row's artifact so
	// the ledger + window stay consistent and the rollback is itself reversible).
	if len(currentBytes) > 0 {
		if _, herr := recordServerUpdate(actor, currentVer, target.FromVersion, currentBytes, true); herr != nil {
			emit(map[string]any{"event": "progress", "fraction": 0.4, "message": "History record failed (continuing): " + herr.Error()})
		}
		_ = os.WriteFile(binPath+".bak", currentBytes, 0o755)
	}

	// Stage the target binary and validate it runs before swapping.
	emit(map[string]any{"event": "progress", "fraction": 0.6, "message": "Verifying the saved binary…"})
	tmp, err := os.CreateTemp(dir, ".bitswan-rollback-*")
	if err != nil {
		fail("cannot write to " + dir + ": " + err.Error())
		return
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(targetBytes); err != nil {
		tmp.Close()
		_ = os.Remove(tmpPath)
		fail("write failed: " + err.Error())
		return
	}
	tmp.Close()
	if err := os.Chmod(tmpPath, 0o755); err != nil {
		_ = os.Remove(tmpPath)
		fail("chmod failed: " + err.Error())
		return
	}

	emit(map[string]any{"event": "progress", "fraction": 0.8, "message": "Restoring version " + target.FromVersion + "…"})
	if err := os.Rename(tmpPath, binPath); err != nil {
		_ = os.Remove(tmpPath)
		fail("install failed (could not replace " + binPath + "): " + err.Error())
		return
	}

	emit(map[string]any{"event": "restarting", "fraction": 0.95,
		"message": "Restarting the server on " + target.FromVersion + "…", "version": target.FromVersion})
	go func() {
		time.Sleep(1200 * time.Millisecond)
		_ = exec.Command("docker", "restart", daemonContainerName).Run()
	}()
}

// handleBaileyWorkspaceRollback restores a retained previous docker-compose for a
// workspace and recreates its site containers. Owner-only (mirrors the update
// path). NDJSON progress like the workspace update.
func (s *Server) handleBaileyWorkspaceRollback(w http.ResponseWriter, r *http.Request, email, workspaceName string) {
	if !nameRe.MatchString(workspaceName) {
		writeJSONError(w, "invalid workspace name", http.StatusBadRequest)
		return
	}
	_, groups := identityFromHeaders(r)
	if !callerOwnsWorkspace(email, groups, workspaceName) {
		writeJSONError(w, "only the workspace owner can roll it back", http.StatusForbidden)
		return
	}
	id, ok := rollbackIDFromRequest(r)
	if !ok {
		writeJSONError(w, "a valid version id is required", http.StatusBadRequest)
		return
	}
	target, err := updateHistoryRollbackTarget(id)
	if err != nil {
		writeJSONError(w, "could not read the version history: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if target == nil || target.TargetKind != updateTargetWorkspace || !strings.EqualFold(target.TargetName, workspaceName) {
		writeJSONError(w, "that version is no longer available to roll back to — only the last 3 are kept", http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	var mu sync.Mutex
	writeEvent := func(m map[string]any) {
		mu.Lock()
		defer mu.Unlock()
		line, _ := json.Marshal(m)
		_, _ = w.Write(append(line, '\n'))
		if flusher != nil {
			flusher.Flush()
		}
	}

	writeEvent(map[string]any{"event": "start", "fraction": 0, "message": "Rolling back " + workspaceName + "…"})
	fromVer := detectWorkspaceVersions(workspaceName).Gitops
	// Snapshot the current compose as the new rollback row's artifact so the
	// rollback is itself reversible within the window.
	currentCompose, _ := os.ReadFile(workspace.SiteComposePath(workspaceName))
	if _, herr := recordWorkspaceUpdate(email, workspaceName, fromVer, target.FromVersion, string(currentCompose), true); herr != nil {
		writeEvent(map[string]any{"event": "progress", "fraction": 0.2, "message": "History record failed (continuing): " + herr.Error()})
	}

	writeEvent(map[string]any{"event": "progress", "fraction": 0.4, "message": "Restoring version " + target.FromVersion + "…"})
	if err := workspace.RestoreWorkspaceComposeAndRedeploy(workspaceName, target.Artifact); err != nil {
		writeEvent(map[string]any{"event": "error", "error": err.Error()})
		return
	}
	writeEvent(map[string]any{"event": "done", "fraction": 1, "message": "Rolled back to " + target.FromVersion + "."})
}

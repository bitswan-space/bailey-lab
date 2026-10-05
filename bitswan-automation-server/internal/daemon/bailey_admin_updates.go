package daemon

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
	"github.com/bitswan-space/bitswan-workspaces/internal/images"
)

// Bailey admin /updates endpoints.
//
// Three classes of operation:
//
//   1. Read the configured default images + suggest tags from Docker
//      Hub for the admin UI dropdown.
//      GET /bailey/api/admin/default-images
//
//   2. Write the default images (free-form string — the UI offers a
//      dropdown of suggestions but anything goes, including custom
//      dev tags like bitswan/gitops:bailey-dev).
//      POST /bailey/api/admin/default-images
//        body: {"gitops_image":"...", "dashboard_image":"..."}
//        empty string clears the setting (the image is resolved from the
//        AOC's registry at next workspace init).
//
//   3. Update a single workspace's running containers in place
//      (pulls new image + recreates the affected service). Owner-only
//      since it disrupts the workspace's deploys.
//      POST /bailey/api/workspaces/<name>/update

// imageSettingResponse is one row in the GET /default-images payload.
// suggestions are the builds the AOC's registry holds, newest first; current
// is the effective value (server_settings override, or what workspace_init
// would resolve).
type imageSettingResponse struct {
	Key         string         `json:"key"`
	Configured  *settingRecord `json:"configured,omitempty"`
	Effective   string         `json:"effective"`
	Suggestions []imageTag     `json:"suggestions,omitempty"`
}

type imageTag struct {
	Name string `json:"name"`
}

// fetchRegistryTags returns the builds of a repository, newest first.
//
// Best-effort: a registry this server cannot reach returns the error so the
// caller still renders the configured and effective values, just without
// anything to choose from.
func fetchRegistryTags(repo string, max int) ([]imageTag, error) {
	registry, err := images.Registry()
	if err != nil {
		return nil, err
	}
	tags, err := registry.Tags(repo)
	if err != nil {
		return nil, err
	}
	if len(tags) > max {
		tags = tags[:max]
	}
	out := make([]imageTag, 0, len(tags))
	for _, tag := range tags {
		out = append(out, imageTag{Name: registry.Reference(repo, tag)})
	}
	return out, nil
}

// imageKindToRepo maps the well-known setting key to the registry
// repository the UI should fetch tag suggestions from. Centralised so
// the same mapping is used by GET (suggestions) and POST (validation
// — currently free-form so we don't reject, but kept for future use).
var imageKindToRepo = map[string]string{
	settingDefaultGitopsImage:    "bitswan/gitops",
	settingDefaultDashboardImage: "bitswan/workspace-dashboard",
}

// handleAdminDefaultImagesGet returns the configured defaults +
// dropdown suggestions for both gitops and dashboard images.
func (s *Server) handleAdminDefaultImagesGet(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{}
	for _, key := range []string{settingDefaultGitopsImage, settingDefaultDashboardImage} {
		entry := imageSettingResponse{Key: key}
		if rec, _ := dbGetSettingRecord(key); rec != nil {
			entry.Configured = rec
			entry.Effective = rec.Value
		} else {
			// Fall back to what workspace_init would pick if the admin
			// hadn't set anything — surface it so the UI can show "(default
			// from Docker Hub: <tag>)" instead of just blank.
			switch key {
			case settingDefaultGitopsImage:
				if img, err := images.ResolveGitopsImage(false, false); err == nil {
					entry.Effective = img
				}
			case settingDefaultDashboardImage:
				if img, err := images.ResolveDashboardImage(false, false); err == nil {
					entry.Effective = img
				}
			}
		}
		if repo, ok := imageKindToRepo[key]; ok {
			if tags, err := fetchRegistryTags(repo, 20); err == nil {
				entry.Suggestions = tags
			}
		}
		out[key] = entry
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

// setDefaultImagesRequest is the POST body. Each field is OPTIONAL:
// missing keys leave the setting alone, empty strings clear it.
type setDefaultImagesRequest struct {
	GitopsImage    *string `json:"gitops_image,omitempty"`
	DashboardImage *string `json:"dashboard_image,omitempty"`
}

// handleAdminDefaultImagesPost persists the admin's chosen image
// strings. No validation: free-form, by design — the admin is
// trusted to set whatever they want (custom tags, private registry
// paths, etc.). Setting an empty string clears the override.
func (s *Server) handleAdminDefaultImagesPost(w http.ResponseWriter, r *http.Request, email string) {
	var req setDefaultImagesRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}
	apply := func(key string, val *string) error {
		if val == nil {
			return nil
		}
		v := strings.TrimSpace(*val)
		if v == "" {
			return dbDeleteSetting(key)
		}
		return dbSetSetting(key, v, email)
	}
	if err := apply(settingDefaultGitopsImage, req.GitopsImage); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusInternalServerError)
		return
	}
	if err := apply(settingDefaultDashboardImage, req.DashboardImage); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

// handleUpdateWorkspace pulls the current default images + recreates
// the workspace's gitops + dashboard containers in place. Owner-only
// since this restarts running automations. Returns an NDJSON stream
// of progress events identical to the create flow.
func (s *Server) handleUpdateWorkspace(w http.ResponseWriter, r *http.Request, email, workspaceName string) {
	// Defence-in-depth path-traversal guard (see handleTrashWorkspace).
	if !nameRe.MatchString(workspaceName) {
		http.Error(w, `{"error":"invalid workspace name"}`, http.StatusBadRequest)
		return
	}
	_, groups := identityFromHeaders(r)
	if !callerOwnsWorkspace(email, groups, workspaceName) {
		http.Error(w, `{"error":"only the workspace owner can update it"}`, http.StatusForbidden)
		return
	}

	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	writeMu := sync.Mutex{}
	writeEvent := func(payload map[string]any) {
		writeMu.Lock()
		defer writeMu.Unlock()
		line, _ := json.Marshal(payload)
		_, _ = w.Write(append(line, '\n'))
		if flusher != nil {
			flusher.Flush()
		}
	}
	writeEvent(map[string]any{"event": "start", "message": "Updating " + workspaceName + "…"})

	homeDir, err := config.GetRealUserHomeDir()
	if err != nil {
		homeDir = os.Getenv("HOME")
	}
	deploymentDir := filepath.Join(homeDir, ".config", "bitswan", "workspaces", workspaceName, "deployment")
	if _, err := os.Stat(deploymentDir); os.IsNotExist(err) {
		writeEvent(map[string]any{"event": "error", "error": "workspace deployment directory not found"})
		return
	}

	// Run docker compose pull + up -d on each compose file the workspace
	// owns. The compose files reference image tags, not specific digests,
	// so changing the SHA behind a tag (e.g. by rebuilding bailey-dev)
	// requires a pull to pick up the new manifest before up -d recreates
	// the containers.
	composeUnits := []struct {
		project string
		args    []string
	}{
		{workspaceName + "-site", []string{"-p", workspaceName + "-site"}},
	}
	dashboardCompose := filepath.Join(deploymentDir, "docker-compose-dashboard.yml")
	if _, err := os.Stat(dashboardCompose); err == nil {
		composeUnits = append(composeUnits, struct {
			project string
			args    []string
		}{
			project: workspaceName + "-dashboard",
			args:    []string{"-p", workspaceName + "-dashboard", "-f", "docker-compose-dashboard.yml"},
		})
	}

	pipeAndRun := func(action string, args []string) error {
		cmd := exec.Command("docker", append([]string{"compose"}, args...)...)
		cmd.Dir = deploymentDir
		pr, pw := io.Pipe()
		cmd.Stdout = pw
		cmd.Stderr = pw
		go func() {
			buf := make([]byte, 4096)
			var partial []byte
			for {
				n, err := pr.Read(buf)
				if n > 0 {
					data := append(partial, buf[:n]...)
					lines := strings.Split(string(data), "\n")
					partial = []byte(lines[len(lines)-1])
					for _, line := range lines[:len(lines)-1] {
						if strings.TrimSpace(line) == "" {
							continue
						}
						writeEvent(map[string]any{"event": "log", "stream": action, "message": line})
					}
				}
				if err != nil {
					if len(partial) > 0 {
						writeEvent(map[string]any{"event": "log", "stream": action, "message": string(partial)})
					}
					return
				}
			}
		}()
		err := cmd.Run()
		_ = pw.Close()
		return err
	}

	for _, unit := range composeUnits {
		writeEvent(map[string]any{"event": "log", "stream": "info", "message": "Pulling images for " + unit.project + "…"})
		if err := pipeAndRun("pull", append([]string{}, append(unit.args, "pull")...)); err != nil {
			writeEvent(map[string]any{"event": "log", "stream": "warn", "message": fmt.Sprintf("pull %s failed: %v (continuing — up -d may still recreate from local image)", unit.project, err)})
		}
		writeEvent(map[string]any{"event": "log", "stream": "info", "message": "Recreating containers for " + unit.project + "…"})
		if err := pipeAndRun("up", append([]string{}, append(unit.args, "up", "-d")...)); err != nil {
			writeEvent(map[string]any{"event": "error", "error": fmt.Sprintf("up -d %s failed: %v", unit.project, err)})
			return
		}
	}

	writeEvent(map[string]any{"event": "done", "message": "Workspace updated."})
}

// handleUpgradeWorkspace performs a version BUMP: regenerate the workspace's
// compose with the latest images on the server's track and recreate its
// containers. This is what the console's "Update" button (shown when a newer
// image is available) triggers, and what clears the update-available badge —
// unlike handleUpdateWorkspace, which only re-pulls the pinned tags' digests.
// Owner-only. Synchronous; progress goes to the daemon log.
func (s *Server) handleUpgradeWorkspace(w http.ResponseWriter, r *http.Request, email, workspaceName string) {
	if !nameRe.MatchString(workspaceName) {
		writeJSONError(w, "invalid workspace name", http.StatusBadRequest)
		return
	}
	_, groups := identityFromHeaders(r)
	if !callerOwnsWorkspace(email, groups, workspaceName) {
		writeJSONError(w, "only the workspace owner can update it", http.StatusForbidden)
		return
	}

	// Stream a determinate progress bar as NDJSON (same event shape as
	// handleUpdateWorkspace / createWorkspace, consumed by the console's
	// postNDJSON). runWorkspaceUpdate reports explicit phase fractions.
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	var writeMu sync.Mutex
	writeEvent := func(payload map[string]any) {
		writeMu.Lock()
		defer writeMu.Unlock()
		line, _ := json.Marshal(payload)
		_, _ = w.Write(append(line, '\n'))
		if flusher != nil {
			flusher.Flush()
		}
	}

	writeEvent(map[string]any{"event": "start", "message": "Updating " + workspaceName + "…", "fraction": 0})
	err := s.runWorkspaceUpdate(WorkspaceUpdateRequest{
		Workspace: workspaceName,
		Actor:     email,
		Staging:   useStagingTrack(),
		Progress: func(fraction float64, label string) {
			writeEvent(map[string]any{"event": "progress", "fraction": fraction, "message": label})
		},
	})
	if err != nil {
		writeEvent(map[string]any{"event": "error", "error": err.Error()})
		return
	}
	writeEvent(map[string]any{"event": "done", "message": "Workspace updated.", "fraction": 1})
}

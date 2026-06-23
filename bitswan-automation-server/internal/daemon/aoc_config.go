package daemon

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
)

// AOCConfigRequest is the payload `bitswan register` sends so the daemon
// persists the AOC connection into its OWN config (the named volume mounted at
// /root/.config/bitswan). The daemon is the single owner of that config — the
// host no longer writes ~/.config/bitswan during register, so the token the
// daemon uses to talk to the AOC (provisioning the protected proxy, registering
// workspaces, etc.) is always the freshly-registered one rather than a stale
// copy left over from an earlier run.
type AOCConfigRequest struct {
	AOCUrl             string `json:"aoc_url"`
	AutomationServerId string `json:"automation_server_id"`
	AccessToken        string `json:"access_token"`
	ExpiresAt          string `json:"expires_at,omitempty"`
	Domain             string `json:"domain,omitempty"`
	// Force overwrites an existing registration instead of failing with 409.
	Force bool `json:"force,omitempty"`
}

// AOCStatusResponse reports whether the daemon already holds an AOC
// registration. The host uses it for the "already registered" guard now that
// the host config file is no longer the source of truth.
type AOCStatusResponse struct {
	Registered         bool   `json:"registered"`
	AOCUrl             string `json:"aoc_url,omitempty"`
	AutomationServerId string `json:"automation_server_id,omitempty"`
	Domain             string `json:"domain,omitempty"`
}

// handleAOC routes /aoc and /aoc/* requests.
func (s *Server) handleAOC(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/aoc")
	path = strings.TrimPrefix(path, "/")
	switch path {
	case "config":
		s.handleAOCConfig(w, r)
	case "status":
		s.handleAOCStatus(w, r)
	default:
		writeJSONError(w, "not found", http.StatusNotFound)
	}
}

// handleAOCStatus handles GET /aoc/status.
func (s *Server) handleAOCStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	resp := AOCStatusResponse{}
	cfg := config.NewAutomationServerConfig()
	if settings, err := cfg.GetAutomationOperationsCenterSettings(); err == nil && settings.AccessToken != "" {
		resp.Registered = true
		resp.AOCUrl = settings.AOCUrl
		resp.AutomationServerId = settings.AutomationServerId
		resp.Domain = settings.Domain
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

// handleAOCConfig handles POST /aoc/config — persists the AOC connection into
// the daemon's config volume.
func (s *Server) handleAOCConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req AOCConfigRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.AOCUrl == "" || req.AutomationServerId == "" || req.AccessToken == "" {
		writeJSONError(w, "aoc_url, automation_server_id and access_token are required", http.StatusBadRequest)
		return
	}

	cfg := config.NewAutomationServerConfig()

	// Guard: refuse to clobber an existing registration unless forced. This is
	// the "already registered → disconnect first" check that used to live in the
	// register CLI (which read the host config); it now lives where the config
	// actually is.
	if !req.Force {
		if settings, err := cfg.GetAutomationOperationsCenterSettings(); err == nil && settings.AccessToken != "" {
			writeJSONError(w, fmt.Sprintf(
				"this automation server is already registered to an AOC instance at %s (server ID: %s); "+
					"run 'bitswan disconnect-from-aoc' first",
				settings.AOCUrl, settings.AutomationServerId,
			), http.StatusConflict)
			return
		}
	}

	if err := cfg.UpdateAutomationServer(config.AutomationOperationsCenterSettings{
		AOCUrl:             req.AOCUrl,
		AutomationServerId: req.AutomationServerId,
		AccessToken:        req.AccessToken,
		ExpiresAt:          req.ExpiresAt,
		Domain:             req.Domain,
	}); err != nil {
		writeJSONError(w, "failed to persist AOC config: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// The file carries the access token — keep it owner-only (matches the
	// permissions the register CLI used to set on the host file).
	if err := os.Chmod(cfg.GetConfigPath(), 0600); err != nil {
		writeJSONError(w, "failed to set config file permissions: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"success":true,"message":"AOC configuration saved"}`))
}

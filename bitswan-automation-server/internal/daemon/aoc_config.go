package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
	"github.com/bitswan-space/bitswan-workspaces/internal/daemon/backup"
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
	// Proxied / RelayAddr / RelayFingerprint configure the reverse-proxy relay
	// path for a NAT'd (or --force-proxy) server; see the config struct docs.
	Proxied          bool   `json:"proxied,omitempty"`
	RelayAddr        string `json:"relay_addr,omitempty"`
	RelayFingerprint string `json:"relay_fingerprint,omitempty"`
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

// AOCCredentialsRequest replaces ONLY the AOC credentials, leaving the rest of
// the registration alone. This exists for disaster recovery: the config restored
// from a backup is correct in every respect except the access token, because
// redeeming the recovery OTP minted a new one.
//
// It is deliberately not `POST /aoc/config` with force. That handler hands a
// freshly-built struct to UpdateAutomationServer, which REPLACES the whole [aoc]
// table — so recovery would have to resend domain, proxied, relay_addr and
// relay_fingerprint, and silently lose whichever it got wrong. Half of those
// aren't even recorded in the server manifest. Loading the restored config and
// touching two fields cannot lose anything.
type AOCCredentialsRequest struct {
	AccessToken string `json:"access_token"`
	ExpiresAt   string `json:"expires_at,omitempty"`
}

// handleAOC routes /aoc and /aoc/* requests.
func (s *Server) handleAOC(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/aoc")
	path = strings.TrimPrefix(path, "/")
	switch path {
	case "config":
		s.handleAOCConfig(w, r)
	case "credentials":
		s.handleAOCCredentials(w, r)
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

// handleAOCCredentials handles POST /aoc/credentials — swaps in a new access
// token without disturbing anything else about the registration.
//
// Load → set two fields → save. That ordering matters: the config being edited
// is the one restored from the backup, so it is already the source of truth for
// domain/relay/protected-domain and this must not become a rewrite of it.
func (s *Server) handleAOCCredentials(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req AOCCredentialsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.AccessToken == "" {
		writeJSONError(w, "access_token is required", http.StatusBadRequest)
		return
	}

	cfg := config.NewAutomationServerConfig()
	current, err := cfg.LoadConfig()
	if err != nil {
		// No config to merge into means this isn't a recovery — the caller
		// should be registering, which writes the whole thing.
		writeJSONError(w, "no automation server config to update: "+err.Error()+
			" (use /aoc/config to register)", http.StatusConflict)
		return
	}
	if current.AutomationOperationsCenter.AutomationServerId == "" {
		writeJSONError(w, "the stored config has no automation server id; "+
			"use /aoc/config to register", http.StatusConflict)
		return
	}

	current.AutomationOperationsCenter.AccessToken = req.AccessToken
	current.AutomationOperationsCenter.ExpiresAt = req.ExpiresAt

	if err := cfg.SaveConfig(current); err != nil {
		writeJSONError(w, "failed to persist AOC credentials: "+err.Error(), http.StatusInternalServerError)
		return
	}
	// SaveConfig uses os.Create and does not chmod, so every caller that writes
	// the token narrows it afterwards.
	if err := os.Chmod(cfg.GetConfigPath(), 0600); err != nil {
		writeJSONError(w, "failed to set config file permissions: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// The token is what authenticates the restic repo, so the self-enable that
	// ran at boot necessarily failed against the stale one. Redo it now rather
	// than leaving backups broken until the next nightly window.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		if _, err := backup.EnsureEnabled(ctx); err != nil {
			fmt.Printf("Warning: backup re-enable after credential update: %v\n", err)
		}
	}()

	writeJSON(w, map[string]interface{}{
		"success": true,
		"message": "AOC credentials updated; the rest of the registration is unchanged",
		"domain":  current.AutomationOperationsCenter.Domain,
		"proxied": current.AutomationOperationsCenter.Proxied,
	})
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
		Proxied:            req.Proxied,
		RelayAddr:          req.RelayAddr,
		RelayFingerprint:   req.RelayFingerprint,
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

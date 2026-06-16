package daemon

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
)

// GET /bailey/api/overview — the Server Console "Server overview" view.
// Admin-only (server-wide counts + the recent security-activity feed are
// operator information). Returns three things:
//
//   - counts: the at-a-glance tiles (workspaces, people, trusted devices,
//     pending approvals).
//   - identity: the server identity card (who claimed it + when, version,
//     online, region, uptime).
//   - activity: the recent security-activity feed, newest first, drawn
//     from the append-only events audit log (bailey_store_audit.go).
//
// All data is real: counts come from the existing stores
// (GetWorkspaceList, the people source, the devices store, the
// pending-pairs store); identity from the claim record + the daemon's
// own version/start time; activity from the events table populated at
// the mutation chokepoints (device approve/revoke, workspace
// create/trash, server claim, TOTP enrol).

type overviewCounts struct {
	Workspaces       int `json:"workspaces"`
	People           int `json:"people"`
	TrustedDevices   int `json:"trusted_devices"`
	PendingApprovals int `json:"pending_approvals"`
}

type overviewIdentity struct {
	ClaimedBy string `json:"claimed_by"`           // recorded root admin email ("" if unclaimed/legacy)
	ClaimedAt string `json:"claimed_at,omitempty"` // RFC3339 ("" if not recorded)
	Version   string `json:"version"`
	Online    bool   `json:"online"`
	Region    string `json:"region,omitempty"` // operator-set; empty when not configured
	UptimeSec int64  `json:"uptime_sec"`
	StartTime string `json:"start_time"` // RFC3339 — daemon process start
}

type overviewResponse struct {
	Counts      overviewCounts   `json:"counts"`
	Identity    overviewIdentity `json:"identity"`
	Activity    []eventRecord    `json:"activity"`
	System      *systemStats     `json:"system,omitempty"`       // live host resource snapshot
	SystemError string           `json:"system_error,omitempty"` // set when stats couldn't be read (no fabrication)
}

// overviewActivityLimit caps the recent-activity feed. The console shows
// a short list; the full history lives in the events table.
const overviewActivityLimit = 25

func (s *Server) handleBaileyOverview(w http.ResponseWriter, r *http.Request) {
	var resp overviewResponse

	// --- counts ---
	if full, err := GetWorkspaceList(false, false); err == nil && full != nil {
		resp.Counts.Workspaces = len(full.Workspaces)
	}

	people, _ := gatherPeople(r)
	resp.Counts.People = len(people)

	if devs, err := listAllDevices(); err == nil {
		resp.Counts.TrustedDevices = len(devs)
	}
	resp.Counts.PendingApprovals = len(visiblePendingRequests("", true))

	// --- identity card ---
	resp.Identity = overviewIdentity{
		ClaimedBy: serverRootAdmin(),
		ClaimedAt: serverClaimedAt(),
		Version:   s.version,
		Online:    true,
		Region:    serverRegion(),
		StartTime: s.startTime.UTC().Format(time.RFC3339),
		UptimeSec: int64(time.Since(s.startTime).Seconds()),
	}

	// --- live host resource stats (memory / disk / CPU) ---
	if stats, err := gatherSystemStats(); err == nil {
		resp.System = stats
	} else {
		// Surface the failure honestly rather than reporting fake zeros.
		resp.SystemError = err.Error()
	}

	// --- recent security activity ---
	if evs, err := dbListEvents(overviewActivityLimit); err == nil {
		resp.Activity = evs
	} else {
		resp.Activity = []eventRecord{}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

// settingRegion is the server_settings key holding the operator/admin-declared
// region label shown on the overview identity card.
const settingRegion = "region"

// serverRegion returns the declared region for the identity card. The locally
// stored setting (set by an admin in the console or via the CLI) is
// authoritative; if none is set we fall back to the BITSWAN_REGION env var the
// operator may have set at deploy time, and "" otherwise. We never
// misrepresent the AOC domain as a region.
func serverRegion() string {
	if v, _ := dbGetSetting(settingRegion); strings.TrimSpace(v) != "" {
		return strings.TrimSpace(v)
	}
	return strings.TrimSpace(os.Getenv("BITSWAN_REGION"))
}

// setServerRegion stores the region label locally (authoritative). An empty
// value clears the override, reverting to the env-var/none behaviour. Shared
// by the admin API and the CLI.
func setServerRegion(region, by string) error {
	return dbSetSetting(settingRegion, strings.TrimSpace(region), by)
}

// SetRegion sets the server region label in the local bailey.db. Exported for
// the CLI (`automation-server-daemon region <value>`); the daemon reads the
// value live on each overview request, so no restart is needed.
func SetRegion(region string) error { return setServerRegion(region, "cli") }

// Region returns the currently configured region label ("" if none).
func Region() string { return serverRegion() }

// handleSetRegion sets the server region (admin-only; the caller is already
// gated in handleBailey). POST {region}. An empty region clears the override.
func handleSetRegion(w http.ResponseWriter, r *http.Request, by string) {
	var req struct {
		Region string `json:"region"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "bad request", http.StatusBadRequest)
		return
	}
	region := strings.TrimSpace(req.Region)
	if len(region) > 64 {
		writeJSONError(w, "region must be 64 characters or fewer", http.StatusBadRequest)
		return
	}
	if err := setServerRegion(region, by); err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "region": region})
}

// configuredProtectedDomain is a small shared helper for the domain
// suffix; "" when protected ingress isn't configured. Kept here so both
// overview and people can derive workspace endpoint hosts the same way.
func configuredProtectedDomain() string {
	sc, err := config.NewAutomationServerConfig().LoadConfig()
	if err != nil || sc == nil {
		return ""
	}
	return sc.ProtectedHostnameDomain()
}

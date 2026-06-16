package daemon

import (
	"encoding/json"
	"net/http"
	"os"
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

// serverRegion returns the operator-declared region for the identity
// card, or "" when none is configured. There is no dedicated region
// field in the automation-server config today, so we read the optional
// BITSWAN_REGION env var (set by the operator at deploy time) and degrade
// to empty otherwise — we do NOT misrepresent the AOC domain as a region.
func serverRegion() string {
	return os.Getenv("BITSWAN_REGION")
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

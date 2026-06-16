package daemon

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// Socket-side admin API for Bailey device-trust, backing the
// `bitswan bailey devices` CLI. These handlers are mounted on the daemon's
// Unix-socket mux (setupRoutes) behind authMiddleware. Reaching that socket
// already implies operator/root trust on the host, so — unlike the browser
// approveHandler in mfa_pair.go — they do NOT require the caller to present an
// already-trusted device. The daemon container is also the one process with
// the bailey.db volume mounted, so it is the only place that sees the live
// device store (the host's stale ~/.config/bitswan/bailey.db is a different
// file and must never be touched directly).

// DeviceApproveRequest is the body of POST /bailey/devices/approve.
type DeviceApproveRequest struct {
	Code string `json:"code"`
	// Email optionally scopes the approval to one user's pending request, so a
	// code typo can't approve someone else's device. Empty = approve whichever
	// request carries the code.
	Email string `json:"email"`
}

// handleDeviceApprove approves a pending "trust this device" request by its
// 6-digit code — the CLI equivalent of an admin approving the code in the
// browser. The waiting device completes pairing on its next poll.
func (s *Server) handleDeviceApprove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req DeviceApproveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}
	code := strings.TrimSpace(req.Code)
	if code == "" {
		writeJSONError(w, "code is required", http.StatusBadRequest)
		return
	}

	// When scoped to an email, verify the code belongs to that user before
	// approving — fail loudly on a mismatch rather than approve the wrong one.
	if email := strings.TrimSpace(req.Email); email != "" {
		e, _ := dbLoadPendingPairByCode(code)
		if e == nil || !strings.EqualFold(e.Email, email) {
			writeJSONError(w, "no pending device request for '"+email+"' matches that code", http.StatusNotFound)
			return
		}
	}

	approver := serverRootAdmin()
	if approver == "" {
		approver = "cli"
	}
	e := approvePendingPairByCode(code, approver)
	if e == nil {
		writeJSONError(w, "no pending device request matches that code (it may have expired)", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"approved": true,
		"email":    e.Email,
	})
}

// PendingDevice is one entry in GET /bailey/devices/pending.
type PendingDevice struct {
	Email     string `json:"email"`
	Code      string `json:"code"`
	UserAgent string `json:"user_agent"`
	AgeSec    int    `json:"age_sec"`
	Approved  bool   `json:"approved"`
}

// handleDevicesPending lists the live (unexpired) pending device-trust
// requests so an operator can see the codes to approve.
func (s *Server) handleDevicesPending(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	_ = dbPurgeExpiredPendingPairs()
	all, err := dbListPendingPairs()
	if err != nil {
		writeJSONError(w, "failed to list pending devices: "+err.Error(), http.StatusInternalServerError)
		return
	}
	now := time.Now()
	out := []PendingDevice{}
	for _, e := range all {
		if now.After(e.ExpiresAt) {
			continue
		}
		out = append(out, PendingDevice{
			Email:     e.Email,
			Code:      e.Code,
			UserAgent: e.UserAgent,
			AgeSec:    int(now.Sub(e.IssuedAt).Seconds()),
			Approved:  e.ApprovedBy != "",
		})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"pending": out})
}

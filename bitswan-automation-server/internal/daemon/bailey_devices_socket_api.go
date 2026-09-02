package daemon

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// Socket-side admin API for Bailey device-trust, backing the
// `bitswan bailey devices` CLI. These handlers are mounted on the daemon's
// Unix-socket mux (setupRoutes) behind authMiddleware. Unlike the browser
// approveHandler in mfa_pair.go they do NOT require the caller to present an
// already-trusted device — but socket reachability is NOT the authority either:
// the socket is mounted into first-party workspace containers, so both handlers
// require the admin token on top of authMiddleware (#189 for the approve,
// #234 for the pending list). See socketPrivilegedRoutes in server.go for the
// full operator-only set. The daemon container is also the one process with
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
	// BSY-13 / #189: the daemon socket is mounted into first-party workspace
	// containers, and authMiddleware trusts any socket peer — so approving a
	// device (minting trust, attributed to the root admin) must additionally
	// require the admin token, exactly like the workspace secret-read path.
	// Without it a compromised first-party container could self-approve a device.
	principal, hasToken := s.callerAdminPrincipal(r)
	if !hasToken {
		writeJSONError(w, "approving a device requires the automation-server admin token (run the bitswan CLI on the host, or pass the daemon token as a bearer token)", http.StatusForbidden)
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
	e := approvePendingPairByCodeVia(code, approver, principal)
	if e == nil {
		writeJSONError(w, "no pending device request matches that code (it may have expired)", http.StatusNotFound)
		return
	}
	// #189: minting device trust over the socket was not audited at all — the
	// browser path records auditDeviceApprove but this one recorded nothing.
	// Attribute it to the credential used, not to the root-admin account.
	_ = recordEvent(principal, auditDeviceApprove, e.Email)

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
	// #234: this response carries each pending request's 6-digit Code — a
	// short-lived shared secret, and precisely the input an approval takes. #189
	// gated USING an approval but left the codes readable by any socket peer, so
	// a first-party container could still enumerate them; gate the read too, so
	// no future gap in the approval path comes with the guessing step removed.
	//
	// Gated whole rather than redacting Code: the operator listing codes to
	// approve one is the only caller (the host CLI's Client.ListPendingDevices,
	// which always sends its bearer token), so a redacted response would serve
	// nobody while quietly returning less than it appears to. Availability is
	// unchanged — handleDeviceApprove already requires the same token, so a
	// caller that cannot pass this gate could not have used the codes anyway.
	if !s.callerHasAdminToken(r) {
		writeJSONError(w, "listing pending device requests requires the automation-server admin token (run the bitswan CLI on the host, or pass the daemon token as a bearer token)", http.StatusForbidden)
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

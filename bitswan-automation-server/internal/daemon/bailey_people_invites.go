package daemon

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/aoc"
)

// Bailey invites — the full lifecycle in one file.
//
// An admin invites a member of this server's AOC organization from the
// People view. The daemon stores a single-use, 48h invite (token hashed
// at rest — see bailey_store_invites.go) and asks the AOC to email the
// invite link using the SMTP service configured there; if delivery
// fails the admin gets the link back to share manually. The link points
// at the PUBLIC onboarding host (bailey-onboard.<domain>) so the token
// survives the OAuth round-trip without the console host's device-trust
// redirect dance.
//
// Redeeming the token (the gate API at the bottom) trusts the invitee's
// FIRST device automatically — that is the entire point of the invite.
// Once the user has any trusted device, redemption refuses and every
// later device goes through the normal pending-pair + approval flow.
//
// Admin-only routes (dispatched behind isAdmin in handleBailey):
//   GET  /bailey/api/people/org-users       — AOC org members + local state
//   POST /bailey/api/people/invite          — create (or replace) an invite
//   GET  /bailey/api/people/invites         — outstanding invites
//   POST /bailey/api/people/invites/revoke  — delete an outstanding invite
//   POST /bailey/api/people/invites/resend  — fresh token + expiry, re-email
// Gate route (untrusted devices; dispatched from handleGateAPI):
//   POST /bailey/api/invite/redeem          — burn token, trust THIS device

// aocInviteClient is the minimal AOC surface the invite handlers use.
// Kept as an interface behind a constructor var so tests can stub the
// AOC without a network; production resolves to *aoc.AOCClient.
type aocInviteClient interface {
	ListOrgUsers() ([]aoc.OrgUser, error)
	SendInviteEmail(req aoc.InviteEmailRequest) error
}

var newAOCInviteClient = func() (aocInviteClient, error) {
	return aoc.NewAOCClient()
}

// writeJSONCodeError mirrors writeJSONError but adds a stable
// machine-readable "code" the SPA branches on (expired vs consumed vs
// wrong_account need different scenes, not just different prose).
func writeJSONCodeError(w http.ResponseWriter, message, code string, statusCode int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message, "code": code})
}

// inviteDTO is the JSON shape of one invite in admin responses.
type inviteDTO struct {
	Email     string `json:"email"`
	Role      string `json:"role"`
	CreatedBy string `json:"created_by"`
	CreatedAt string `json:"created_at"`
	ExpiresAt string `json:"expires_at"`
	EmailSent bool   `json:"email_sent"`
	Expired   bool   `json:"expired"`
}

func inviteToDTO(inv *inviteRecord, now time.Time) inviteDTO {
	return inviteDTO{
		Email:     inv.Email,
		Role:      inv.Role,
		CreatedBy: inv.CreatedBy,
		CreatedAt: inv.CreatedAt.UTC().Format(time.RFC3339),
		ExpiresAt: inv.ExpiresAt.UTC().Format(time.RFC3339),
		EmailSent: inv.EmailSent,
		Expired:   inv.expired(now),
	}
}

// buildInviteLink returns the URL the invitee will click. It targets
// the public onboarding host — device-trust exempt, so the gate SPA
// loads there directly and the ?invite= query survives the OAuth
// redirect (the console host would bounce through _bailey_origin
// instead). Never derived from the AOC-registered bailey_url: that is
// the console host.
//
// The host uses protectedHostnameDomain() because that is where the SPA
// is actually served. On deployments that set the protected_domain
// override (serving on a zone different from the AOC-assigned domain),
// the AOC's send-invite-email host check — which knows the domain and
// bailey_url — will reject this link, so the email won't auto-send and
// the admin uses the copyable-link fallback (the link itself is valid
// and works). Auto-send on override deployments needs the AOC to learn
// the override host (a follow-up).
func buildInviteLink(token string) (string, error) {
	domain := protectedHostnameDomain()
	if domain == "" {
		return "", errNoProtectedDomain
	}
	return "https://" + serverConsoleOnboardHost(domain) + "/?invite=" + token, nil
}

var errNoProtectedDomain = &inviteConfigError{"no protected domain configured for this server"}

type inviteConfigError struct{ msg string }

func (e *inviteConfigError) Error() string { return e.msg }

// --- GET /bailey/api/people/org-users ---
//
// The invite dialog's data source: every member of this server's AOC
// organization, annotated with local state so the dialog can grey out
// people who already use this server (in_roster) and badge outstanding
// invites (invited).
func handleBaileyOrgUsers(w http.ResponseWriter, r *http.Request) {
	client, err := newAOCInviteClient()
	if err != nil {
		writeJSONError(w, "AOC not configured: "+err.Error(), http.StatusBadGateway)
		return
	}
	orgUsers, err := client.ListOrgUsers()
	if err != nil {
		writeJSONError(w, "could not list org users from AOC: "+err.Error(), http.StatusBadGateway)
		return
	}

	// in_roster = would appear in the People roster for a real reason
	// (device, workspace, TOTP, root admin) — reuse gatherPeople so the
	// dialog can never disagree with the roster the admin is looking at.
	// InvitedOnly rows don't count: those are the invites themselves.
	// A failure to compute either annotation is surfaced as a non-fatal
	// warning rather than dropped: the org list is still useful, and the
	// invite CREATE path re-checks membership/devices so a stale flag
	// can't cause an unsafe invite — but the admin should know the
	// in_roster/invited badges may be incomplete.
	var warning string
	inRoster := map[string]bool{}
	if people, pErr := gatherPeople(r); pErr == nil {
		for _, p := range people {
			if !p.InvitedOnly {
				inRoster[strings.ToLower(p.Email)] = true
			}
		}
	} else {
		warning = "could not determine which users already have access: " + pErr.Error()
	}
	invited := map[string]bool{}
	now := time.Now()
	if invites, iErr := dbListUnconsumedInvites(); iErr == nil {
		for i := range invites {
			if invites[i].live(now) {
				invited[strings.ToLower(invites[i].Email)] = true
			}
		}
	} else {
		warning = "could not load outstanding invites: " + iErr.Error()
	}

	type orgUserDTO struct {
		Email    string `json:"email"`
		Username string `json:"username"`
		Verified bool   `json:"verified"`
		InRoster bool   `json:"in_roster"`
		Invited  bool   `json:"invited"`
	}
	out := make([]orgUserDTO, 0, len(orgUsers))
	for _, u := range orgUsers {
		if strings.TrimSpace(u.Email) == "" {
			continue
		}
		key := strings.ToLower(u.Email)
		out = append(out, orgUserDTO{
			Email:    u.Email,
			Username: u.Username,
			Verified: u.Verified,
			InRoster: inRoster[key],
			Invited:  invited[key],
		})
	}
	resp := map[string]any{"users": out}
	if warning != "" {
		resp["warning"] = warning
	}
	writeJSON(w, resp)
}

// sendInviteEmailViaAOC asks the AOC to deliver the invite email and
// records the outcome on the row. Returns (emailSent, userFacingError).
// A delivery failure is NOT a handler failure — the invite stands and
// the admin gets the link to share manually (the mandated fallback).
func sendInviteEmailViaAOC(client aocInviteClient, inv *inviteRecord, link, actor string) (bool, string) {
	err := client.SendInviteEmail(aoc.InviteEmailRequest{
		Email:     inv.Email,
		InviteURL: link,
		InvitedBy: actor,
		Role:      inv.Role,
		ExpiresAt: inv.ExpiresAt.UTC().Format(time.RFC3339),
	})
	if err == nil {
		_ = dbSetInviteEmailSent(inv.Email, true)
		return true, ""
	}
	_ = dbSetInviteEmailSent(inv.Email, false)
	return false, err.Error()
}

// --- POST /bailey/api/people/invite ---
//
// Create (or replace — one outstanding invite per email) an invite for
// an AOC-org member. Org membership is verified here against the AOC
// BEFORE anything is stored (fail closed: AOC unreachable → 502, no
// invite), and the AOC re-verifies server-side before mailing — the
// daemon check is policy, the AOC check is the backstop a compromised
// daemon can't skip.
func handleBaileyPeopleInvite(w http.ResponseWriter, r *http.Request, actor string) {
	var req struct {
		Email string `json:"email"`
		Role  string `json:"role"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "bad request", http.StatusBadRequest)
		return
	}
	email := strings.TrimSpace(req.Email)
	role := strings.TrimSpace(req.Role)
	if role == "" {
		role = roleMember
	}
	// Invites hand out at most member/admin — the rarer auditor/user
	// roles stay a deliberate post-join assignment in People & roles.
	if email == "" || (role != roleMember && role != roleAdmin) {
		writeJSONError(w, "email and a role of member or admin are required", http.StatusBadRequest)
		return
	}
	if devs, err := dbListDevices(email); err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	} else if len(devs) > 0 {
		writeJSONCodeError(w, "that user already has a trusted device on this server", "already_trusted", http.StatusConflict)
		return
	}

	client, err := newAOCInviteClient()
	if err != nil {
		writeJSONError(w, "AOC not configured: "+err.Error(), http.StatusBadGateway)
		return
	}
	orgUsers, err := client.ListOrgUsers()
	if err != nil {
		writeJSONError(w, "could not verify org membership with the AOC: "+err.Error(), http.StatusBadGateway)
		return
	}
	// Only members of this server's AOC organization can be invited.
	// Adopt the AOC's canonical casing of the address for storage/email.
	canonical := ""
	for _, u := range orgUsers {
		if strings.EqualFold(strings.TrimSpace(u.Email), email) {
			canonical = strings.TrimSpace(u.Email)
			break
		}
	}
	if canonical == "" {
		writeJSONCodeError(w, "that email is not a member of this server's organization", "not_in_org", http.StatusBadRequest)
		return
	}

	token, hash, err := generateInviteToken()
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	link, err := buildInviteLink(token)
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	now := time.Now()
	inv := &inviteRecord{
		Email:     canonical,
		TokenHash: hash,
		Role:      role,
		CreatedBy: actor,
		CreatedAt: now,
		ExpiresAt: now.Add(inviteTTL),
	}
	if err := dbUpsertInvite(inv); err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	emailSent, emailErr := sendInviteEmailViaAOC(client, inv, link, actor)
	inv.EmailSent = emailSent
	_ = recordEvent(actor, auditInviteCreate, canonical)

	resp := map[string]any{
		"ok":          true,
		"email_sent":  emailSent,
		"invite_link": link,
		"invite":      inviteToDTO(inv, now),
	}
	if emailErr != "" {
		resp["email_error"] = emailErr
	}
	writeJSON(w, resp)
}

// --- GET /bailey/api/people/invites ---
func handleBaileyInvitesList(w http.ResponseWriter, r *http.Request) {
	invites, err := dbListUnconsumedInvites()
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	now := time.Now()
	out := make([]inviteDTO, 0, len(invites))
	for i := range invites {
		out = append(out, inviteToDTO(&invites[i], now))
	}
	writeJSON(w, map[string]any{"invites": out})
}

// --- POST /bailey/api/people/invites/revoke ---
func handleBaileyInviteRevoke(w http.ResponseWriter, r *http.Request, actor string) {
	var req struct {
		Email string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Email) == "" {
		writeJSONError(w, "email is required", http.StatusBadRequest)
		return
	}
	email := strings.TrimSpace(req.Email)
	deleted, err := dbDeleteInvite(email)
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if !deleted {
		writeJSONError(w, "no outstanding invite for that email", http.StatusNotFound)
		return
	}
	_ = recordEvent(actor, auditInviteRevoke, email)
	writeJSON(w, map[string]any{"ok": true})
}

// --- POST /bailey/api/people/invites/resend ---
//
// Re-mints the invite: fresh token, fresh 48h expiry — the previously
// emailed link stops working (single live token per invite). Role and
// original inviter are preserved.
func handleBaileyInviteResend(w http.ResponseWriter, r *http.Request, actor string) {
	var req struct {
		Email string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Email) == "" {
		writeJSONError(w, "email is required", http.StatusBadRequest)
		return
	}
	inv, err := dbLoadInviteByEmail(strings.TrimSpace(req.Email))
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if inv == nil || inv.consumed() {
		writeJSONError(w, "no outstanding invite for that email", http.StatusNotFound)
		return
	}
	// Same guard as create: if the invitee has since gained a trusted
	// device (e.g. joined via the normal pending-pair flow), re-sending
	// would email a link that can only ever answer 409 already_trusted.
	if devs, err := dbListDevices(inv.Email); err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	} else if len(devs) > 0 {
		writeJSONCodeError(w, "that user already has a trusted device on this server", "already_trusted", http.StatusConflict)
		return
	}

	client, err := newAOCInviteClient()
	if err != nil {
		writeJSONError(w, "AOC not configured: "+err.Error(), http.StatusBadGateway)
		return
	}
	token, hash, err := generateInviteToken()
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	link, err := buildInviteLink(token)
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	now := time.Now()
	inv.TokenHash = hash
	inv.CreatedAt = now
	inv.ExpiresAt = now.Add(inviteTTL)
	inv.EmailSent = false
	if err := dbUpsertInvite(inv); err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	emailSent, emailErr := sendInviteEmailViaAOC(client, inv, link, actor)
	inv.EmailSent = emailSent
	_ = recordEvent(actor, auditInviteResend, inv.Email)

	resp := map[string]any{
		"ok":          true,
		"email_sent":  emailSent,
		"invite_link": link,
		"invite":      inviteToDTO(inv, now),
	}
	if emailErr != "" {
		resp["email_error"] = emailErr
	}
	writeJSON(w, resp)
}

// --- POST /bailey/api/invite/redeem (gate API — untrusted devices) ---
//
// Burns a live invite token and trusts THIS browser as the invitee's
// FIRST device. Reachable pre-device-trust by design (the invitee has
// no trusted device yet); the security model matches recover/self-trust:
// the action requires a secret only the legitimate user holds (the
// emailed high-entropy single-use token), bound to the OAuth identity
// (EqualFold email match) and to the zero-devices precondition. The
// consume is a single guarded UPDATE, so two racing redeems can't both
// mint a device.
func handleGateInviteRedeem(w http.ResponseWriter, r *http.Request, email string) {
	if !requireIdentity(w, email) {
		return
	}
	// Never let an invite mint the bootstrap device — the one-time claim
	// flow (BootstrapScene) owns the unclaimed state.
	if !serverClaimed() {
		writeJSONCodeError(w, "this server hasn't been set up yet", "unclaimed", http.StatusConflict)
		return
	}
	token := strings.TrimSpace(decodeGateBody(r).Token)
	if token == "" {
		writeJSONCodeError(w, "invite token required", "invalid", http.StatusBadRequest)
		return
	}
	inv, err := dbLoadInviteByTokenHash(hashInviteToken(token))
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if inv == nil {
		writeJSONCodeError(w, "that invite link isn't valid", "invalid", http.StatusNotFound)
		return
	}
	now := time.Now()
	if inv.consumed() {
		writeJSONCodeError(w, "that invite has already been used", "consumed", http.StatusGone)
		return
	}
	if inv.expired(now) {
		writeJSONCodeError(w, "that invite has expired — ask an admin to send a new one", "expired", http.StatusGone)
		return
	}
	// Bound to the invitee: whoever holds the link must sign in as the
	// invited account. Don't echo the invitee email — the caller holding
	// a forwarded link doesn't get to learn who it was for.
	if !strings.EqualFold(strings.TrimSpace(inv.Email), strings.TrimSpace(email)) {
		writeJSONCodeError(w, "this invite was issued for a different account", "wrong_account", http.StatusForbidden)
		return
	}
	// First device only. With a trusted device the user can already
	// self-approve new ones; the invite must not become a device-minting
	// side channel.
	devs, err := dbListDevices(email)
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if len(devs) > 0 {
		writeJSONCodeError(w, "you're already set up on this server — approve new devices from an existing one", "already_trusted", http.StatusConflict)
		return
	}
	claimed, err := dbConsumeInviteAtomic(inv.TokenHash, now)
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if !claimed {
		// Lost a race (or expired between load and consume) — either way
		// the token no longer buys a device.
		writeJSONCodeError(w, "that invite has already been used", "consumed", http.StatusGone)
		return
	}
	if _, err := completeNewDevicePairFor(w, r, email, "invite from "+inv.CreatedBy); err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// The invited role applies only where no explicit role exists — an
	// invite must never downgrade a role an admin set deliberately, and
	// the root admin's role is untouchable (same rule as handleSetUserRole).
	if existing, _ := dbGetUserRole(email); existing == "" &&
		!strings.EqualFold(email, strings.TrimSpace(serverRootAdmin())) {
		if err := dbSetUserRole(email, inv.Role, inv.CreatedBy); err != nil {
			writeJSONError(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
	if callerIsAdmin(email) {
		_ = setSessionCookie(w, r, email)
	}
	_ = recordEvent(email, auditInviteRedeem, inv.CreatedBy)
	writeJSON(w, map[string]any{"ok": true, "redirect_path": originRedirectPath(r)})
}

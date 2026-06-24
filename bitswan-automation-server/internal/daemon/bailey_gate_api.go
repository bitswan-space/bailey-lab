package daemon

import (
	"crypto/rand"
	"encoding/base32"
	"encoding/json"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
)

// bailey_gate_api.go — the JSON API behind the React device-trust GATE
// scenes (BootstrapScene / ApprovalScene / RecoveryScene in the
// wireframe). These endpoints are the React equivalents of the
// server-rendered Go gate pages (claim / pending-pair / self-trust /
// recovery / totp enrol) in mfa_claim.go, mfa_pair.go, mfa_totp.go,
// mfa_account.go — they reuse the exact same store helpers and security
// rules.
//
// CRUCIAL: these routes are mounted under /bailey/api/* (handleBailey),
// which the chrome wrap bypasses, AND they are exempt from
// enforceMFAGate. They MUST therefore be callable by an OAuth-
// authenticated but UNtrusted user — they ARE the pre-trust flow. The
// only gate is the device-trust gate, and these are how a user clears
// it. They do NOT require an existing device cookie.
//
// The security invariants from the Go flow are preserved:
//   - /claim only works while the server is UNCLAIMED and the caller is
//     eligible (eligibleToClaim). It is the one-time TOFU bootstrap.
//   - /self-trust requires the user to PROVE possession of their own
//     enrolled authenticator (totp.Validate) — a self-trust path that's
//     legitimate precisely because it isn't first-factor-only.
//   - /recover requires a valid TOTP or single-use backup code.
//   - /pending-pair just mints a code; the approval (which mints trust
//     for a brand-new browser) still has to come from an already-trusted
//     browser via the existing /bailey/api/approvals flow
//     (approverIsTrusted in mfa_pair.go), so an untrusted browser can't
//     self-approve.
//
// On every success path that should trust THIS browser we call
// setDeviceCookie (directly or via completeNewDevicePairFor).

// handleGateAPI dispatches the /bailey/api/{gate-state,claim,pending-pair,
// self-trust,recover,totp/*,backup-codes/regenerate} routes. Returns
// false if the path isn't a gate-API route (so handleBailey keeps
// matching its other routes). email/groups are the oauth2-proxy-resolved
// identity; an empty email means no identity (handled per-route).
func (s *Server) handleGateAPI(w http.ResponseWriter, r *http.Request, email string, groups []string) bool {
	switch r.URL.Path {
	case "/bailey/api/gate-state":
		guardGet(w, r, func() { handleGateState(w, r, email, groups) })
	case "/bailey/api/claim":
		guardPost(w, r, func() { handleGateClaim(w, r, email, groups) })
	case "/bailey/api/pending-pair":
		guardGet(w, r, func() { handleGatePendingPair(w, r, email) })
	case "/bailey/api/pending-pair/poll":
		guardGet(w, r, func() { handleGatePendingPairPoll(w, r, email) })
	case "/bailey/api/self-trust":
		guardPost(w, r, func() { handleGateSelfTrust(w, r, email) })
	case "/bailey/api/recover":
		guardPost(w, r, func() { handleGateRecover(w, r, email) })
	case "/bailey/api/totp/enroll":
		guardGet(w, r, func() { handleGateTOTPEnroll(w, r, email) })
	case "/bailey/api/totp/verify":
		guardPost(w, r, func() { handleGateTOTPVerify(w, r, email) })
	case "/bailey/api/backup-codes/regenerate":
		guardPost(w, r, func() { handleGateBackupCodesRegenerate(w, r, email) })
	default:
		return false
	}
	return true
}

func guardGet(w http.ResponseWriter, r *http.Request, fn func()) {
	if r.Method != http.MethodGet {
		writeJSONError(w, "GET required", http.StatusMethodNotAllowed)
		return
	}
	fn()
}

func guardPost(w http.ResponseWriter, r *http.Request, fn func()) {
	if r.Method != http.MethodPost {
		writeJSONError(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	fn()
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// requireIdentity returns true if there's an authenticated email. When
// there isn't, it writes a 401 and returns false. Every gate-API route
// needs an identity (the user is OAuth-authenticated but untrusted) —
// without one there is nothing to act on.
func requireIdentity(w http.ResponseWriter, email string) bool {
	if strings.TrimSpace(email) == "" {
		writeJSONError(w, "not authenticated", http.StatusUnauthorized)
		return false
	}
	return true
}

// --- GET /bailey/api/gate-state ---
//
// The single source of truth the SPA reads to choose a scene. See the
// scene-selection rule documented in the returned shape below.
type gateState struct {
	Email            string `json:"email"`
	IsAdmin          bool   `json:"is_admin"`
	Claimed          bool   `json:"claimed"`            // any root admin recorded OR any trusted device exists
	Trusted          bool   `json:"trusted"`            // THIS browser has a valid device cookie
	TOTPEnrolled     bool   `json:"totp_enrolled"`      // this user has an authenticator secret
	BackupCodes      bool   `json:"backup_codes"`       // this user has unused single-use backup codes
	CanClaim         bool   `json:"can_claim"`          // unclaimed AND this caller may run the one-time bootstrap
	HasTrustedDevice bool   `json:"has_trusted_device"` // this user ALREADY has ≥1 trusted device (can self-approve a new one)
}

func handleGateState(w http.ResponseWriter, r *http.Request, email string, groups []string) {
	// gate-state is callable with no identity (the SPA may probe it before
	// the OIDC handshake completes); it just reports email:"" and false
	// everywhere, which the SPA can treat as "not signed in".
	claimed := serverClaimed()
	rec, _ := loadTOTPRecord(email)
	hasTrustedDevice := false
	if email != "" {
		if devs, err := dbListDevices(email); err == nil && len(devs) > 0 {
			hasTrustedDevice = true
		}
	}
	writeJSON(w, gateState{
		Email:            email,
		IsAdmin:          callerIsAdmin(email),
		Claimed:          claimed,
		Trusted:          email != "" && currentDeviceForRequest(r, email) != nil,
		TOTPEnrolled:     email != "" && rec != nil,
		BackupCodes:      email != "" && dbBackupCodesExist(email),
		CanClaim:         !claimed && eligibleToClaim(email, groups),
		HasTrustedDevice: hasTrustedDevice,
	})
}

// --- POST /bailey/api/claim ---
//
// First-admin bootstrap (BootstrapScene). Records the caller as root
// admin and TOFU-trusts THIS browser. Only valid while UNCLAIMED and the
// caller is eligible. Mirrors claimHandler's POST branch.
func handleGateClaim(w http.ResponseWriter, r *http.Request, email string, groups []string) {
	if !requireIdentity(w, email) {
		return
	}
	if serverClaimed() {
		writeJSONError(w, "server already claimed", http.StatusConflict)
		return
	}
	if !eligibleToClaim(email, groups) {
		writeJSONError(w, "not eligible to claim this server", http.StatusForbidden)
		return
	}
	// Re-check root admin under the request to avoid a TOCTOU double-claim
	// overwriting the recorded owner (matches claimHandler).
	if serverRootAdmin() == "" {
		if err := recordServerClaim(email); err != nil {
			writeJSONError(w, "record root admin: "+err.Error(), http.StatusInternalServerError)
			return
		}
	}
	rec, err := addDeviceWithOrigin(email, deviceNameFromRequest(r), deviceOriginRoot)
	if err != nil {
		writeJSONError(w, "claim (trust device): "+err.Error(), http.StatusInternalServerError)
		return
	}
	if err := setDeviceCookie(w, r, email, rec.ID); err != nil {
		writeJSONError(w, "claim (set cookie): "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// --- GET /bailey/api/pending-pair ---
//
// Mints (or refreshes — generatePendingPair is idempotent on email) this
// browser's 6-digit pairing code and reports whether it's been approved
// yet. ApprovalScene shows {code} and tells the user to read it to an
// admin; the SPA then polls /pending-pair/poll. totp_enrolled tells the
// SPA whether to also offer the authenticator self-trust tab.
func handleGatePendingPair(w http.ResponseWriter, r *http.Request, email string) {
	if !requireIdentity(w, email) {
		return
	}
	e, err := generatePendingPairUA(email, r.UserAgent())
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	rec, _ := loadTOTPRecord(email)
	writeJSON(w, map[string]any{
		"code":          e.Code,
		"approved":      e.ApprovedBy != "",
		"totp_enrolled": rec != nil,
		"expires_at":    e.ExpiresAt.UTC().Format(time.RFC3339),
	})
}

// --- GET /bailey/api/pending-pair/poll ---
//
// Quick (non-blocking) poll. When the pending pair has been approved by a
// trusted browser, this claims it, trusts THIS browser (device cookie),
// and returns {approved:true, redirect_path}. Otherwise {approved:false}.
// Mirrors pendingPairPollHandler but JSON-shaped for the SPA. (The
// approval itself is gated by approverIsTrusted on the approver's side —
// see mfa_pair.go — so an untrusted browser cannot self-approve.)
func handleGatePendingPairPoll(w http.ResponseWriter, r *http.Request, email string) {
	if !requireIdentity(w, email) {
		return
	}
	e := claimPendingPair(email)
	if e == nil {
		writeJSON(w, map[string]any{"approved": false})
		return
	}
	if _, err := completeNewDevicePairFor(w, r, email, e.ApproverInfo); err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if callerIsAdmin(email) {
		_ = setSessionCookie(w, r, email)
	}
	writeJSON(w, map[string]any{
		"approved":      true,
		"approver":      e.ApproverInfo,
		"redirect_path": originRedirectPath(r),
	})
}

// --- POST /bailey/api/self-trust ---
//
// ApprovalScene "Authenticator" tab. body {totp}. If the user has an
// authenticator enrolled and the code validates, trust THIS browser. The
// only self-trust path that needs no admin — legitimate because the user
// proved possession of their enrolled secret. Mirrors selfTrustHandler.
func handleGateSelfTrust(w http.ResponseWriter, r *http.Request, email string) {
	if !requireIdentity(w, email) {
		return
	}
	rec, err := loadTOTPRecord(email)
	if err != nil || rec == nil {
		writeJSONError(w, "no authenticator enrolled for this account", http.StatusForbidden)
		return
	}
	body := decodeGateBody(r)
	code := strings.TrimSpace(body.TOTP)
	if !totp.Validate(code, rec.Secret) {
		writeJSONError(w, "that code didn't match", http.StatusUnauthorized)
		return
	}
	if _, err := completeNewDevicePairFor(w, r, email, "self via authenticator"); err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"ok": true, "redirect_path": originRedirectPath(r)})
}

// --- POST /bailey/api/recover ---
//
// RecoveryScene. body {totp} OR {backup}. Validate the supplied factor
// (single-use backup code is burned on success) then trust THIS browser.
// Mirrors recoveryHandler. Requires at least one recovery method set up.
func handleGateRecover(w http.ResponseWriter, r *http.Request, email string) {
	if !requireIdentity(w, email) {
		return
	}
	rec, _ := loadTOTPRecord(email)
	totpEnrolled := rec != nil
	backupEnrolled := dbBackupCodesExist(email)
	if !totpEnrolled && !backupEnrolled {
		writeJSONError(w, "no recovery method set up; ask an admin to approve this device", http.StatusForbidden)
		return
	}
	body := decodeGateBody(r)
	if backup := strings.TrimSpace(body.Backup); backup != "" {
		ok, err := dbConsumeBackupCode(email, backup)
		if err != nil {
			writeJSONError(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if !ok {
			writeJSONError(w, "that backup code isn't valid", http.StatusUnauthorized)
			return
		}
		if _, err := completeNewDevicePairFor(w, r, email, "self via backup code"); err != nil {
			writeJSONError(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{"ok": true, "redirect_path": originRedirectPath(r)})
		return
	}
	// Authenticator recovery.
	if !totpEnrolled {
		writeJSONError(w, "authenticator not set up for this account", http.StatusForbidden)
		return
	}
	if !totp.Validate(strings.TrimSpace(body.TOTP), rec.Secret) {
		writeJSONError(w, "that code didn't match", http.StatusUnauthorized)
		return
	}
	if _, err := completeNewDevicePairFor(w, r, email, "self via authenticator recovery"); err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"ok": true, "redirect_path": originRedirectPath(r)})
}

// --- GET /bailey/api/totp/enroll ---
//
// Opt-in authenticator setup: provision a PENDING secret for THIS user
// and return it plus the otpauth:// URL so the SPA can render a QR. The
// secret is NOT persisted yet — POST /totp/verify confirms it. We stash
// the candidate in a path-scoped cookie so /verify can read it back
// (mirrors the cookie trick in mfa_totp.go / mfa_account.go), keeping the
// pending secret off the client's trust surface.
const gateEnrolCookieName = "_bailey_gate_enroll"

func handleGateTOTPEnroll(w http.ResponseWriter, r *http.Request, email string) {
	if !requireIdentity(w, email) {
		return
	}
	if rec, _ := loadTOTPRecord(email); rec != nil {
		writeJSONError(w, "authenticator already enrolled", http.StatusConflict)
		return
	}
	// Reuse the existing candidate if the user reloaded mid-enrol so the
	// QR they already scanned stays valid (see mfa_totp.go for the
	// double-encoding subtlety this avoids).
	var key *otp.Key
	if c, err := r.Cookie(gateEnrolCookieName); err == nil && c.Value != "" {
		if raw, derr := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(c.Value); derr == nil && len(raw) > 0 {
			key, _ = totp.Generate(totp.GenerateOpts{
				Issuer:      totpIssuerForRequest(r),
				AccountName: email,
				Secret:      raw,
			})
		}
	}
	if key == nil {
		k, err := totp.Generate(totp.GenerateOpts{
			Issuer:      totpIssuerForRequest(r),
			AccountName: email,
		})
		if err != nil {
			writeJSONError(w, "generate TOTP key: "+err.Error(), http.StatusInternalServerError)
			return
		}
		key = k
	}
	http.SetCookie(w, &http.Cookie{
		Name:     gateEnrolCookieName,
		Value:    key.Secret(),
		Path:     "/bailey/api/totp",
		MaxAge:   600,
		HttpOnly: true,
		Secure:   r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https",
		SameSite: http.SameSiteNoneMode,
	})
	writeJSON(w, map[string]any{
		"secret":      key.Secret(),
		"otpauth_url": key.URL(),
	})
}

// --- POST /bailey/api/totp/verify ---
//
// body {code}: validate against the pending candidate secret, persist the
// TOTP record, and — on FIRST enrolment — generate a fresh set of
// single-use backup codes (returned ONCE, plaintext, for the user to save
// — only hashes are stored). Returns {ok, backup_codes:[...]}.
func handleGateTOTPVerify(w http.ResponseWriter, r *http.Request, email string) {
	if !requireIdentity(w, email) {
		return
	}
	if rec, _ := loadTOTPRecord(email); rec != nil {
		writeJSONError(w, "authenticator already enrolled", http.StatusConflict)
		return
	}
	c, err := r.Cookie(gateEnrolCookieName)
	if err != nil || c.Value == "" {
		writeJSONError(w, "enrolment session expired — start over", http.StatusBadRequest)
		return
	}
	body := decodeGateBody(r)
	if !totp.Validate(strings.TrimSpace(body.Code), c.Value) {
		writeJSONError(w, "that code didn't match", http.StatusUnauthorized)
		return
	}
	if err := saveTOTPRecord(&totpRecord{
		Email:     email,
		Secret:    c.Value,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		writeJSONError(w, "save: "+err.Error(), http.StatusInternalServerError)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: gateEnrolCookieName, Value: "", Path: "/bailey/api/totp", MaxAge: -1})

	// First enrolment → mint backup codes so the user has a non-TOTP
	// recovery path immediately.
	codes, err := generateBackupCodes()
	if err != nil {
		writeJSONError(w, "generate backup codes: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if err := dbSaveBackupCodes(email, codes); err != nil {
		writeJSONError(w, "save backup codes: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"ok": true, "backup_codes": codes})
}

// --- POST /bailey/api/backup-codes/regenerate ---
//
// Replace the user's backup codes with a fresh set and return them once.
// Useful after they've used several, or lost the list. Returns
// {backup_codes:[...]}.
func handleGateBackupCodesRegenerate(w http.ResponseWriter, r *http.Request, email string) {
	if !requireIdentity(w, email) {
		return
	}
	codes, err := generateBackupCodes()
	if err != nil {
		writeJSONError(w, "generate backup codes: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if err := dbSaveBackupCodes(email, codes); err != nil {
		writeJSONError(w, "save backup codes: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{"backup_codes": codes})
}

// gateBody is the union of fields the gate-API POSTs accept. Each route
// reads only the field(s) it documents; absent fields are empty strings.
type gateBody struct {
	TOTP   string `json:"totp"`
	Backup string `json:"backup"`
	Code   string `json:"code"`
}

// decodeGateBody parses a JSON body, falling back to form values so the
// endpoints work from both fetch(JSON) and a plain form POST. A malformed
// body just yields a zero gateBody (the route then rejects empty codes),
// so this never panics on junk input.
func decodeGateBody(r *http.Request) gateBody {
	var b gateBody
	ct := r.Header.Get("Content-Type")
	if strings.HasPrefix(ct, "application/json") {
		_ = json.NewDecoder(r.Body).Decode(&b)
		return b
	}
	if err := r.ParseForm(); err == nil {
		b.TOTP = r.FormValue("totp")
		b.Backup = r.FormValue("backup")
		b.Code = r.FormValue("code")
		// Some callers send the authenticator code as "code" on self-trust.
		if b.TOTP == "" {
			b.TOTP = r.FormValue("code")
		}
	}
	return b
}

// backupCodeCount / backupCodeGroups define the shape of a generated
// backup code: backupCodeGroups groups of 4 base32 chars, dash-joined
// (e.g. "A1B2-C3D4"). Stored hashed; the dashes/case are normalised away
// on entry (normalizeBackupCode), so display format is cosmetic.
const (
	backupCodeCount  = 10
	backupCodeGroups = 2
	backupCodeChars  = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // Crockford-ish: no I/O/0/1
)

// generateBackupCodes returns backupCodeCount fresh single-use codes
// using crypto/rand. Caller persists them with dbSaveBackupCodes (which
// hashes) and returns the plaintext to the user exactly once.
func generateBackupCodes() ([]string, error) {
	out := make([]string, 0, backupCodeCount)
	for i := 0; i < backupCodeCount; i++ {
		var groups []string
		for g := 0; g < backupCodeGroups; g++ {
			var sb strings.Builder
			for c := 0; c < 4; c++ {
				n, err := rand.Int(rand.Reader, big.NewInt(int64(len(backupCodeChars))))
				if err != nil {
					return nil, err
				}
				sb.WriteByte(backupCodeChars[n.Int64()])
			}
			groups = append(groups, sb.String())
		}
		out = append(out, strings.Join(groups, "-"))
	}
	return out, nil
}

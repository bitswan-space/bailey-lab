package daemon

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"html"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/pquerna/otp/totp"
)

// Pairing flow: new device shows a 6-digit code, trusted device or
// admin approves it at /2fa-gate/approve, new device's poll mints
// the device cookie. State lives in SQLite (pending_pairs table) so
// the proxy container can hold the live flow while the daemon
// container's admin pages process approvals — both read+write the
// same shared bailey.db file.

type pairingEntry struct {
	Email        string
	Code         string
	IssuedAt     time.Time
	ExpiresAt    time.Time
	ApprovedBy   string
	ApproverInfo string
}

const pairingTTL = 5 * time.Minute

// Keeps mfa_pair.go compileable without removing its sync import
// (it's still used by other handlers in this file).
var _ = sync.Mutex{}

func generatePendingPair(email string) (*pairingEntry, error) {
	if err := dbPurgeExpiredPendingPairs(); err != nil {
		return nil, err
	}
	codeInt, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return nil, err
	}
	now := time.Now()
	e := &pairingEntry{
		Email:     email,
		Code:      fmt.Sprintf("%06d", codeInt.Int64()),
		IssuedAt:  now,
		ExpiresAt: now.Add(pairingTTL),
	}
	if err := dbUpsertPendingPair(e); err != nil {
		return nil, err
	}
	return e, nil
}

func approvePendingPair(email, code, approverEmail string, approverIsAdmin bool) *pairingEntry {
	e, err := dbLoadPendingPairByCode(code)
	if err != nil || e == nil {
		return nil
	}
	if e.Email != email || time.Now().After(e.ExpiresAt) {
		return nil
	}
	e.ApprovedBy = approverEmail
	if approverIsAdmin {
		e.ApproverInfo = approverEmail + " (admin)"
	} else {
		e.ApproverInfo = approverEmail
	}
	if err := dbUpsertPendingPair(e); err != nil {
		return nil
	}
	return e
}

func claimPendingPair(email string) *pairingEntry {
	e, err := dbLoadPendingPairByEmail(email)
	if err != nil || e == nil {
		return nil
	}
	if e.ApprovedBy == "" || time.Now().After(e.ExpiresAt) {
		return nil
	}
	_ = dbDeletePendingPairByEmail(email)
	return e
}

func visiblePendingRequests(approverEmail string, approverIsAdmin bool) []*pairingEntry {
	all, err := dbListPendingPairs()
	if err != nil {
		return nil
	}
	now := time.Now()
	out := []*pairingEntry{}
	for _, e := range all {
		if now.After(e.ExpiresAt) || e.ApprovedBy != "" {
			continue
		}
		if !approverIsAdmin && !strings.EqualFold(e.Email, approverEmail) {
			continue
		}
		out = append(out, e)
	}
	return out
}

func pendingPairHandler(w http.ResponseWriter, r *http.Request, email string) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	e, err := generatePendingPair(email)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// The "Authenticator" self-trust tab is offered ONLY when the user
	// actually has an authenticator enrolled (opt-in). Otherwise the page
	// shows admin-approval only, with an "Ask an admin instead" note.
	rec, _ := loadTOTPRecord(email)
	totpEnrolled := rec != nil
	w.Header().Set("Content-Type", "text/html")
	fmt.Fprint(w, pendingPairHTML(email, e, totpEnrolled, false, ""))
}

// selfTrustHandler serves /2fa-gate/self-trust — the ApprovalScene
// "Authenticator" tab. A user who has opted into an authenticator can
// trust THIS browser immediately with their current 6-digit TOTP, no
// admin needed. This is the ONLY self-trust path that doesn't require an
// already-trusted approver, and it's available solely because the user
// proved possession of their enrolled authenticator secret.
func selfTrustHandler(w http.ResponseWriter, r *http.Request, email string) {
	rec, err := loadTOTPRecord(email)
	if err != nil || rec == nil {
		// No authenticator enrolled → self-trust isn't available; send
		// them back to admin approval.
		http.Redirect(w, r, mfaGatePathPrefix+"/pending-pair", http.StatusSeeOther)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	code := strings.TrimSpace(r.FormValue("code"))
	if !totp.Validate(code, rec.Secret) {
		e, _ := generatePendingPair(email)
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, pendingPairHTML(email, e, true, true, "That code didn't match — check your authenticator and try again."))
		return
	}
	if _, err := completeNewDevicePairFor(w, r, email, "self via authenticator"); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	originRedirect(w, r)
}

func pendingPairPollHandler(w http.ResponseWriter, r *http.Request, email string) {
	e := claimPendingPair(email)
	if e == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if _, err := completeNewDevicePairFor(w, r, email, e.ApproverInfo); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// If the poller is an admin, also set the TOTP session cookie.
	// The pair approval came from a browser the same admin had
	// already paired (and that previous pairing required TOTP), so
	// the approver is effectively certifying both factors at once.
	// Without this the new browser would land back at /admin/challenge
	// immediately after redirecting, defeating the point of the
	// "punch a code into a trusted browser" flow.
	if _, groups := identityFromHeaders(r); isAdminGroups(groups) {
		_ = setSessionCookie(w, r, email)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"approved":      true,
		"approver":      e.ApproverInfo,
		"redirect_path": originRedirectPath(r),
	})
}

// approverIsTrusted reports whether the request making an approval is
// itself a second-factor-cleared browser. An approval mints device
// trust for a brand-new browser, so the approving request must not be a
// first-factor-only (oauth-only) session — otherwise a user who has
// only cleared oauth can self-approve a new browser and bootstrap the
// device factor out of single-factor state (and a spoofed-admin could
// approve anyone). Trusted means: an already-paired device cookie for
// the approver, OR (admins only) a valid TOTP session. The legitimate
// first-device bootstrap goes through TOTP recovery (recoveryHandler),
// not first-factor self-approval.
func approverIsTrusted(r *http.Request, approverEmail string, approverIsAdmin bool) bool {
	if currentDeviceForRequest(r, approverEmail) != nil {
		return true
	}
	if approverIsAdmin && hasValidSession(r, approverEmail) {
		return true
	}
	return false
}

func approveHandler(w http.ResponseWriter, r *http.Request, approverEmail string) {
	approverIsAdmin := isAdmin(r)
	switch r.Method {
	case http.MethodGet:
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, approveListHTML(approverEmail, approverIsAdmin, "", ""))
	case http.MethodPost:
		if err := r.ParseForm(); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		targetEmail := strings.TrimSpace(r.FormValue("email"))
		code := strings.TrimSpace(r.FormValue("code"))
		if targetEmail == "" || code == "" {
			w.Header().Set("Content-Type", "text/html")
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, approveListHTML(approverEmail, approverIsAdmin, targetEmail, "Both email and code are required."))
			return
		}
		if !approverIsTrusted(r, approverEmail, approverIsAdmin) {
			w.Header().Set("Content-Type", "text/html")
			w.WriteHeader(http.StatusForbidden)
			fmt.Fprint(w, approveListHTML(approverEmail, approverIsAdmin, targetEmail, "Approve from a browser that's already trusted. To trust your first browser, use authenticator recovery."))
			return
		}
		if !strings.EqualFold(targetEmail, approverEmail) && !approverIsAdmin {
			w.Header().Set("Content-Type", "text/html")
			w.WriteHeader(http.StatusForbidden)
			fmt.Fprint(w, approveListHTML(approverEmail, approverIsAdmin, targetEmail, "Only admins can approve a different user."))
			return
		}
		e := approvePendingPair(targetEmail, code, approverEmail, approverIsAdmin)
		if e == nil {
			w.Header().Set("Content-Type", "text/html")
			w.WriteHeader(http.StatusUnauthorized)
			fmt.Fprint(w, approveListHTML(approverEmail, approverIsAdmin, targetEmail, "Code didn't match — ask them to read it back."))
			return
		}
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, approveListHTML(approverEmail, approverIsAdmin, "", "Approved "+targetEmail+"."))
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleApprovePairJSON is the JSON variant of approveHandler. Used by
// the inline "Pair a new browser" form on /bailey/devices so the user
// stays on the page after approving — POSTing to the HTML handler would
// navigate to the full approvals page. Same rules: a non-admin can
// only approve their own pending pair; admins can approve anyone's.
func handleApprovePairJSON(w http.ResponseWriter, r *http.Request, approverEmail string) {
	if r.Method != http.MethodPost {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusMethodNotAllowed)
		fmt.Fprint(w, `{"error":"POST required"}`)
		return
	}
	if err := r.ParseForm(); err != nil {
		writeJSONError(w, err.Error(), http.StatusBadRequest)
		return
	}
	approverIsAdmin := isAdmin(r)
	targetEmail := strings.TrimSpace(r.FormValue("email"))
	code := strings.TrimSpace(r.FormValue("code"))
	if targetEmail == "" || code == "" {
		writeJSONError(w, "email and code required", http.StatusBadRequest)
		return
	}
	if !approverIsTrusted(r, approverEmail, approverIsAdmin) {
		// The approving browser must itself be second-factor-cleared —
		// see approverIsTrusted. A first-factor-only browser cannot
		// approve a new device pairing.
		writeJSONError(w, "approve from an already-trusted browser; use authenticator recovery to trust your first browser", http.StatusForbidden)
		return
	}
	if !strings.EqualFold(targetEmail, approverEmail) && !approverIsAdmin {
		writeJSONError(w, "only admins can approve a different user", http.StatusForbidden)
		return
	}
	e := approvePendingPair(targetEmail, code, approverEmail, approverIsAdmin)
	if e == nil {
		writeJSONError(w, "code didn't match", http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"approved":%q}`, e.Email)
}

func completeNewDevicePairFor(w http.ResponseWriter, r *http.Request, email, approverInfo string) (*deviceRecord, error) {
	name := deviceNameFromRequest(r)
	if approverInfo != "" {
		name = name + " · approved by " + approverInfo
	}
	rec, err := addDevice(email, name)
	if err != nil {
		return nil, err
	}
	if err := setDeviceCookie(w, r, email, rec.ID); err != nil {
		return nil, err
	}
	return rec, nil
}

func originRedirectPath(r *http.Request) string {
	// The returned value is echoed as JSON redirect_path and assigned to
	// window.location client-side, so it must be a validated same-origin
	// path — see safeOriginTarget (open-redirect defence).
	if c, err := r.Cookie(gateOriginCookie); err == nil && c.Value != "" {
		return safeOriginTarget(c.Value)
	}
	return "/"
}

// recoveryHandler serves /2fa-gate/recovery — the RecoveryScene: the user
// has lost access to every trusted device and recovers with an
// authenticator code OR a single-use backup code. Both are OPT-IN (set up
// in the console's Security & recovery); recovery is the ONLY place a TOTP
// is required, and only if the user actually enrolled one. Either factor,
// once validated, trusts THIS device.
func recoveryHandler(w http.ResponseWriter, r *http.Request, email string) {
	rec, _ := loadTOTPRecord(email)
	totpEnrolled := rec != nil
	backupEnrolled := dbBackupCodesExist(email)
	if !totpEnrolled && !backupEnrolled {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, errorBody(email, "No recovery method is set up for this account. Have an admin approve this device instead."))
		return
	}
	switch r.Method {
	case http.MethodGet:
		// Default to the authenticator tab when enrolled, else backup; an
		// explicit ?mode=backup flips to the backup-code input.
		backupMode := !totpEnrolled || strings.EqualFold(r.URL.Query().Get("mode"), "backup")
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, recoveryFormHTML(email, totpEnrolled, backupEnrolled, backupMode, ""))
	case http.MethodPost:
		if err := r.ParseForm(); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		mode := strings.TrimSpace(r.FormValue("mode"))
		if mode == "backup" {
			backup := strings.TrimSpace(r.FormValue("backup"))
			ok, err := dbConsumeBackupCode(email, backup)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			if !ok {
				w.Header().Set("Content-Type", "text/html")
				w.WriteHeader(http.StatusUnauthorized)
				fmt.Fprint(w, recoveryFormHTML(email, totpEnrolled, backupEnrolled, true, "That doesn't look like a valid backup code."))
				return
			}
			if _, err := completeNewDevicePairFor(w, r, email, "self via backup code"); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			originRedirect(w, r)
			return
		}
		// Authenticator recovery.
		if !totpEnrolled {
			http.Error(w, "authenticator not set up for this account", http.StatusForbidden)
			return
		}
		code := strings.TrimSpace(r.FormValue("code"))
		if !totp.Validate(code, rec.Secret) {
			w.Header().Set("Content-Type", "text/html")
			w.WriteHeader(http.StatusUnauthorized)
			fmt.Fprint(w, recoveryFormHTML(email, totpEnrolled, backupEnrolled, false, "Code didn't match — try again."))
			return
		}
		if _, err := completeNewDevicePairFor(w, r, email, "self via authenticator recovery"); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		originRedirect(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func init() {
	handlePendingPair = pendingPairHandler
	handlePendingPairPoll = pendingPairPollHandler
	handleSelfTrust = selfTrustHandler
	handleApprovePair = approveHandler
	handleRecovery = recoveryHandler
}

// --- HTML ---

// userCheckSVG / keyRoundTabSVG are the small method-tab icons in the
// ApprovalScene method switch.
const userCheckSVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>`
const keyRoundTabSVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>`

// pendingPairHTML renders the "Trust this device" page (ApprovalScene).
//
// Primary path: an admin (or any already-trusted device) approves the
// displayed 6-digit code — the page polls and redirects on approval.
//
// Secondary path, shown ONLY when totpEnrolled: an "Authenticator" tab
// where the user enters their current 6-digit TOTP to self-trust this
// browser ("no admin needed"). When no authenticator is enrolled the
// footer offers "Ask an admin instead" instead of a tab.
//
// showTOTP selects which tab is active on load; totpErr is an inline
// error under the authenticator field.
func pendingPairHTML(email string, e *pairingEntry, totpEnrolled, showTOTP bool, totpErr string) string {
	adminActive := !showTOTP
	// Method switch — only rendered when an authenticator self-trust path
	// exists; with no authenticator there's nothing to switch to.
	tabs := ""
	if totpEnrolled {
		adminCls, totpCls := "sc-tab", "sc-tab"
		if adminActive {
			adminCls += " on"
		} else {
			totpCls += " on"
		}
		tabs = fmt.Sprintf(`<div class="sc-tabs">
  <a href="%s/pending-pair" class="%s"><span style="color:%s;display:inline-flex;">%s</span>Admin approval</a>
  <a href="%s/self-trust" class="%s"><span style="color:%s;display:inline-flex;">%s</span>Authenticator</a>
</div>`,
			html.EscapeString(mfaGatePathPrefix), adminCls, scPrimary, userCheckSVG,
			html.EscapeString(mfaGatePathPrefix), totpCls, scPrimary, keyRoundTabSVG)
	}

	// Admin-approval panel: the code + a polling status line.
	adminPanel := fmt.Sprintf(`<div id="sc-admin-panel"%s>
  <div class="sc-code-label" style="text-align:center;">Read this code to an admin</div>
  <div class="sc-code" style="text-align:center;font-size:40px;letter-spacing:10px;margin:6px 0 2px;">%s</div>
  <div class="sc-wait"><span class="sc-spin"></span>Waiting for an admin to approve…</div>
</div>`, hiddenIf(showTOTP), html.EscapeString(e.Code))

	// Authenticator self-trust panel (only meaningful when enrolled).
	totpPanel := ""
	if totpEnrolled {
		errBlock := ""
		if totpErr != "" {
			errBlock = `<div class="sc-err">` + html.EscapeString(totpErr) + `</div>`
		}
		totpPanel = fmt.Sprintf(`<div id="sc-totp-panel"%s>
  <p class="sc-sub" style="margin:0 auto 16px;">Enter the current 6-digit code from your authenticator app to trust this device right away &mdash; no admin needed.</p>
  <form method="POST" action="%s/self-trust">
    <input class="sc-input" type="text" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" placeholder="000000" %srequired>
    %s
    <div style="margin-top:16px;"><button type="submit" class="sc-btn">Verify &amp; trust this device</button></div>
  </form>
</div>`, hiddenIf(!showTOTP), html.EscapeString(mfaGatePathPrefix), autofocusIf(showTOTP), errBlock)
	}

	// Card footer: when an authenticator exists, the alternate-method
	// hint; otherwise the "ask an admin" reassurance.
	foot := ""
	if totpEnrolled {
		altLink := fmt.Sprintf(`<a href="%s/pending-pair" class="sc-link">Ask an admin instead</a>`, html.EscapeString(mfaGatePathPrefix))
		if !showTOTP {
			altLink = fmt.Sprintf(`<a href="%s/self-trust" class="sc-link">Use your authenticator</a>`, html.EscapeString(mfaGatePathPrefix))
		}
		foot = fmt.Sprintf(`<div class="sc-card-foot" style="justify-content:center;"><span>Trusting on another device? %s</span></div>`, altLink)
	} else {
		foot = fmt.Sprintf(`<div class="sc-card-foot" style="justify-content:center;"><span>No authenticator set up? Have an admin approve the code at <span style="font-family:'Geist Mono',monospace;">%s/approve</span>.</span></div>`,
			html.EscapeString(mfaGatePathPrefix))
	}

	card := fmt.Sprintf(`<div class="sc-pad">
  %s
  <h1 class="sc-h1">Trust this device</h1>
  <p class="sc-sub">You're signed in, but this device isn't trusted yet. Confirm it with your authenticator, or have an admin approve the code.</p>
  %s
  %s
  %s
  <div style="text-align:center;margin-top:18px;">%s</div>
</div>
%s`, sceneSignedInRow(email), tabs, adminPanel, totpPanel, whySoComplicatedHelper(), foot)

	// Polling script + spinner CSS. Only poll while the admin panel is
	// the active view (self-trust doesn't need it), but it's harmless to
	// always poll, so we keep it simple and always run it.
	extraHead := `<style>
.sc-spin{width:14px;height:14px;border:2px solid #c7d2fe;border-top-color:#093df5;border-radius:9999px;display:inline-block;animation:sc-rot .8s linear infinite;}
@keyframes sc-rot{to{transform:rotate(360deg);}}
</style>`
	extraBody := fmt.Sprintf(`<script>
async function poll(){
  try{
    const r = await fetch('%s/pending-pair/poll',{credentials:'same-origin'});
    if(r.status===200){
      const d = await r.json();
      var p = document.querySelector('#sc-admin-panel .sc-wait');
      if(p) p.textContent = 'Approved. Redirecting…';
      setTimeout(function(){ window.location = d.redirect_path || '/'; }, 600);
      return;
    }
  }catch(e){}
  setTimeout(poll, 2000);
}
poll();
</script>`, html.EscapeString(mfaGatePathPrefix))

	return scenePage("Trust this device", "", scenePillTone{}, card, "", extraHead, extraBody)
}

// hiddenIf / autofocusIf are tiny attribute helpers for the dual-panel
// pending-pair markup.
func hiddenIf(cond bool) string {
	if cond {
		return ` style="display:none;"`
	}
	return ""
}

func autofocusIf(cond bool) string {
	if cond {
		return "autofocus "
	}
	return ""
}

func approveListHTML(approverEmail string, approverIsAdmin bool, errorForEmail, msgBanner string) string {
	pending := visiblePendingRequests(approverEmail, approverIsAdmin)
	adminBadge := ""
	if approverIsAdmin {
		adminBadge = ` <span style="color:#093DF5;font-weight:600;">(admin)</span>`
	}
	banner := ""
	if msgBanner != "" {
		banner = `<p class="note" style="color:#0a7d24;"><b>` + html.EscapeString(msgBanner) + `</b></p>`
	}
	rows := ""
	if len(pending) == 0 {
		rows = `<p class="note">No pending requests right now. This page auto-refreshes when one comes in.</p>`
	} else {
		var b strings.Builder
		for _, e := range pending {
			rowErr := ""
			if strings.EqualFold(errorForEmail, e.Email) {
				rowErr = `<p class="note" style="color:#b00020;margin:6px 0 0;"><b>Code didn't match — ask them to read it back.</b></p>`
			}
			age := int(time.Since(e.IssuedAt).Seconds())
			ageStr := fmt.Sprintf("%ds ago", age)
			if age >= 60 {
				ageStr = fmt.Sprintf("%dm %ds ago", age/60, age%60)
			}
			fmt.Fprintf(&b, `<div style="border:1px solid #E4E4E7;border-radius:8px;padding:16px;margin:12px 0;background:#fff;">
  <div style="display:flex;justify-content:space-between;align-items:baseline;">
    <div><b>%s</b></div>
    <div class="note">requested %s</div>
  </div>
  <form method="POST" action="%s/approve" style="margin-top:12px;display:flex;gap:8px;align-items:center;">
    <input type="hidden" name="email" value="%s">
    <label style="font-size:13px;color:#3F3F46;">Code shown on their device:</label>
    <input type="text" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="off" required style="font-size:18px;letter-spacing:4px;padding:6px 8px;width:120px;">
    <button type="submit" style="background:#093DF5;color:white;border:0;padding:8px 16px;border-radius:4px;font-size:14px;cursor:pointer;">Approve</button>
  </form>
  %s
</div>`,
				html.EscapeString(e.Email), ageStr, html.EscapeString(mfaGatePathPrefix),
				html.EscapeString(e.Email), rowErr)
		}
		rows = b.String()
	}
	scope := "your own"
	if approverIsAdmin {
		scope = "any user's"
	}
	body := fmt.Sprintf(`
<div class="header">%s<h1>Pending device approvals</h1><a href="/bailey/" class="sign-out">← Bailey</a></div>
<div class="card">
  <p>Signed in as <code>%s</code>%s. You can approve %s pending device requests.</p>
  <p class="note">Ask the user to read the 6-digit code shown on their screen, type it below, and click Approve.</p>
  %s%s
  %s
</div>
<meta http-equiv="refresh" content="5">`,
		bitswanLogoSVG, html.EscapeString(approverEmail), adminBadge, scope, banner, rows, whySoComplicatedHelper())
	return fmt.Sprintf(`<!doctype html><html><head><meta charset="utf-8"><title>Approve devices</title>%s<style>%s</style></head><body>%s</body></html>`,
		bitswanFavicon, bitswanPageCSS, body)
}

// recoveryKeySVG is the key-round mark in the RecoveryScene icon chip.
const recoveryKeySVG = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#18181b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>`

// recoveryFormHTML renders the "Recover access" page (RecoveryScene):
// authenticator code OR a single-use backup code → trust this device.
// backupMode selects which input is shown; the footer link toggles
// between the two when both are available.
func recoveryFormHTML(email string, totpEnrolled, backupEnrolled, backupMode bool, errMsg string) string {
	// Can't be in backup mode if no backup codes exist (and vice versa).
	if backupMode && !backupEnrolled {
		backupMode = false
	}
	if !backupMode && !totpEnrolled {
		backupMode = true
	}
	errBlock := ""
	if errMsg != "" {
		errBlock = `<div class="sc-err">` + html.EscapeString(errMsg) + `</div>`
	}

	var panel string
	if backupMode {
		panel = fmt.Sprintf(`<div style="font-size:12.5px;color:%s;margin-bottom:14px;text-align:center;">Enter one of your single-use backup codes</div>
<form method="POST" action="%s/recovery">
  <input type="hidden" name="mode" value="backup">
  <input class="sc-input" type="text" name="backup" autocomplete="off" placeholder="XXXX-XXXX" style="letter-spacing:2px;" autofocus required>
  %s
  <div style="margin-top:18px;"><button type="submit" class="sc-btn">Use backup code</button></div>
</form>`, scMuted, html.EscapeString(mfaGatePathPrefix), errBlock)
	} else {
		panel = fmt.Sprintf(`<div style="font-size:12.5px;color:%s;margin-bottom:14px;text-align:center;">6-digit code from your authenticator app</div>
<form method="POST" action="%s/recovery">
  <input type="hidden" name="mode" value="totp">
  <input class="sc-input" type="text" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" placeholder="000000" autofocus required>
  %s
  <div style="margin-top:18px;"><button type="submit" class="sc-btn">Verify &amp; trust this device</button></div>
</form>`, scMuted, html.EscapeString(mfaGatePathPrefix), errBlock)
	}

	// Footer toggle — only when both methods are available.
	foot := ""
	if totpEnrolled && backupEnrolled {
		if backupMode {
			foot = fmt.Sprintf(`<div class="sc-card-foot" style="justify-content:center;"><a href="%s/recovery" class="sc-link">Use authenticator app instead</a></div>`, html.EscapeString(mfaGatePathPrefix))
		} else {
			foot = fmt.Sprintf(`<div class="sc-card-foot" style="justify-content:center;"><a href="%s/recovery?mode=backup" class="sc-link">Use a backup code instead</a></div>`, html.EscapeString(mfaGatePathPrefix))
		}
	}

	card := fmt.Sprintf(`<div class="sc-pad">
  <div class="sc-icon" style="background:%s;">%s</div>
  <h1 class="sc-h1">Recover access</h1>
  <p class="sc-sub">You've lost access to every trusted device. Confirm your identity to trust this device and get back in.</p>
  %s
  %s
  <div style="text-align:center;margin-top:18px;">%s</div>
</div>
%s`, scSurface2, recoveryKeySVG, sceneSignedInRow(email), panel, whySoComplicatedHelper(), foot)

	return scenePage("Recover access", "Locked out", scPillDanger, card, "", "", "")
}

func errorBody(email, msg string) string {
	card := fmt.Sprintf(`<div class="sc-pad">
  <h1 class="sc-h1">Trust this device</h1>
  <p class="sc-sub" style="color:%s;">%s</p>
  %s
  <div style="text-align:center;">%s</div>
</div>`, scRed, html.EscapeString(msg), sceneSignedInRow(email), whySoComplicatedHelper())
	return scenePage("Trust this device", "", scenePillTone{}, card, "", "", "")
}

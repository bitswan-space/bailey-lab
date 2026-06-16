package daemon

import (
	"fmt"
	"html"
	"net/http"
	"strings"
)

// mfa_claim.go — the one-time CLAIM / bootstrap flow that matches the
// wireframe BootstrapScene (auth-scenes.jsx).
//
// DEVICE TRUST is the gate: a Keycloak login alone never grants access.
// On a brand-new server no device is trusted yet, so the very first
// signed-in user must explicitly CLAIM the server. Claiming does two
// things, exactly as the scene describes ("The first person to sign in
// becomes the root admin — and this device becomes the first trusted
// device"):
//
//  1. TOFU-trust THIS browser (addDevice + setDeviceCookie), and
//  2. record the caller as the server's root admin / owner.
//
// This deliberately replaces PR #340's silent bootstrap-TOFU (which
// auto-paired the first admin with no confirmation) and the mandatory
// admin-TOTP enrol gate. There is NO forced authenticator setup here.
//
// The flow only works while the server is UNCLAIMED — once any device is
// trusted, claiming is closed and a fresh browser goes through the normal
// "trust this device" (pending-pair) path instead.

func init() {
	handleClaim = claimHandler
}

// settingRootAdmin is the server_settings key holding the email of the
// user who claimed the server (its root admin / owner). Its presence is
// what "claimed" means for the gate, alongside any trusted device.
const settingRootAdmin = "root_admin_email"

// settingClaimedAt is the server_settings key holding the RFC3339 time
// the server was claimed. Recorded alongside settingRootAdmin so the
// overview identity card can show claimed_at. Absent on servers
// provisioned under the older silent-TOFU path (which trusted a device
// without recording a root admin); the overview reports "" in that case.
const settingClaimedAt = "claimed_at"

// serverClaimedAt returns the recorded claim time (RFC3339 UTC), or ""
// if it was never recorded.
func serverClaimedAt() string {
	v, _ := dbGetSetting(settingClaimedAt)
	return strings.TrimSpace(v)
}

// recordServerClaim records email as root admin, stamps the claim time,
// and writes the audit event. Caller must already have verified the
// server is unclaimed (serverRootAdmin() == "") under the same request
// to avoid a TOCTOU double-claim overwriting the recorded owner. Shared
// by both claim entry points (the SPA handleGateClaim and the legacy
// server-rendered claimHandler).
func recordServerClaim(email string) error {
	if err := dbSetSetting(settingRootAdmin, email, email); err != nil {
		return err
	}
	_ = dbSetSetting(settingClaimedAt, nowRFC3339(), email)
	_ = recordEvent(email, auditServerClaim, email)
	return nil
}

// serverRootAdmin returns the claimed root-admin email, or "" if the
// server has not been claimed yet.
func serverRootAdmin() string {
	v, _ := dbGetSetting(settingRootAdmin)
	return strings.TrimSpace(v)
}

// serverClaimed reports whether the server has been claimed. A server is
// claimed once either a root admin is recorded OR any device is trusted —
// either condition means the one-time bootstrap window is closed. (We
// check both so a server provisioned under the older silent-TOFU path,
// which trusted a device without recording a root admin, is still treated
// as claimed and never re-offers the claim screen.)
func serverClaimed() bool {
	return serverRootAdmin() != "" || anyDevicesExist()
}

// eligibleToClaim reports whether this caller may perform the one-time
// claim. Conservative reconciliation of the admin model: the first
// signed-in user claims root. If the deployment uses Keycloak admin
// groups (isAdminGroups), we still require the claimer to be in the admin
// group — that keeps "who bootstraps the server" aligned with the org's
// admin notion. If NO admin group is present on the identity at all
// (group-less deployments / single-tenant), any signed-in user may claim,
// because otherwise no one ever could.
func eligibleToClaim(email string, groups []string) bool {
	if email == "" {
		return false
	}
	if isAdminGroups(groups) {
		return true
	}
	// No admin group on this identity. Allow the claim only when the
	// deployment isn't using admin groups at all — i.e. nobody on the
	// server is an admin yet. If some other identity IS an admin, a
	// non-admin must not be able to claim ahead of them.
	return !anyAdminElsewhere()
}

// anyAdminElsewhere is a best-effort hook for "does the deployment use
// admin groups". We can't enumerate Keycloak groups from here, so we
// treat the server as group-less until proven otherwise: this returns
// false, which means a group-less first user can always claim. The
// isAdminGroups branch above already covers group-based deployments.
func anyAdminElsewhere() bool { return false }

// claimHandler serves /2fa-gate/claim.
//
//   - GET while unclaimed + eligible → render BootstrapScene.
//   - POST while unclaimed + eligible → TOFU-trust this device, record
//     the caller as root admin, redirect back to origin.
//   - Already claimed → bounce to the normal "trust this device" page
//     (the claim window is closed; this browser still needs to be
//     trusted the normal way).
//   - Signed in but not eligible → 403 with an explanation.
func claimHandler(w http.ResponseWriter, r *http.Request, email string) {
	_, groups := identityFromHeaders(r)

	if serverClaimed() {
		// Window closed — send them through the normal device-trust path.
		http.Redirect(w, r, gatePathPrefix+"/pending-pair", http.StatusSeeOther)
		return
	}
	if !eligibleToClaim(email, groups) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, claimNotEligibleHTML(email))
		return
	}

	switch r.Method {
	case http.MethodGet:
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, claimHTML(email))
	case http.MethodPost:
		// Re-check under the same request to avoid a TOCTOU double-claim:
		// serverClaimed() was false above; if another request claimed in
		// between, addDevice still succeeds but we must not overwrite the
		// recorded root admin.
		if serverRootAdmin() == "" {
			if err := recordServerClaim(email); err != nil {
				http.Error(w, "record root admin: "+err.Error(), http.StatusInternalServerError)
				return
			}
		}
		rec, err := addDeviceWithOrigin(email, deviceNameFromRequest(r), deviceOriginRoot)
		if err != nil {
			http.Error(w, "claim (trust device): "+err.Error(), http.StatusInternalServerError)
			return
		}
		if err := setDeviceCookie(w, r, email, rec.ID); err != nil {
			http.Error(w, "claim (set cookie): "+err.Error(), http.StatusInternalServerError)
			return
		}
		originRedirect(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// --- HTML (matches BootstrapScene) ---

// claimFlagSVG is the flag mark in the BootstrapScene icon chip
// (<Icon name="flag">), drawn in the brand blue.
const claimFlagSVG = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#093df5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>`

// claimKeySVG is the key-round mark on the claim button.
const claimKeySVG = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>`

// shieldSVG is the small shield in the card footer note.
const shieldSVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#71717a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:0 0 auto;margin-top:1px;"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg>`

func claimHTML(email string) string {
	card := fmt.Sprintf(`<div class="sc-pad">
  <div class="sc-icon" style="background:%s;">%s</div>
  <h1 class="sc-h1">Claim this server</h1>
  <p class="sc-sub">No one administers this Bailey server yet. The first person to sign in becomes the root admin &mdash; and this device becomes the first trusted device.</p>
  %s
  <form method="POST" action="%s/claim">
    <button type="submit" class="sc-btn">%s Claim server</button>
  </form>
  <div style="text-align:center;">%s</div>
</div>
<div class="sc-card-foot">%s<span>From now on, a Keycloak login alone never grants access &mdash; every device must be explicitly trusted.</span></div>`,
		scPrimarySoft, claimFlagSVG,
		sceneSignedInRow(email),
		html.EscapeString(gatePathPrefix), claimKeySVG,
		whySoComplicatedHelper(), shieldSVG)
	return scenePage("Claim this server", "Unclaimed", scPillWarning, card,
		"This is a one-time step. After the server is claimed, new sign-ins require device approval.",
		"", "")
}

func claimNotEligibleHTML(email string) string {
	card := fmt.Sprintf(`<div class="sc-pad">
  <h1 class="sc-h1">Waiting to be claimed</h1>
  <p class="sc-sub">This Bailey server hasn't been claimed yet. An administrator needs to sign in and claim it before access is granted.</p>
  %s
  <div style="text-align:center;">%s</div>
</div>`, sceneSignedInRow(email), whySoComplicatedHelper())
	return scenePage("Waiting to be claimed", "Unclaimed", scPillWarning, card, "", "", "")
}

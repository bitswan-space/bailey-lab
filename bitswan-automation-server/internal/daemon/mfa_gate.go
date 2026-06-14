package daemon

import (
	"net/http"
	"os"
	"strings"
)

// MFA gate constants + origin-cookie helpers.
//
// The bulk of the original mfa_gate.go (the reverse-proxy wiring,
// enforceMFAGate, enforceEndpointACL, isBaileyHost, requestEndpointHost,
// isAdminGroups, handleGatePath, upstreamForHost, workspaceFromLabel,
// stripCSPFrameAncestors) has already landed in the monorepo under
// protected_gate.go / auth.go / inner_host.go, where it diverged
// (e.g. gateListenAddr/gatePathPrefix, startProtectedGate,
// gateHandler, enforceProtectedGate). Those are integrated by the
// human, so this file carries only the pieces the existing mfa_*
// files (mfa_pair.go, mfa_account.go, mfa_totp.go) reference but which
// nothing else defines yet:
//
//   - mfaGatePathPrefix: the URL prefix the MFA/account/pair handlers
//     mount their pages under.
//   - gateOriginCookie + rememberOrigin/originRedirect: the
//     remember-where-you-were-going round trip used by the TOTP and
//     pairing redirects so a user lands back on the page they wanted
//     after clearing the gate.
const (
	mfaGatePathPrefix = "/2fa-gate"
	gateOriginCookie  = "_bailey_origin"
)

// mfaGateHandler is the shape of the MFA/account/pair page handlers in
// mfa_pair.go and mfa_account.go. They take the authenticated email as
// a third arg (the gate dispatch already resolved identity), so they
// aren't plain http.HandlerFunc.
type mfaGateHandler func(w http.ResponseWriter, r *http.Request, email string)

// Handler vars assigned in the init() funcs of mfa_pair.go and
// mfa_account.go (their concrete handlers close over package state, so
// they register themselves here at startup). protected_gate.go's
// handleGatePath switch dispatches to these.
var (
	handlePendingPair     mfaGateHandler
	handlePendingPairPoll mfaGateHandler
	handleApprovePair     mfaGateHandler
	handleRecovery        mfaGateHandler
	handleAccountDevices  mfaGateHandler
	handleAccountTOTP     mfaGateHandler
)

// enforceMFAGate runs the Bailey device-trust phase (PHASE 1 only).
// Returns true if the caller should continue; returns false (and writes
// a redirect or page) when the gate has handled the request.
//
// This is the device-trust + admin-TOTP-challenge + first-admin
// bootstrap step. It deliberately does NOT run the per-endpoint ACL —
// that is enforced separately in enforceProtectedGate (protected_gate.go),
// which the gate's own gateHandler still calls. enforceMFAGate is wired
// at the top of chromeWrapMiddleware so it covers the Server Console,
// the chrome wrap, and the proxied apps before any of them render.
//
// Behaviour (mirrors PR #340's enforceMFAGate phase 1):
//   - BAILEY_MFA_GATE_DISABLE=1 → pass through (escape hatch).
//   - No identity → pass through (upstream OIDC failed; the gate never
//     invents an identity, and the inner handler will reject).
//   - Paths the un-trusted user needs in order to BECOME trusted are
//     exempt (oauth2 + the whole MFA gate-path prefix: pending-pair,
//     poll, approve, recovery, admin challenge/enrol, account pages).
//     Without this exemption the redirect target would itself be gated,
//     producing a redirect loop.
//   - Admin without a valid TOTP session → remember origin + redirect to
//     the challenge page (which itself bounces to enrol if not enrolled).
//   - No trusted device:
//       · admin && no devices exist yet → bootstrap-TOFU: auto-pair this
//         browser (addDevice + setDeviceCookie) so the very first admin
//         on a fresh server isn't locked out.
//       · otherwise → remember origin + redirect to the pending-pair page.
//   - Trusted device → touchDevice, then pass through.
func enforceMFAGate(w http.ResponseWriter, r *http.Request) bool {
	if os.Getenv("BAILEY_MFA_GATE_DISABLE") == "1" {
		return true
	}

	// Exemptions — paths required to become trusted. Kept inside the
	// gate so every caller is consistent and no redirect loop forms.
	// gatePathPrefix == mfaGatePathPrefix ("/2fa-gate").
	if strings.HasPrefix(r.URL.Path, "/oauth2/") ||
		strings.HasPrefix(r.URL.Path, gatePathPrefix) {
		return true
	}

	email, groups := identityFromHeaders(r)
	if email == "" {
		return true // no identity → upstream OIDC failed; let it through
	}
	admin := isAdminGroups(groups)
	if admin && !hasValidSession(r, email) {
		// Admins must clear a TOTP challenge. The challenge handler
		// redirects to enrol if the admin hasn't enrolled yet.
		rememberOrigin(w, r)
		http.Redirect(w, r, gatePathPrefix+challengePathSuffix, http.StatusSeeOther)
		return false
	}

	dev := currentDeviceForRequest(r, email)
	if dev == nil {
		// Bootstrap: first admin on an empty server gets TOFU'd.
		if admin && !anyDevicesExist() {
			rec, err := addDevice(email, deviceNameFromRequest(r))
			if err != nil {
				http.Error(w, "bootstrap pair: "+err.Error(), http.StatusInternalServerError)
				return false
			}
			_ = setDeviceCookie(w, r, email, rec.ID)
			dev = rec
		} else {
			rememberOrigin(w, r)
			http.Redirect(w, r, gatePathPrefix+"/pending-pair", http.StatusSeeOther)
			return false
		}
	}
	touchDevice(email, dev.ID)
	return true
}

// rememberOrigin stashes the path the user was trying to reach in a
// short-lived cookie so originRedirect can send them back there once
// they clear the gate (TOTP challenge, device pairing, etc.).
func rememberOrigin(w http.ResponseWriter, r *http.Request) {
	origin := r.URL.Path
	if r.URL.RawQuery != "" {
		origin += "?" + r.URL.RawQuery
	}
	http.SetCookie(w, &http.Cookie{
		Name: gateOriginCookie, Value: origin, Path: "/",
		MaxAge: 600, HttpOnly: true,
		Secure:   r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https",
		SameSite: http.SameSiteLaxMode,
	})
}

// originRedirect sends the user back to the path stashed by
// rememberOrigin (defaulting to "/"), clearing the cookie on the way.
func originRedirect(w http.ResponseWriter, r *http.Request) {
	target := "/"
	if c, err := r.Cookie(gateOriginCookie); err == nil && c.Value != "" {
		target = c.Value
	}
	http.SetCookie(w, &http.Cookie{Name: gateOriginCookie, Value: "", Path: "/", MaxAge: -1})
	http.Redirect(w, r, target, http.StatusSeeOther)
}

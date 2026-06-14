package daemon

import (
	"net/http"
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

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
	handleClaim           mfaGateHandler
	handlePendingPair     mfaGateHandler
	handlePendingPairPoll mfaGateHandler
	handleSelfTrust       mfaGateHandler
	handleApprovePair     mfaGateHandler
	handleRecovery        mfaGateHandler
	handleAccountDevices  mfaGateHandler
	handleAccountTOTP     mfaGateHandler
)

// enforceMFAGate runs the Bailey DEVICE-TRUST phase. Returns true if the
// caller should continue; returns false (and writes a redirect or page)
// when the gate has handled the request.
//
// DEVICE TRUST is the only gate. A Keycloak login alone never grants
// access — every device must be explicitly trusted. There is NO mandatory
// authenticator/TOTP setup: an authenticator is an OPT-IN self-trust
// shortcut + recovery aid, never a forced enrolment step. (This replaces
// PR #340's mandatory admin-TOTP challenge/enrol gate and its silent
// first-admin auto-pair, matching the wireframe auth-scenes.)
//
// It deliberately does NOT run the per-endpoint ACL — that is enforced
// separately in enforceProtectedGate (protected_gate.go), which the gate's
// own gateHandler still calls. enforceMFAGate is wired at the top of
// chromeWrapMiddleware so it covers the Server Console, the chrome wrap,
// and the proxied apps before any of them render.
//
// Behaviour:
//   - BAILEY_MFA_GATE_DISABLE=1 → pass through (escape hatch).
//   - No identity → pass through (upstream OIDC failed; the gate never
//     invents an identity, and the inner handler will reject).
//   - Paths the un-trusted user needs in order to BECOME trusted are
//     exempt (oauth2 + the whole gate-path prefix: claim, pending-pair,
//     poll, approve, recovery, account pages). Without this exemption the
//     redirect target would itself be gated, producing a redirect loop.
//   - Trusted device (valid device cookie matching a live row) →
//     touchDevice, then pass through.
//   - No trusted device:
//     · server UNCLAIMED (no device trusted, no root admin) AND the
//     caller is eligible to claim → redirect to the one-time CLAIM /
//     bootstrap page (NOT a TOTP screen, NOT a silent auto-pair).
//     · otherwise → redirect to the "trust this device" (pending-pair)
//     page, where an admin approves the code or — only if the user has
//     an authenticator enrolled — they self-trust with a TOTP code.
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

	if dev := currentDeviceForRequest(r, email); dev != nil {
		touchDevice(email, dev.ID)
		return true
	}

	// Untrusted device. Decide between the one-time claim screen (fresh
	// server) and the normal trust-this-device flow.
	rememberOrigin(w, r)
	if !serverClaimed() && eligibleToClaim(email, groups) {
		http.Redirect(w, r, gatePathPrefix+"/claim", http.StatusSeeOther)
		return false
	}
	http.Redirect(w, r, gatePathPrefix+"/pending-pair", http.StatusSeeOther)
	return false
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

// safeOriginTarget validates a stashed redirect target and returns a
// guaranteed same-origin absolute path. The _bailey_origin cookie is
// scoped to the whole protected domain (cookieDomainForProtected
// returns ".<domain>"), so any sibling host under that domain — e.g. a
// user-controlled workspace app — can plant it. Without validation an
// attacker plants _bailey_origin=//evil.example (or /\evil.example) and
// the victim is bounced off-domain (open redirect / post-auth phishing)
// the next time they clear the gate, since http.Redirect forwards a
// protocol-relative target unchanged.
//
// Only a strict same-origin absolute path is allowed: a single leading
// '/', not '//' and not '/\'. Anything else collapses to "/".
func safeOriginTarget(target string) string {
	if target == "" || target[0] != '/' ||
		strings.HasPrefix(target, "//") ||
		strings.HasPrefix(target, "/\\") {
		return "/"
	}
	return target
}

// originRedirect sends the user back to the path stashed by
// rememberOrigin (defaulting to "/"), clearing the cookie on the way.
func originRedirect(w http.ResponseWriter, r *http.Request) {
	target := "/"
	if c, err := r.Cookie(gateOriginCookie); err == nil && c.Value != "" {
		target = c.Value
	}
	target = safeOriginTarget(target)
	http.SetCookie(w, &http.Cookie{Name: gateOriginCookie, Value: "", Path: "/", MaxAge: -1})
	http.Redirect(w, r, target, http.StatusSeeOther)
}

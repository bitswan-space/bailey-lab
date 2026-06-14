package daemon

import (
	"net/http"
	"net/url"
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

// gateExemptPath reports whether a path is one the UNtrusted user needs
// to reach in order to BECOME trusted — and which therefore must NOT be
// gated (gating them would loop, or starve the React gate SPA of the very
// APIs/assets it needs to render a scene). Exempt:
//   - /oauth2/        — the OIDC handshake, owned by oauth2-proxy upstream.
//   - /2fa-gate/      — the legacy server-rendered Go gate pages (kept as a
//     no-JS fallback; no longer the primary trust UI).
//   - /bailey/api/    — the gate-state + action APIs the React scenes call.
//   - /bailey/static, /bailey/favicon — the SPA's own asset/icon paths
//     on the console host (the JS bundle is under /assets, but these are
//     the daemon-served extras the page head references).
func gateExemptPath(p string) bool {
	return strings.HasPrefix(p, "/oauth2/") ||
		strings.HasPrefix(p, gatePathPrefix) || // "/2fa-gate"
		strings.HasPrefix(p, "/bailey/api/") ||
		strings.HasPrefix(p, "/bailey/static") ||
		strings.HasPrefix(p, "/bailey/favicon")
}

// isTopLevelHTMLGet reports whether r is a top-level browser navigation
// for an HTML document — the only request shape that should receive a
// rendered gate scene. Subresource fetches, XHR, and non-GET methods must
// NOT get an HTML doc back (that would corrupt an asset / API response).
func isTopLevelHTMLGet(r *http.Request) bool {
	return r.Method == http.MethodGet &&
		strings.Contains(r.Header.Get("Accept"), "text/html")
}

// onConsoleHost reports whether the request hit the Server Console host
// (its inner OR outer hostname). The console host is where the SPA's
// assets (/assets/*) and APIs (/bailey/api/*) actually resolve to the
// daemon, so it's the only host where we can serve the SPA inline; on an
// app host those paths would be proxied to the upstream app instead.
func onConsoleHost(r *http.Request) bool {
	host := requestEndpointHost(r)
	return isServerConsoleHost(toOuterHost(host))
}

// enforceMFAGate runs the Bailey DEVICE-TRUST phase. Returns true if the
// caller should continue; returns false (and writes a scene/redirect/error)
// when the gate has handled the request.
//
// DEVICE TRUST is the only gate. A Keycloak login alone never grants
// access — every device must be explicitly trusted. There is NO mandatory
// authenticator/TOTP setup: an authenticator is an OPT-IN self-trust
// shortcut + recovery aid, never a forced enrolment step.
//
// It deliberately does NOT run the per-endpoint ACL — that is enforced
// separately in enforceProtectedGate (protected_gate.go). enforceMFAGate
// is wired at the top of chromeWrapMiddleware so it covers the Server
// Console, the chrome wrap, and the proxied apps before any of them render.
//
// Behaviour for an UNtrusted (but OAuth-authenticated) device:
//
//   - BAILEY_MFA_GATE_DISABLE=1 → pass through (escape hatch).
//   - No identity → pass through (upstream OIDC failed; the gate never
//     invents an identity, and the inner handler will reject).
//   - Exempt path (gateExemptPath: oauth2, the legacy /2fa-gate pages, and
//     the React SPA's /bailey/api + /bailey/static + /bailey/favicon) →
//     pass through, so the untrusted SPA and its gate-state/action APIs work.
//   - Trusted device (valid device cookie matching a live row) →
//     touchDevice, then pass through.
//   - Untrusted top-level HTML GET:
//     · ON the console host → SERVE the React console SPA inline
//     (serveServerConsole). The SPA reads /bailey/api/gate-state and
//     renders BootstrapScene / ApprovalScene / RecoveryScene itself. We no
//     longer redirect to the Go pages (pendingPairHTML/claim/recovery).
//     · ON an app host → the SPA's assets/APIs would be proxied to the
//     upstream app there, so we can't serve it inline. Stash the origin
//     and 303 to the console host root, where the SPA renders the scene
//     and then bounces back via the saved origin. (Simplest correct
//     option: one redirect to the host where the SPA actually works.)
//   - Untrusted non-GET / non-HTML request to an app host → 401. Only the
//     top-level HTML document gets a scene; an XHR/asset gets a clean 401
//     so the app's own client code can react (and never a stray HTML body).
func enforceMFAGate(w http.ResponseWriter, r *http.Request) bool {
	if os.Getenv("BAILEY_MFA_GATE_DISABLE") == "1" {
		return true
	}

	if gateExemptPath(r.URL.Path) {
		return true
	}

	email, _ := identityFromHeaders(r)
	if email == "" {
		return true // no identity → upstream OIDC failed; let it through
	}

	if dev := currentDeviceForRequest(r, email); dev != nil {
		touchDevice(email, dev.ID)
		return true
	}

	// Untrusted device. The React SPA decides which scene to show from
	// /bailey/api/gate-state; the gate's only job is to make sure the SPA
	// HTML document is what an untrusted top-level navigation receives.
	if !isTopLevelHTMLGet(r) {
		// Subresource / XHR / non-GET on an app host: never hand back an
		// HTML scene. A clean 401 lets the caller's JS react.
		http.Error(w, "device not trusted", http.StatusUnauthorized)
		return false
	}

	if onConsoleHost(r) {
		// The SPA's assets and APIs resolve to the daemon here, so render
		// it inline. It reads gate-state and picks the scene.
		serveServerConsole(w, r)
		return false
	}

	// App host top-level navigation: the SPA can't run here (its /assets
	// and /bailey/api would proxy to the upstream app). Send the browser
	// to the console host, where the SPA renders the gate scene, and have
	// it return here once the device is trusted.
	rememberOrigin(w, r)
	http.Redirect(w, r, consoleGateURL(r), http.StatusSeeOther)
	return false
}

// consoleGateURL builds an absolute URL to the Server Console host root
// carrying a same-origin return path, so after the SPA clears the gate it
// can bounce the user back to the app they were trying to reach. Falls
// back to "/" (relative) if no protected domain is configured, which keeps
// behaviour sane in tests / bootstrap.
func consoleGateURL(r *http.Request) string {
	dom := protectedHostnameDomain()
	if dom == "" {
		return "/"
	}
	ret := r.URL.Path
	if r.URL.RawQuery != "" {
		ret += "?" + r.URL.RawQuery
	}
	return "https://" + serverConsoleHost(dom) + "/?return=" + url.QueryEscape(originForHost(r)+ret)
}

// originForHost reconstructs the outer scheme://host the untrusted request
// hit, so the return path the console hands back can rebuild a full URL to
// the original app host (the console lives on a different host).
func originForHost(r *http.Request) string {
	scheme := "https"
	if r.TLS == nil && r.Header.Get("X-Forwarded-Proto") != "https" {
		scheme = "http"
	}
	return scheme + "://" + toOuterHost(requestEndpointHost(r))
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

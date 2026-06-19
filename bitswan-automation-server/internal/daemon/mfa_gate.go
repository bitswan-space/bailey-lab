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

	// The PUBLIC onboarding host (bailey-onboard.<domain>) is device-trust
	// EXEMPT — it's the external half of the two-endpoint split. It serves the
	// gate SPA + the bootstrap APIs that let an untrusted device BECOME trusted
	// (claim / pending-pair / self-trust / recover). It deliberately exposes no
	// console data: handleBailey's device-trust backstop still 401s the data
	// APIs here, so an untrusted device can render the scene but read nothing.
	if onOnboardHost(r) {
		return true
	}

	if dev := currentDeviceForRequest(r, email); dev != nil {
		touchDevice(email, dev.ID)
		return true
	}

	// Untrusted device on a TRUST-REQUIRED host (the console or an app). We do
	// NOT serve any console/app surface here — the console is the internal half
	// of the split and only trusted devices reach it. Send the browser to the
	// public onboarding host, which renders the device-trust scene and, once
	// the device is trusted, bounces back to the saved origin. A subresource /
	// XHR / non-GET can't be meaningfully redirected, so it gets a clean 401.
	if !isTopLevelHTMLGet(r) {
		http.Error(w, "device not trusted", http.StatusUnauthorized)
		return false
	}
	rememberOrigin(w, r)
	http.Redirect(w, r, onboardGateURL(r), http.StatusSeeOther)
	return false
}

// onOnboardHost reports whether the request hit the public device-trust
// onboarding host (its outer hostname; it has no inner/iframe form).
func onOnboardHost(r *http.Request) bool {
	return isServerConsoleOnboardHost(toOuterHost(requestEndpointHost(r)))
}

// onboardGateURL builds an absolute URL to the onboarding host root carrying a
// same-origin return path, so once the SPA clears the device-trust gate it can
// bounce the user back to the console/app they were trying to reach. Falls back
// to "/" when no protected domain is configured (tests / bootstrap).
func onboardGateURL(r *http.Request) string {
	dom := protectedHostnameDomain()
	if dom == "" {
		return "/"
	}
	ret := r.URL.Path
	if r.URL.RawQuery != "" {
		ret += "?" + r.URL.RawQuery
	}
	return "https://" + serverConsoleOnboardHost(dom) + "/?return=" + url.QueryEscape(originForHost(r)+ret)
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

// rememberOrigin stashes the ABSOLUTE URL the user was trying to reach in a
// short-lived cookie so originRedirect/originRedirectPath can send them back
// once they clear the gate. It stores a full scheme://host/path (not a bare
// path) and is scoped to the parent protected domain, because the device-trust
// gate now lives on a SEPARATE host (bailey-onboard.<domain>): the user is
// redirected console/app → onboarding host, becomes trusted there, and must be
// returned to the ORIGINAL host. A bare path couldn't express that cross-host
// hop. safeOriginTarget keeps it same-site, so this can't become an open
// redirect even though the cookie is now domain-scoped.
func rememberOrigin(w http.ResponseWriter, r *http.Request) {
	origin := originForHost(r) + r.URL.Path
	if r.URL.RawQuery != "" {
		origin += "?" + r.URL.RawQuery
	}
	c := &http.Cookie{
		Name: gateOriginCookie, Value: origin, Path: "/",
		MaxAge: 600, HttpOnly: true,
		Secure:   r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https",
		SameSite: http.SameSiteLaxMode,
	}
	if dom := cookieDomainForProtected(); dom != "" {
		c.Domain = dom
	}
	http.SetCookie(w, c)
}

// safeOriginTarget validates a stashed redirect target. The _bailey_origin
// cookie is scoped to the whole protected domain, so any sibling host under it
// — e.g. a user-controlled workspace app — can plant it. Without validation an
// attacker plants _bailey_origin=//evil.example (or https://evil.example) and
// the victim is bounced off-domain (open redirect / post-auth phishing) the
// next time they clear the gate, since http.Redirect / window.location forward
// the target unchanged.
//
// Two shapes are allowed:
//   - a strict same-origin absolute PATH (single leading '/', not '//' / '/\'); or
//   - an absolute https URL whose host is the protected domain or a subdomain
//     of it (same-site), which is what the cross-host onboarding return needs.
//
// Anything else collapses to the console root (an always-safe in-site target),
// never the caller's current host (which could be the onboarding host).
func safeOriginTarget(target string) string {
	dom := protectedHostnameDomain()
	fallback := "/"
	if dom != "" {
		fallback = "https://" + serverConsoleHost(dom) + "/"
	}
	if target == "" {
		return fallback
	}
	if target[0] == '/' {
		if strings.HasPrefix(target, "//") || strings.HasPrefix(target, "/\\") {
			return fallback
		}
		return target
	}
	u, err := url.Parse(target)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return fallback
	}
	h := strings.ToLower(u.Hostname())
	d := strings.ToLower(dom)
	if d == "" || (h != d && !strings.HasSuffix(h, "."+d)) {
		return fallback
	}
	return target
}

// originRedirect sends the user back to the URL stashed by rememberOrigin
// (defaulting to the console root), clearing the cookie on the way.
func originRedirect(w http.ResponseWriter, r *http.Request) {
	target := ""
	if c, err := r.Cookie(gateOriginCookie); err == nil && c.Value != "" {
		target = c.Value
	}
	target = safeOriginTarget(target)
	http.SetCookie(w, &http.Cookie{Name: gateOriginCookie, Value: "", Path: "/", MaxAge: -1})
	http.Redirect(w, r, target, http.StatusSeeOther)
}

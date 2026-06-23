package daemon

import (
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/traefikapi"
)

// Protected gate — sits between bitswan-protected-proxy (oauth2-proxy)
// and the workspace services. Every externally-reachable protected
// request flows through here exactly once:
//
//	platform-traefik → bitswan-protected-proxy → :9080 (this gate)
//	    outer host → chrome wrap (chromeWrapMiddleware)
//	    inner host → ACL check  → reverse-proxy to the service
//
// Stage 1 enforces the per-endpoint ACL. Stage 2 inserts a
// second-factor phase (TOTP for admins, paired-device cookies for
// everyone) in enforceProtectedGate before the ACL check — the gate
// path prefix and handler layout are stable for that reason.

const (
	gateListenAddr = ":9080"
	gatePathPrefix = "/2fa-gate"
)

// upstreamForHost returns the URL the gate reverse-proxies an
// inner-host request to:
//
//	bailey--inner.<domain>      → http://<daemon>:8080 (daemon HTTP server)
//	anything else               → the upstream recorded for the route in
//	                              bailey.db (written by addRouteToIngress)
//	fallback                    → http://<workspace>__traefik:80 when a
//	                              workspace sub-traefik matches the label
//	                              (covers deployments routed before the
//	                              protected_routes table existed)
//
// Returns nil for hostnames that aren't recognised — the proxy 502s in
// that case, which is the right behaviour: a request for an unknown
// protected hostname should fail loudly, not silently route somewhere
// wrong.
func upstreamForHost(host string) *url.URL {
	host = strings.ToLower(host)
	// The onboarding host is served on its OUTER hostname (no inner/iframe
	// split), so resolve it to the daemon directly — its bootstrap/data API
	// calls (proxied via chromeWrapMiddleware) need an upstream even though
	// it isn't an inner host. The SPA shell itself is served in-process by
	// serveServerConsole and never reaches here.
	if isServerConsoleOnboardHost(toOuterHost(host)) {
		u, _ := url.Parse("http://" + upstreamDaemonHost() + ":8080")
		return u
	}
	if !isInnerHost(host) {
		return nil
	}
	outer := toOuterHost(host)
	if isBaileyHost(outer) {
		u, _ := url.Parse("http://" + upstreamDaemonHost() + ":8080")
		return u
	}
	// Workspace hostname: <workspace>-<service>.<domain> (outer form). Route it
	// to the multi-homed per-workspace sub-traefik — the ONLY component that can
	// reach both bitswan_network management services (gitops/dashboard) AND the
	// stage-isolated automation containers on {workspace}-{stage}. Routing to the
	// recorded protected-route upstream directly would 502 for any automation,
	// because the gate (on bitswan_network) cannot reach a stage network. The
	// sub-traefik holds the per-host route (pushed by addRouteTraefik) and
	// resolves the upstream on whichever network the target sits on.
	label, _, _ := strings.Cut(outer, ".")
	if ws := workspaceFromLabel(label); ws != "" {
		u, _ := url.Parse("http://" + ws + "__traefik:80")
		return u
	}
	// Not a workspace host — a separately-registered protected endpoint. Use the
	// recorded post-auth upstream directly.
	if up, err := lookupProtectedRouteUpstream(outer); err == nil && up != "" {
		if !strings.Contains(up, "://") {
			up = "http://" + up
		}
		if u, err := url.Parse(up); err == nil {
			return u
		}
	}
	return nil
}

// upstreamDaemonHost returns the address of the daemon's HTTP server.
// In the current single-process topology that's localhost; the env
// override exists so the stage-4 split (gate in its own unprivileged
// container) only has to set BAILEY_DAEMON_HOST.
func upstreamDaemonHost() string {
	if h := os.Getenv("BAILEY_DAEMON_HOST"); h != "" {
		return h
	}
	return "localhost"
}

// workspaceFromLabel resolves a hostname label like "my-workspace-editor"
// to its workspace name ("my-workspace") by stripping the longest
// suffix that leaves a workspace with a running traefik.
func workspaceFromLabel(label string) string {
	parts := strings.Split(label, "-")
	for i := len(parts) - 1; i > 0; i-- {
		candidate := strings.Join(parts[:i], "-")
		if isWorkspaceTraefikRunning(candidate) {
			return candidate
		}
	}
	return ""
}

// isBaileyHost matches the daemon-served management hosts: the console outer
// (bailey.<domain>) and inner (bailey--inner.<domain>) subdomains, plus the
// public device-trust onboarding host (bailey-onboard.<domain>). All three are
// served by the daemon itself (SPA + bootstrap/data APIs), so they get the ACL
// free pass, receive the gate-resolved identity, and keep their Bailey auth
// cookies (which an app upstream would have stripped).
func isBaileyHost(host string) bool {
	h := strings.ToLower(host)
	return strings.HasPrefix(h, "bailey.") ||
		strings.HasPrefix(h, "bailey"+innerHostSuffix+".") ||
		strings.HasPrefix(h, "bailey-onboard.")
}

// isTrustedWorkspaceAppHost reports whether the endpoint host is a FIRST-PARTY
// workspace app the gate trusts with the forwarded identity — i.e. the
// workspace dashboard, registered with endpoint kind "workspace". This is
// BitSwan code, not user-deployed automations, so forwarding the verified
// X-Forwarded-Email to it is safe and lets the dashboard rely on the gate for
// auth instead of doing OIDC itself. User-deployed business-process apps
// (kind "frontend"/"service") return false and never receive identity.
func isTrustedWorkspaceAppHost(endpointHost string) bool {
	ep, err := getEndpoint(toOuterHost(endpointHost))
	return err == nil && ep != nil && ep.Kind == endpointKindWorkspace
}

// startProtectedGate boots the gate's HTTP listener. Called from
// Server.Run once at startup.
func startProtectedGate() error {
	// Per-request Director — picks the upstream by hostname.
	proxy := &httputil.ReverseProxy{
		Director: func(r *http.Request) {
			// SECURITY (defence-in-depth, identity header injection):
			// Re-anchor the forwarded-identity headers before proxying.
			// We (1) capture the identity as resolved from the request
			// the gate received (set by the trusted oauth2-proxy hop,
			// bitswan-protected-proxy, in FRONT of this listener), (2)
			// strip every client-supplied identity header, then (3) only
			// re-apply the trusted identity on the leg to the daemon's
			// own :8080 Bailey upstream. For all other upstreams (the
			// user-controlled workspace apps) the identity headers stay
			// stripped, so a malicious/compromised upstream can never see
			// or have injected a forged X-Forwarded-Email/-Groups, and a
			// client talking straight to :9080 (bypassing oauth2-proxy)
			// cannot inject identity that flows downstream.
			//
			// NOTE: this does not by itself close the stage-4 gap — the
			// daemon's :8080 listener still trusts X-Forwarded-* with no
			// proof the request came through the gate (see the comment at
			// identityFromHeaders and at the docsServer wiring in
			// server.go). The full fix is the stage-4 proxy split that
			// makes :8080 reachable only via the gate. This strip is the
			// conservative, non-breaking mitigation against identity
			// injection into/through upstream apps.
			endpointHost := requestEndpointHost(r)
			email, groups := identityFromHeaders(r)
			stripForwardedIdentityHeaders(r)

			up := upstreamForHost(endpointHost)
			if up == nil {
				// Force a 502 by pointing the request at an unreachable
				// sentinel — the simplest way to surface "no upstream
				// matches" without a separate code path.
				r.URL.Scheme = "http"
				r.URL.Host = "no-upstream.invalid"
				return
			}
			r.URL.Scheme = up.Scheme
			r.URL.Host = up.Host
			if h := r.Header.Get("X-Forwarded-Host"); h != "" {
				r.Host = h
			}
			// Re-apply the gate-trusted identity to the upstreams that
			// legitimately consume it: the Bailey daemon upstream AND the
			// first-party workspace dashboard (endpoint kind "workspace"),
			// which is BitSwan code, not user-deployed automations. The
			// dashboard relies solely on this header for identity — it does
			// no OIDC of its own. User-deployed business-process apps
			// (kind "frontend"/"service") are NOT trusted and never receive
			// forwarded identity.
			isBailey := isBaileyHost(toOuterHost(endpointHost))
			if email != "" && (isBailey || isTrustedWorkspaceAppHost(endpointHost)) {
				r.Header.Set("X-Forwarded-Email", email)
				if len(groups) > 0 {
					r.Header.Set("X-Forwarded-Groups", strings.Join(groups, ","))
				}
			}
			if !isBailey {
				// App upstream (including the first-party dashboard). Strip
				// Bailey's auth cookies so an upstream can never read — and then
				// replay — the device-trust credential. The browser sends
				// _bailey_device to the gate so the gate can enforce trust on
				// every protected host, but it MUST NOT reach an upstream: the
				// gate has already enforced trust by this point, so the app needs
				// the request, never the credential. This keeps the cookie
				// un-stealable by the apps running behind Bailey.
				stripBaileyAuthCookies(r)
			}
		},
		// Flush immediately after every chunk so streaming upstream
		// responses (SSE, NDJSON) reach the client incrementally
		// instead of being buffered until the upstream closes.
		FlushInterval: -1,
	}
	// Two responsibilities on inner content:
	//  1. Strip iframe-blocking headers so the wrap can embed it.
	//  2. Inject the strict CSP that pins the inner content to the
	//     server's domain (see strictInnerCSP).
	// The CSP applies only to HTML documents (it's a per-document
	// policy); for JS/CSS/images we just strip frame headers and leave
	// the payload alone.
	proxy.ModifyResponse = func(resp *http.Response) error {
		resp.Header.Del("X-Frame-Options")
		host := requestEndpointHost(resp.Request)
		if !isInnerHost(host) {
			return nil
		}
		if strings.HasPrefix(resp.Header.Get("Content-Type"), "text/html") {
			resp.Header.Set("Content-Security-Policy", strictInnerCSP(host))
			// Nav-sync lets the wrap's outer URL follow iframe
			// navigation, so reloads resume on the same page.
			injectNavSync(resp)
		} else if csp := resp.Header.Get("Content-Security-Policy"); csp != "" {
			// Non-HTML with its own CSP: drop frame-ancestors so the
			// wrap stays able to embed (Firefox/Safari honour CSP on
			// some non-document responses).
			resp.Header.Set("Content-Security-Policy", stripCSPFrameAncestors(csp))
		}
		return nil
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		gateHandler(w, r, proxy)
	})
	srv := &http.Server{
		Addr: gateListenAddr,
		// The chrome wrap is applied here as a single middleware so
		// every request through the gate inherits it exactly once.
		Handler:           chromeWrapMiddleware(injectNavSyncMiddleware(mux)),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			fmt.Printf("protected gate listener error: %v\n", err)
		}
	}()
	fmt.Printf("protected gate listening on %s; upstreams resolved per-request by hostname\n", gateListenAddr)
	return nil
}

// setupBaileyRoutes wires bailey.<domain> into the protected-ingress
// chain: both the outer and inner hostnames route to
// bitswan-protected-proxy in platform-traefik, and their OAuth
// callback URIs are registered with Keycloak via the AOC. The inner
// hostname's upstream (the daemon's :8080 server) is resolved by the
// gate per-request, so no other routes are needed.
//
// Best-effort and idempotent — called on every daemon boot. Does
// nothing until a domain is configured and the protected proxy
// container exists.
func setupBaileyRoutes() {
	domain := protectedHostnameDomain()
	if domain == "" {
		return
	}
	if !containerRunning("bitswan-protected-proxy") {
		fmt.Println("bitswan-protected-proxy not running — Bailey routes not registered (provision protected ingress first).")
		return
	}
	outer := "bailey." + domain
	if err := registerProtectedRedirectURI(outer); err != nil {
		fmt.Printf("Warning: AOC didn't accept protected-client redirect URIs for %s: %v\n", outer, err)
	}
	resolver, tlsDomains := certResolverForHostname(outer)
	for _, h := range []string{outer, toInnerHost(outer)} {
		if err := traefikapi.AddRouteWithTLSDomains(h, "bitswan-protected-proxy:80", "", resolver, tlsDomains); err != nil {
			fmt.Printf("Warning: register platform route for %s: %v\n", h, err)
		}
	}

	// Public device-trust onboarding host (the external half of the
	// two-endpoint split). It has no inner/iframe form — the SPA is served
	// directly on this single outer hostname — so only one route is needed.
	// Same oauth2-proxy in front; its OAuth callback URI is registered too.
	onboard := serverConsoleOnboardHost(domain)
	if err := registerProtectedRedirectURI(onboard); err != nil {
		fmt.Printf("Warning: AOC didn't accept protected-client redirect URIs for %s: %v\n", onboard, err)
	}
	oResolver, oTLSDomains := certResolverForHostname(onboard)
	if err := traefikapi.AddRouteWithTLSDomains(onboard, "bitswan-protected-proxy:80", "", oResolver, oTLSDomains); err != nil {
		fmt.Printf("Warning: register platform route for %s: %v\n", onboard, err)
	}
}

func gateHandler(w http.ResponseWriter, r *http.Request, proxy *httputil.ReverseProxy) {
	if strings.HasPrefix(r.URL.Path, gatePathPrefix) {
		handleGatePath(w, r)
		return
	}
	if !enforceProtectedGate(w, r) {
		return
	}
	proxy.ServeHTTP(w, r)
}

// enforceProtectedGate runs the gate's access checks. Returns true if
// the caller should continue serving; false when the gate already
// handled the request (denied page rendered).
//
// Stage 1 has a single phase — the per-endpoint ACL. Stage 2 inserts
// the second-factor phase (TOTP / paired-device) here, before the ACL
// check.
func enforceProtectedGate(w http.ResponseWriter, r *http.Request) bool {
	if os.Getenv("BAILEY_GATE_DISABLE") == "1" {
		return true
	}
	email, groups := identityFromHeaders(r)
	if email == "" {
		// No identity → the OIDC handshake upstream failed; let the
		// request through and the upstream service will reject it. The
		// gate never invents an identity.
		return true
	}
	return enforceEndpointACL(w, r, email, groups)
}

// enforceEndpointACL looks up the request's host in the endpoints
// table and decides whether the caller can proceed. Returns true if
// the request should be served; false if it was handled (denied page
// rendered).
//
// bailey.<domain> gets a free pass — it's the management surface,
// whose pages apply their own per-page authorization. We still
// register it as an endpoint on first sign-in so it has an owner (the
// "server owner") for the share/audit UI, but the gate doesn't 403 it.
func enforceEndpointACL(w http.ResponseWriter, r *http.Request, email string, groups []string) bool {
	host := requestEndpointHost(r)
	if host == "" {
		return true
	}
	// ACL state is keyed by the OUTER hostname. Inner-subdomain
	// requests look up against the same row.
	host = toOuterHost(host)
	if isBaileyHost(host) {
		if ep, _ := getEndpoint(host); ep == nil {
			_, _ = registerEndpoint(host, email, "Bailey ("+host+")", "", "", "")
		}
		return true
	}
	ep, err := getEndpoint(host)
	if err != nil {
		http.Error(w, "ACL lookup: "+err.Error(), http.StatusInternalServerError)
		return false
	}
	if ep == nil {
		// Unknown host — no route registration has set an owner yet.
		// Leave open until one does; gating an ownerless endpoint
		// would lock out the very user whose deploy is in flight.
		return true
	}
	role, err := roleFor(host, email, groups)
	if err != nil {
		http.Error(w, "ACL check: "+err.Error(), http.StatusInternalServerError)
		return false
	}
	if role == roleNone {
		// Record the attempt so the owner sees it as a pending request
		// in their approvals view, then show a generic denial that leaks
		// nothing about the endpoint or its owner (accessDeniedHTML).
		_ = addAccessRequest(host, email)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, accessDeniedHTML(email))
		return false
	}
	return true
}

// handleGatePathRoot is the bare http.HandlerFunc form of
// handleGatePath, for mounting on the daemon's own mux (the gate
// proxies /2fa-gate/* on the bailey inner host through to the daemon,
// which serves them here).
func handleGatePathRoot(w http.ResponseWriter, r *http.Request) {
	handleGatePath(w, r)
}

// handleGatePath routes the gate's own pages and APIs. Stage 2 mounts
// the MFA pages (enrol/challenge/pending-pair/approve/devices) under
// the same prefix.
func handleGatePath(w http.ResponseWriter, r *http.Request) {
	email, groups := identityFromHeaders(r)
	if email == "" {
		http.Error(w, "no identity on request", http.StatusForbidden)
		return
	}

	switch {
	case r.URL.Path == gatePathPrefix+"/whoami":
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprintf(w, "email=%s\ngroups=%s\nadmin=%v\n",
			email, strings.Join(groups, ","), isAdminGroups(groups))

	case strings.HasPrefix(r.URL.Path, gatePathPrefix+"/api/share/"):
		handleShareAPI(w, r, email, groups)

	case r.URL.Path == gatePathPrefix+"/share" ||
		strings.HasPrefix(r.URL.Path, gatePathPrefix+"/share/"):
		handleShareEndpoint(w, r, email, groups)

	case strings.HasPrefix(r.URL.Path, gatePathPrefix+"/request-access/"):
		handleRequestAccess(w, r, email)

	// --- Device-trust gate pages (assigned in mfa_pair.go /
	// mfa_account.go / mfa_claim.go init()). Each takes the resolved
	// email. ---

	// One-time CLAIM / bootstrap (BootstrapScene). Only works while the
	// server is unclaimed; claims root admin + TOFU-trusts this device.
	case r.URL.Path == gatePathPrefix+"/claim":
		handleClaim(w, r, email)

	case r.URL.Path == gatePathPrefix+"/pending-pair":
		handlePendingPair(w, r, email)

	case r.URL.Path == gatePathPrefix+"/pending-pair/poll":
		handlePendingPairPoll(w, r, email)

	// Authenticator self-trust path on the trust-this-device page
	// (ApprovalScene's "Authenticator" tab): a user with TOTP enrolled
	// can trust this browser with their current 6-digit code, no admin.
	case r.URL.Path == gatePathPrefix+"/self-trust":
		handleSelfTrust(w, r, email)

	case r.URL.Path == gatePathPrefix+"/approve":
		handleApprovePair(w, r, email)

	case r.URL.Path == gatePathPrefix+"/recovery":
		handleRecovery(w, r, email)

	case r.URL.Path == gatePathPrefix+"/account/devices":
		handleAccountDevices(w, r, email)

	case r.URL.Path == gatePathPrefix+"/account/2fa":
		handleAccountTOTP(w, r, email)

	// TOTP enrol/challenge for admins. handleTOTPGate decides enrol vs
	// challenge from the path suffix.
	case strings.HasPrefix(r.URL.Path, gatePathPrefix+enrollPathSuffix),
		strings.HasPrefix(r.URL.Path, gatePathPrefix+challengePathSuffix):
		handleTOTPGate(w, r, gatePathPrefix, email)

	default:
		http.NotFound(w, r)
	}
}

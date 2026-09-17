package daemon

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/traefikapi"
)

// The gate half of the coding agent's browser access (issue #210).
//
// A request carrying a live agent session cookie on the live-dev endpoint that
// session was issued for is served as the test identity behind it: no sign-in,
// no device check, and a real bearer token from the server's own agent issuer.
//
// This is deliberately the same shape as a published public endpoint
// (public_endpoint.go), which is the one other place the gate serves an
// identity nobody signed in as. Three differences, all of them narrowing:
//
//   - a published host is open to the internet; a session here is a secret the
//     agent was handed, hashed at rest, expiring, and revocable;
//   - a published host is fixed to anon@example.com with its groups deleted;
//     here the identity and its groups are whatever the agent configured, which
//     is the entire point — an app gates on groups, so a tester must be able to
//     carry them;
//   - a published host may only be a PRODUCTION frontend; a session may only be
//     a LIVE-DEV one. Live-dev is a copy's own sandbox, which is why handing a
//     robot an identity on it costs nothing a member did not already have.

// agentSessionContext is what the gate resolved a request's cookie to.
type agentSessionContext struct {
	identity agentIdentity
	issuer   string
}

// agentSessionFor resolves the request's agent cookie to an identity, or nil
// when there is no cookie, the session is unknown or lapsed, the request is for
// a different endpoint than the session was issued for, or the server has no
// issuer yet.
//
// The endpoint check is what keeps a session from being a workspace-wide
// credential: a cookie is scoped to the domain by the browser, so it is sent to
// every host under it, and only this comparison stops one live-dev app's
// session from opening another.
func agentSessionFor(r *http.Request) *agentSessionContext {
	c, err := r.Cookie(agentSessionCookie)
	if err != nil || c == nil || c.Value == "" {
		return nil
	}
	sess, err := dbLookupAgentSession(c.Value)
	if err != nil {
		fmt.Printf("Warning: agent session lookup: %v\n", err)
		return nil
	}
	if sess == nil {
		return nil
	}
	host := toOuterHost(strings.ToLower(requestEndpointHost(r)))
	if host == "" || host != sess.EndpointHost {
		return nil
	}
	id, err := dbGetAgentIdentity(sess.Label)
	if err != nil || id == nil {
		return nil
	}
	issuer := currentAgentIssuerURL()
	if issuer == "" {
		return nil
	}
	return &agentSessionContext{identity: *id, issuer: issuer}
}

// agentHandoverParam carries the hand-over token in a sign-in URL.
const agentHandoverParam = "bailey-agent-session"

// serveAgentHandover turns a sign-in URL into a signed-in browser: it exchanges
// the hand-over token for the session cookie and sends the browser on to the
// same URL without the token.
//
// This exists because a browser reads its stored cookies ONCE, when it starts.
// The agent's browser tools are already running by the time it asks for a
// session, so writing the cookie to their state file reaches a browser that will
// never read it again — it lands on the sign-in page and the agent reasonably
// concludes the feature is broken. Visiting a URL is the one hand-over that
// works whenever the browser happens to have been launched.
func serveAgentHandover(w http.ResponseWriter, r *http.Request) bool {
	tok := r.URL.Query().Get(agentHandoverParam)
	if tok == "" {
		return false
	}
	sess, err := dbLookupAgentHandover(tok)
	if err != nil {
		fmt.Printf("Warning: agent hand-over lookup: %v\n", err)
		return false
	}
	host := toOuterHost(strings.ToLower(requestEndpointHost(r)))
	if sess == nil || host == "" || host != sess.EndpointHost {
		// Say so rather than falling through to the sign-in: an expired session
		// looks exactly like a broken feature from the agent's side, and the one
		// thing it needs to know is to ask for a new one.
		http.Error(w, "this sign-in link is not valid for this app, or it has expired — "+
			"run `bitswan-coding-agent browser session` again", http.StatusForbidden)
		return true
	}
	// The cookie is set for the whole domain family so the endpoint's inner host
	// (what the chrome wrap frames) is covered by the same hand-over.
	http.SetCookie(w, &http.Cookie{
		Name:     agentSessionCookie,
		Value:    agentCookieValueFor(tok),
		Path:     "/",
		Domain:   "." + protectedHostnameDomain(),
		Expires:  sess.ExpiresAt,
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	q := r.URL.Query()
	q.Del(agentHandoverParam)
	target := r.URL.Path
	if len(q) > 0 {
		target += "?" + q.Encode()
	}
	http.Redirect(w, r, target, http.StatusSeeOther)
	return true
}

// directAgent rewrites a request the agent's browser made so the gate proxy
// serves the underlying live-dev app as the session's test identity.
//
// The ordering is copied from directPublic and matters: every client-supplied
// identity header is deleted BEFORE ours are set, so a caller holding a session
// cookie still cannot choose which identity it carries.
func directAgent(r *http.Request, ctx *agentSessionContext) {
	stripForwardedIdentityHeaders(r)
	inner := toInnerHost(toOuterHost(requestEndpointHost(r)))
	up := upstreamForHost(inner)
	if up == nil {
		r.URL.Scheme = "http"
		r.URL.Host = "no-upstream.invalid"
		return
	}
	r.URL.Scheme = up.Scheme
	r.URL.Host = up.Host
	r.Host = inner
	r.Header.Set("X-Forwarded-Host", inner)
	if r.Header.Get("X-Forwarded-Proto") == "" {
		r.Header.Set("X-Forwarded-Proto", "https")
	}
	r.Header.Set("X-Forwarded-Email", ctx.identity.Email)
	if len(ctx.identity.Groups) > 0 {
		r.Header.Set("X-Forwarded-Groups", strings.Join(ctx.identity.Groups, ","))
	} else {
		r.Header.Del("X-Forwarded-Groups")
	}
	if tok, err := agentAccessToken(ctx.identity, ctx.issuer); err == nil && tok != "" {
		r.Header.Set("X-Forwarded-Access-Token", tok)
		r.Header.Set("X-Auth-Request-Access-Token", tok)
	}
	stripBaileyAuthCookies(r)
}

// applyAgentIdentityHeaders puts the session's identity on the request in the
// forwarded-header form the rest of the gate reads, after dropping whatever the
// client sent. The gate is the only writer of these headers, so setting them
// here is the same act oauth2-proxy performs on the normal path — not a client
// asserting who it is.
func applyAgentIdentityHeaders(r *http.Request, ctx *agentSessionContext) {
	stripForwardedIdentityHeaders(r)
	r.Header.Set("X-Forwarded-Email", ctx.identity.Email)
	if len(ctx.identity.Groups) > 0 {
		r.Header.Set("X-Forwarded-Groups", strings.Join(ctx.identity.Groups, ","))
	}
}

// serveAgentOAuth2 answers the endpoints an app calls on itself to learn who is
// looking at it, so a page cannot tell an agent session from a signed-in one.
// The frontend library reads X-Auth-Request-Access-Token off a 202 here, which
// is oauth2-proxy's --set-xauthrequest contract.
func serveAgentOAuth2(w http.ResponseWriter, r *http.Request, ctx *agentSessionContext) bool {
	switch r.URL.Path {
	case "/oauth2/auth":
		tok, err := agentAccessToken(ctx.identity, ctx.issuer)
		if err != nil {
			http.Error(w, "agent token unavailable: "+err.Error(), http.StatusBadGateway)
			return true
		}
		w.Header().Set("X-Auth-Request-Access-Token", tok)
		w.Header().Set("X-Auth-Request-Email", ctx.identity.Email)
		w.Header().Set("X-Auth-Request-User", ctx.identity.Email)
		w.Header().Set("X-Auth-Request-Preferred-Username", ctx.identity.Email)
		if len(ctx.identity.Groups) > 0 {
			w.Header().Set("X-Auth-Request-Groups", strings.Join(ctx.identity.Groups, ","))
		}
		w.WriteHeader(http.StatusAccepted)
		return true
	case "/oauth2/userinfo":
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"user":              ctx.identity.Email,
			"email":             ctx.identity.Email,
			"preferredUsername": ctx.identity.Email,
			"groups":            ctx.identity.Groups,
		})
		return true
	}
	return false
}

// --- issuing a session -----------------------------------------------------

// canGiveAgentSession is the live-dev rule, and the only authorization this
// feature has. It reads the endpoint row's own stage and kind — explicit data
// gitops supplied when it registered the route, never inferred from the
// hostname — exactly as canMakePublic does for publishing.
func canGiveAgentSession(host string) (ok bool, reason string) {
	ep, err := getEndpoint(toOuterHost(strings.ToLower(host)))
	if err != nil {
		return false, "could not look up that endpoint"
	}
	if ep == nil {
		return false, "no such endpoint on this server"
	}
	if !strings.EqualFold(ep.Stage, "live-dev") {
		return false, "the coding agent may only browse live-dev deployments"
	}
	if ep.Kind != endpointKindFrontend {
		return false, "only a frontend endpoint can be opened in a browser"
	}
	return true, ""
}

// agentRouteID names the cookie-matched router for one hostname. It must differ
// from that hostname's own route id, which is derived from the hostname alone —
// two routers on one host, and removing either must not remove the other.
func agentRouteID(host string) string {
	return "agent-" + traefikapi.SanitizeHostname(strings.ToLower(host))
}

// agentRouteHosts are the two hostnames a browser actually loads for one
// endpoint: the outer one, which serves Bailey's chrome, and the inner one its
// iframe points at, which serves the app. BOTH need the bypass. With only the
// outer one the wrap renders, names the test identity, and then frames a page
// that bounces to the sign-in — the app itself never loads, which is the only
// part the agent came to look at.
func agentRouteHosts(host string) []string {
	outer := toOuterHost(strings.ToLower(host))
	return []string{outer, toInnerHost(outer)}
}

// registerAgentRoute adds the router that lets the agent's browser reach a
// live-dev endpoint at its own URL without a sign-in.
//
// The bypass is the same one a published endpoint gets — a route straight to
// the gate, with the oauth2-proxy hop deliberately skipped — but narrowed from
// a whole hostname to requests that carry an agent cookie. Everything else on
// this host still goes through oauth2-proxy and Keycloak, so a person signing
// in to the same app sees no difference and no extra button.
//
// The rule is strictly longer than the plain Host() rule, and Traefik breaks
// ties by rule length, so the cookie-bearing request wins without the two
// routers having to know about each other. The priority is set anyway rather
// than resting on that.
func registerAgentRoute(host string) error {
	for _, h := range agentRouteHosts(host) {
		resolver, tlsDomains := certResolverForHostname(h)
		if err := traefikapi.AddRuleRoute(traefikapi.RuleRoute{
			ID:         agentRouteID(h),
			Rule:       agentRouteRule(h),
			Priority:   agentRoutePriority,
			Upstream:   daemonContainerName + gateListenAddr,
			Resolver:   resolver,
			TLSDomains: tlsDomains,
		}); err != nil {
			return err
		}
	}
	return nil
}

// agentRouteRule matches requests for one endpoint that carry an agent cookie.
// Traefik v3's HeaderRegexp searches the header value, so naming the cookie is
// enough — the session's own validity is decided at the gate, not here. This
// only routes.
func agentRouteRule(host string) string {
	// Two ways in, because a browser has to get the cookie before it can send
	// one: the sign-in URL carries the hand-over token, and everything after the
	// redirect carries the cookie. Miss the first and the sign-in URL is routed
	// to the login page, which is precisely the thing it exists to avoid.
	return fmt.Sprintf("Host(`%s`) && (HeaderRegexp(`Cookie`, `%s=`) || QueryRegexp(`%s`, `.+`))",
		host, agentSessionCookie, agentHandoverParam)
}

// agentRoutePriority sits above the hostname routers Traefik derives a priority
// for from rule length, so the agent's router is chosen whenever its cookie
// predicate matches.
const agentRoutePriority = 10000

func removeAgentRoute(host string) {
	for _, h := range agentRouteHosts(host) {
		_ = traefikapi.RemoveRouteByID(agentRouteID(h))
	}
}

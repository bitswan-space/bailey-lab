package daemon

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
	"github.com/bitswan-space/bitswan-workspaces/internal/traefikapi"
)

// Public endpoints (issue #220) — the "Make public" tier.
//
// An auditor/admin who owns a PRODUCTION FRONTEND endpoint can publish it
// as a public URL. The published URL is a SECONDARY host under the AOC's
// per-AOC wildcard *.public.<aoc-id>.bswn.io (allocated by the AOC), routed
// through the same SNI-passthrough relay. On this server the gate serves
// that host with NO Bailey auth and NO chrome bottom-bar, and injects a
// fixed X-Forwarded-Email: anon@example.com toward the app so the frontend
// sees anonymous visitors as a signed-in pseudo-user. The endpoint keeps its
// normal protected URL — "public" only adds the secondary one.
//
// Making public is deliberately restricted (canMakePublic): owner AND
// admin-or-auditor AND stage=production AND kind=frontend.

const (
	publicCreatePath = gatePathPrefix + "/api/public/create"
	publicRevokePath = gatePathPrefix + "/api/public/revoke"

	// anonPublicEmail is the fixed identity a published (public) endpoint's app
	// sees for every anonymous visitor. It is not a real user, so re-anchoring
	// it toward a tenant frontend leaks nothing (unlike a real visitor's
	// identity/token, which the gate confines to first-party upstreams).
	anonPublicEmail = "anon@example.com"
)

// --- in-memory public-host cache (consulted by the gate per request) ---

var (
	publicHostMu    sync.RWMutex
	publicHostCache map[string]string // public_host(lower) -> endpoint_host(lower)
)

// refreshPublicHostCache reloads the published-host lookup from the DB. Called
// at startup and after every create/revoke.
func refreshPublicHostCache() {
	recs, err := dbListPublicEndpoints()
	if err != nil {
		fmt.Printf("public: refresh host cache: %v\n", err)
		return
	}
	m := make(map[string]string, len(recs))
	for _, r := range recs {
		m[strings.ToLower(r.PublicHost)] = strings.ToLower(r.EndpointHost)
	}
	publicHostMu.Lock()
	publicHostCache = m
	publicHostMu.Unlock()
}

// publicHostUnderlying maps a request host to the protected endpoint it
// publishes, if any. Lazily warms the cache on first use.
func publicHostUnderlying(host string) (string, bool) {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	publicHostMu.RLock()
	c := publicHostCache
	publicHostMu.RUnlock()
	if c == nil {
		refreshPublicHostCache()
		publicHostMu.RLock()
		c = publicHostCache
		publicHostMu.RUnlock()
	}
	ep, ok := c[host]
	return ep, ok
}

// isPublicEndpointHost reports whether host is a published public host.
func isPublicEndpointHost(host string) bool {
	_, ok := publicHostUnderlying(host)
	return ok
}

// handlePublicEndpointsList serves the workspace's published public endpoints as
// JSON on the network :8080 listener, so the workspace dashboard can badge the
// "Open app" links that are also public (#220). Low-sensitivity — public
// endpoints are public by definition — so no auth beyond bitswan_network reach.
func (s *Server) handlePublicEndpointsList(w http.ResponseWriter, r *http.Request) {
	recs, err := dbListPublicEndpoints()
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	out := make([]map[string]string, 0, len(recs))
	for _, rec := range recs {
		out = append(out, map[string]string{
			"endpoint_host": rec.EndpointHost,
			"public_host":   rec.PublicHost,
			"public_url":    "https://" + rec.PublicHost,
		})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

// isPublicNamespaceBase reports whether host is the base of the per-AOC public
// namespace this server publishes under (i.e. some published host is
// "<label>." + host, e.g. host == "public.<aoc-id>.bswn.io"). The ONE wildcard
// cert for the namespace runs its DNS-01 challenge at this base
// (_acme-challenge.public.<aoc-id>), so the ACME bridge must authorise it.
func isPublicNamespaceBase(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if host == "" {
		return false
	}
	publicHostMu.RLock()
	c := publicHostCache
	publicHostMu.RUnlock()
	if c == nil {
		refreshPublicHostCache()
		publicHostMu.RLock()
		c = publicHostCache
		publicHostMu.RUnlock()
	}
	for ph := range c {
		if i := strings.IndexByte(ph, '.'); i >= 0 && ph[i+1:] == host {
			return true
		}
	}
	return false
}

// publicHostForEndpoint is the reverse of publicHostUnderlying: given a
// protected endpoint host, returns the public host it's published at (if any).
// Used by the chrome wrap to badge a protected endpoint that is also public.
func publicHostForEndpoint(endpointHost string) (string, bool) {
	endpointHost = strings.ToLower(strings.TrimSuffix(endpointHost, "."))
	publicHostMu.RLock()
	c := publicHostCache
	publicHostMu.RUnlock()
	if c == nil {
		refreshPublicHostCache()
		publicHostMu.RLock()
		c = publicHostCache
		publicHostMu.RUnlock()
	}
	for ph, eh := range c {
		if eh == endpointHost {
			return ph, true
		}
	}
	return "", false
}

// --- authorization ---

// canMakePublic enforces #220's publish rule: owner AND admin-or-auditor AND
// the endpoint is a production frontend. Returns a user-facing reason on deny.
func canMakePublic(email string, groups []string, host string) (ok bool, reason string) {
	role, err := roleFor(host, email, groups)
	if err != nil {
		return false, "could not resolve endpoint role"
	}
	if role != roleOwner {
		return false, "only an owner of this endpoint can publish it"
	}
	if er := effectiveRole(email); er != "admin" && er != "auditor" {
		return false, "only an admin or auditor can publish an endpoint publicly"
	}
	ep, err := getEndpoint(host)
	if err != nil || ep == nil {
		return false, "endpoint not registered"
	}
	if !strings.EqualFold(ep.Stage, "production") {
		return false, "only production endpoints can be made public"
	}
	if ep.Kind != endpointKindFrontend {
		return false, "only frontend endpoints can be made public"
	}
	return true, ""
}

// --- AOC client (allocate/deallocate the public subdomain) ---

func aocPublicSettings() (*config.AutomationOperationsCenterSettings, error) {
	cfg := config.NewAutomationServerConfig()
	s, err := cfg.GetAutomationOperationsCenterSettings()
	if err != nil {
		return nil, err
	}
	if s == nil || strings.TrimSpace(s.AOCUrl) == "" || strings.TrimSpace(s.AccessToken) == "" {
		return nil, fmt.Errorf("this server is not registered with an AOC")
	}
	return s, nil
}

// aocAllocatePublicEndpoint asks the AOC to allocate a public subdomain for the
// endpoint (ensuring the *.public.<aoc-id> wildcard) and returns the host+URL.
// aocErrorMessage turns an AOC error response into a short, human-readable
// sentence. It NEVER returns the raw body — that is often an HTML error page
// (e.g. Django's 404) which must never surface in the UI.
func aocErrorMessage(status int, body []byte) string {
	var j struct {
		Error  string `json:"error"`
		Detail string `json:"detail"`
	}
	if json.Unmarshal(body, &j) == nil {
		if m := strings.TrimSpace(j.Error); m != "" {
			return m
		}
		if m := strings.TrimSpace(j.Detail); m != "" {
			return m
		}
	}
	if status == http.StatusNotFound {
		return "this operations center doesn't support public endpoints yet"
	}
	return fmt.Sprintf("the operations center returned HTTP %d", status)
}

func aocAllocatePublicEndpoint(endpointHost, endpointName string) (publicHost, publicURL string, err error) {
	s, err := aocPublicSettings()
	if err != nil {
		return "", "", err
	}
	payload, _ := json.Marshal(map[string]string{
		"endpoint_host": endpointHost,
		"endpoint_name": endpointName,
	})
	base := strings.TrimRight(s.AOCUrl, "/")
	req, err := http.NewRequest(http.MethodPost, base+"/api/automation_server/public-endpoint", bytes.NewReader(payload))
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Authorization", "Bearer "+s.AccessToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 25 * time.Second}).Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
		return "", "", fmt.Errorf("%s", aocErrorMessage(resp.StatusCode, b))
	}
	var out struct {
		PublicHost string `json:"public_host"`
		PublicURL  string `json:"public_url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", "", fmt.Errorf("decode AOC allocate response: %w", err)
	}
	if out.PublicHost == "" {
		return "", "", fmt.Errorf("AOC returned an empty public host")
	}
	if out.PublicURL == "" {
		out.PublicURL = "https://" + out.PublicHost
	}
	return out.PublicHost, out.PublicURL, nil
}

// aocDeallocatePublicEndpoint releases the public subdomain for the endpoint.
func aocDeallocatePublicEndpoint(endpointHost string) error {
	s, err := aocPublicSettings()
	if err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]string{"endpoint_host": endpointHost})
	base := strings.TrimRight(s.AOCUrl, "/")
	req, err := http.NewRequest(http.MethodDelete, base+"/api/automation_server/public-endpoint", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+s.AccessToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 25 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
		return fmt.Errorf("%s", aocErrorMessage(resp.StatusCode, b))
	}
	return nil
}

// --- traefik route for the public host ---

// registerPublicRoute adds a Bailey-traefik route for the public host straight
// to the gate (:9080), DELIBERATELY bypassing the oauth2-proxy hop that fronts
// protected hosts — public hosts must not trigger a Keycloak login.
func registerPublicRoute(publicHost string) error {
	upstream := daemonContainerName + gateListenAddr // e.g. bitswan-automation-server-daemon:9080
	// Public hosts share the AOC's per-AOC *.public.<aoc-id> namespace, so we
	// obtain ONE wildcard DNS-01 cert for that namespace — exactly like the
	// per-server *.<domain> cert — rather than a per-host cert. The challenge
	// then runs once for the whole namespace (_acme-challenge.public.<aoc-id>)
	// instead of racing DNS propagation on every publish. HTTP-01 can't work
	// (the host only resolves through the relay); the DNS-01 solver runs through
	// the AOC ACME bridge, which authorises the challenge for the owning server.
	parts := strings.SplitN(publicHost, ".", 2)
	if len(parts) != 2 {
		return fmt.Errorf("malformed public host %q", publicHost)
	}
	publicBase := parts[1] // public.<aoc-id>.bswn.io
	// A published public host lives in the AOC's own namespace and can only ever
	// be certified through the AOC's zone. A server whose TLS mode contacts no CA
	// therefore cannot serve one, and silently registering the route would publish
	// a URL that answers with an untrusted certificate. Refuse with the reason.
	if !currentTLSMode().usesACME() {
		return fmt.Errorf(
			"cannot publish %s: this server's TLS mode is %s, and a public endpoint's certificate "+
				"can only be issued through the AOC's zone (mode %s). Publishing is unavailable on "+
				"this server",
			publicHost, currentTLSMode(), TLSModeAOCDNS)
	}
	return traefikapi.AddRouteWithTLSDomains(
		publicHost, upstream, "", dnsCertResolverName,
		traefikapi.WildcardTLSDomains(publicBase))
}

func deregisterPublicRoute(publicHost string) error {
	return traefikapi.RemoveRoute(publicHost)
}

// --- gate handlers ---

// handlePublicCreate publishes the request's endpoint as a public URL. Mirrors
// handleMagicLinkCreate: browser cookie auth, endpoint = the request's host.
func handlePublicCreate(w http.ResponseWriter, r *http.Request, email string, groups []string) {
	if email == "" {
		writeJSONErrorStatus(w, "no identity", http.StatusUnauthorized)
		return
	}
	host := toOuterHost(requestEndpointHost(r))
	if ok, reason := canMakePublic(email, groups, host); !ok {
		writeJSONErrorStatus(w, reason, http.StatusForbidden)
		return
	}
	name := host
	if ep, _ := getEndpoint(host); ep != nil && strings.TrimSpace(ep.DisplayName) != "" {
		name = ep.DisplayName
	}
	publicHost, publicURL, err := aocAllocatePublicEndpoint(host, name)
	if err != nil {
		writeJSONErrorStatus(w, "Couldn't publish: "+err.Error()+".", http.StatusBadGateway)
		return
	}
	// Persist BEFORE registering the route so acmeChallengeFQDNAllowed (which
	// consults the cache) authorises the cert challenge that route triggers.
	if err := dbUpsertPublicEndpoint(host, publicHost, email); err != nil {
		_ = aocDeallocatePublicEndpoint(host)
		writeJSONErrorStatus(w, "record public endpoint: "+err.Error(), http.StatusInternalServerError)
		return
	}
	refreshPublicHostCache()
	if err := registerPublicRoute(publicHost); err != nil {
		_ = dbDeletePublicEndpoint(host)
		refreshPublicHostCache()
		_ = aocDeallocatePublicEndpoint(host)
		writeJSONErrorStatus(w, "register public route: "+err.Error(), http.StatusInternalServerError)
		return
	}
	_ = recordEvent(email, auditPublicCreate, host)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":          true,
		"host":        host,
		"public_host": publicHost,
		"public_url":  publicURL,
	})
}

// handlePublicRevoke makes a published endpoint private again. Same guard as
// publishing.
func handlePublicRevoke(w http.ResponseWriter, r *http.Request, email string, groups []string) {
	host := toOuterHost(requestEndpointHost(r))
	if ok, reason := canMakePublic(email, groups, host); !ok {
		writeJSONErrorStatus(w, reason, http.StatusForbidden)
		return
	}
	rec, err := dbGetPublicEndpoint(host)
	if err != nil {
		writeJSONErrorStatus(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if rec == nil {
		writeJSONErrorStatus(w, "endpoint is not public", http.StatusNotFound)
		return
	}
	if err := deregisterPublicRoute(rec.PublicHost); err != nil {
		writeJSONErrorStatus(w, "remove public route: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if err := dbDeletePublicEndpoint(host); err != nil {
		writeJSONErrorStatus(w, "delete public endpoint: "+err.Error(), http.StatusInternalServerError)
		return
	}
	refreshPublicHostCache()
	if err := aocDeallocatePublicEndpoint(host); err != nil {
		// The local route + row are already gone (the endpoint is private on
		// this server); surface the AOC cleanup failure but don't fail the call.
		fmt.Printf("public: AOC deallocate for %q: %v\n", host, err)
	}
	_ = recordEvent(email, auditPublicRevoke, host)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

// reapplyPublicEndpoints warms the gate's public-host cache and re-asserts the
// traefik route for every published endpoint. Called once at daemon startup —
// idempotent, so a restart restores public serving without operator action.
func reapplyPublicEndpoints() {
	refreshPublicHostCache()
	recs, err := dbListPublicEndpoints()
	if err != nil {
		fmt.Printf("public: reapply routes: %v\n", err)
		return
	}
	for _, rec := range recs {
		if err := registerPublicRoute(rec.PublicHost); err != nil {
			fmt.Printf("public: reapply route %q: %v\n", rec.PublicHost, err)
		}
	}
}

// --- gate serving path ---

// directPublic rewrites a request for a published public host so the gate proxy
// serves the underlying protected endpoint's app with NO auth and the fixed
// anon identity. endpointHost is the protected OUTER host the public host maps
// to. Called from gateDirector.
func directPublic(r *http.Request, endpointHost string) {
	stripForwardedIdentityHeaders(r)
	// Resolve the upstream exactly as a normal request to the endpoint would —
	// via its inner host (workspace sub-traefik or a registered protected
	// route). The public host is not a route the sub-traefik knows, so we
	// present the inner host to it.
	inner := toInnerHost(endpointHost)
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
	// The point of #220: the frontend sees anonymous visitors as a fixed
	// pseudo-identity. anon@example.com is not a real user.
	r.Header.Set("X-Forwarded-Email", anonPublicEmail)
	r.Header.Del("X-Forwarded-Groups")
	// A real Keycloak access token for anon@example.com, so the app's backend
	// sees a genuine bearer token exactly as on the protected path (#220).
	if tok, err := anonAccessToken(); err == nil && tok != "" {
		r.Header.Set("X-Forwarded-Access-Token", tok)
		r.Header.Set("X-Auth-Request-Access-Token", tok)
	}
	stripBaileyAuthCookies(r)
}

var (
	anonTokenMu  sync.Mutex
	anonTokenVal string
	anonTokenExp time.Time
)

// anonAccessToken returns a cached real Keycloak access token for
// anon@example.com (minted by the AOC for this server's protected client),
// refreshing at ~80% of its lifetime. It is what makes a PUBLIC endpoint
// indistinguishable from the protected one to the app (#220).
func anonAccessToken() (string, error) {
	anonTokenMu.Lock()
	defer anonTokenMu.Unlock()
	if anonTokenVal != "" && time.Now().Before(anonTokenExp) {
		return anonTokenVal, nil
	}
	s, err := aocPublicSettings()
	if err != nil {
		return "", err
	}
	base := strings.TrimRight(s.AOCUrl, "/")
	req, err := http.NewRequest(http.MethodGet, base+"/api/automation_server/public-anon-token", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+s.AccessToken)
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
		return "", fmt.Errorf("%s", aocErrorMessage(resp.StatusCode, b))
	}
	var out struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	if out.AccessToken == "" {
		return "", fmt.Errorf("AOC returned an empty anon token")
	}
	ttl := out.ExpiresIn
	if ttl <= 0 {
		ttl = 900
	}
	anonTokenVal = out.AccessToken
	anonTokenExp = time.Now().Add(time.Duration(ttl*8/10) * time.Second)
	return anonTokenVal, nil
}

// servePublicOAuth2 replicates the oauth2-proxy endpoints an app calls, for a
// public host (#220), so the frontend gets its token exactly as on the
// protected path. Returns true if it handled the request.
func servePublicOAuth2(w http.ResponseWriter, r *http.Request) bool {
	switch r.URL.Path {
	case "/oauth2/auth":
		// The BitSwan frontend lib reads X-Auth-Request-Access-Token off this
		// response (202), just like oauth2-proxy's --set-xauthrequest.
		tok, err := anonAccessToken()
		if err != nil {
			http.Error(w, "anon token unavailable: "+err.Error(), http.StatusBadGateway)
			return true
		}
		w.Header().Set("X-Auth-Request-Access-Token", tok)
		w.Header().Set("X-Auth-Request-Email", anonPublicEmail)
		w.Header().Set("X-Auth-Request-User", anonPublicEmail)
		w.Header().Set("X-Auth-Request-Preferred-Username", anonPublicEmail)
		w.WriteHeader(http.StatusAccepted)
		return true
	case "/oauth2/userinfo":
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"user":              anonPublicEmail,
			"email":             anonPublicEmail,
			"preferredUsername": anonPublicEmail,
		})
		return true
	}
	return false
}

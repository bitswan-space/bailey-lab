package daemon

import (
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The coding agent's browser access (#210) hands a robot an identity on a
// live-dev app with no sign-in. These are the tests that fail if the boundary
// around that is wrong: which endpoints it reaches, whose cookie it honours,
// and whether the token it mints is one a worker can actually verify.

// agentTestServer gives one test its own HOME, bailey.db and signing key, and
// registers a domain — without one there is no issuer and the whole feature is
// correctly unavailable.
func agentTestServer(t *testing.T) {
	t.Helper()
	setupTestConfig(t, "https://aoc.example.com", "example.com")
	reopenBaileyDBForTest(t)
	t.Cleanup(func() { reopenBaileyDBForTest(t) })
	agentKeyMu.Lock()
	agentKeyVal = nil
	agentKeyMu.Unlock()
	agentTokenMu.Lock()
	agentTokenCache = map[string]agentCachedToken{}
	agentTokenMu.Unlock()
}

func seedAgentIdentity(t *testing.T, label, workspace string, groups []string) agentIdentity {
	t.Helper()
	id := agentIdentity{
		Label:     label,
		Email:     defaultAgentEmail(label, workspace),
		Groups:    groups,
		Workspace: workspace,
	}
	if err := dbUpsertAgentIdentity(id); err != nil {
		t.Fatalf("upsert identity: %v", err)
	}
	return id
}

func seedEndpoint(t *testing.T, host, kind, stage string) {
	t.Helper()
	if _, err := registerEndpoint(host, "owner@example.com", host, "", kind, stage); err != nil {
		t.Fatalf("registerEndpoint(%s): %v", host, err)
	}
}

// --- the live-dev boundary -------------------------------------------------

func TestAgentSessionIsOnlyForLiveDevFrontends(t *testing.T) {
	agentTestServer(t)
	cases := []struct {
		host, kind, stage string
		want              bool
	}{
		{"app-live-dev.example.com", endpointKindFrontend, "live-dev", true},
		{"app-staging.example.com", endpointKindFrontend, "staging", false},
		{"app-prod.example.com", endpointKindFrontend, "production", false},
		{"app-dev.example.com", endpointKindFrontend, "dev", false},
		{"svc-live-dev.example.com", endpointKindService, "live-dev", false},
	}
	for _, c := range cases {
		seedEndpoint(t, c.host, c.kind, c.stage)
		ok, reason := canGiveAgentSession(c.host)
		if ok != c.want {
			t.Errorf("canGiveAgentSession(%s stage=%s kind=%s) = %v (%s), want %v",
				c.host, c.stage, c.kind, ok, reason, c.want)
		}
	}
}

func TestAgentSessionRefusesAnUnknownEndpoint(t *testing.T) {
	agentTestServer(t)
	if ok, _ := canGiveAgentSession("never-registered.example.com"); ok {
		t.Fatal("a host with no endpoint row was given a session")
	}
}

// --- resolving a cookie ----------------------------------------------------

func agentRequest(host, cookie string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "https://"+host+"/", nil)
	r.Host = host
	if cookie != "" {
		r.AddCookie(&http.Cookie{Name: agentSessionCookie, Value: cookie})
	}
	return r
}

func TestAgentSessionResolvesOnlyOnItsOwnEndpoint(t *testing.T) {
	agentTestServer(t)
	const mine = "mine-live-dev.example.com"
	const theirs = "theirs-live-dev.example.com"
	seedAgentIdentity(t, "reviewer", "ws1", []string{"/Acme"})
	token, _, _, err := dbCreateAgentSession("reviewer", mine, "ws1", agentSessionTTL)
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	if got := agentSessionFor(agentRequest(mine, token)); got == nil {
		t.Fatal("the session did not resolve on the endpoint it was issued for")
	}
	// A cookie is domain-scoped, so the browser sends it to every host under the
	// domain. This comparison is the only thing stopping one live-dev app's
	// session from opening another's.
	if got := agentSessionFor(agentRequest(theirs, token)); got != nil {
		t.Fatal("the session resolved on a DIFFERENT endpoint — it is a domain-wide credential")
	}
	// The inner host serves the same endpoint's content and must resolve.
	if got := agentSessionFor(agentRequest(toInnerHost(mine), token)); got == nil {
		t.Fatal("the session did not resolve on the endpoint's inner host")
	}
}

func TestAgentSessionRejectsUnknownAndExpiredCookies(t *testing.T) {
	agentTestServer(t)
	const host = "app-live-dev.example.com"
	seedAgentIdentity(t, "reviewer", "ws1", nil)

	if got := agentSessionFor(agentRequest(host, "not-a-real-token")); got != nil {
		t.Fatal("an unknown cookie resolved to an identity")
	}
	if got := agentSessionFor(agentRequest(host, "")); got != nil {
		t.Fatal("a request with no cookie resolved to an identity")
	}

	expired, _, _, err := dbCreateAgentSession("reviewer", host, "ws1", -time.Minute)
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if got := agentSessionFor(agentRequest(host, expired)); got != nil {
		t.Fatal("a lapsed session still authenticated — expiry is not enforced on read")
	}
}

func TestDeletingAnIdentityKillsItsSessions(t *testing.T) {
	agentTestServer(t)
	const host = "app-live-dev.example.com"
	seedAgentIdentity(t, "reviewer", "ws1", nil)
	token, _, _, err := dbCreateAgentSession("reviewer", host, "ws1", agentSessionTTL)
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if got := agentSessionFor(agentRequest(host, token)); got == nil {
		t.Fatal("precondition: the session should resolve before the delete")
	}
	if err := dbDeleteAgentIdentity("reviewer", "ws1"); err != nil {
		t.Fatalf("delete identity: %v", err)
	}
	if got := agentSessionFor(agentRequest(host, token)); got != nil {
		t.Fatal("a browser holding the cookie still had access after the identity was deleted")
	}
}

// --- the identity the app is handed ----------------------------------------

func TestAgentRequestCarriesTheIdentityAndNotTheCallersHeaders(t *testing.T) {
	agentTestServer(t)
	id := seedAgentIdentity(t, "reviewer", "ws1", []string{"/Acme", "/Acme/admin"})
	ctx := &agentSessionContext{identity: id, issuer: "https://agent-auth.example.com"}

	r := httptest.NewRequest(http.MethodGet, "https://app-live-dev.example.com/", nil)
	r.Header.Set("X-Forwarded-Email", "attacker@example.com")
	r.Header.Set("X-Forwarded-Groups", "/Admins")
	applyAgentIdentityHeaders(r, ctx)

	if got := r.Header.Get("X-Forwarded-Email"); got != id.Email {
		t.Fatalf("identity header = %q, want the session's %q", got, id.Email)
	}
	if got := r.Header.Get("X-Forwarded-Groups"); got != "/Acme,/Acme/admin" {
		t.Fatalf("groups header = %q, want the session's groups", got)
	}
}

func TestAgentOAuth2HandsTheAppAToken(t *testing.T) {
	agentTestServer(t)
	id := seedAgentIdentity(t, "reviewer", "ws1", []string{"/Acme"})
	ctx := &agentSessionContext{identity: id, issuer: "https://agent-auth.example.com"}

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "https://app-live-dev.example.com/oauth2/auth", nil)
	if !serveAgentOAuth2(w, r, ctx) {
		t.Fatal("/oauth2/auth was not handled")
	}
	if w.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202 — the frontend library keys on that", w.Code)
	}
	if w.Header().Get("X-Auth-Request-Access-Token") == "" {
		t.Fatal("no token in X-Auth-Request-Access-Token; the app's fetch would throw")
	}
	if got := w.Header().Get("X-Auth-Request-Email"); got != id.Email {
		t.Fatalf("email header = %q, want %q", got, id.Email)
	}
}

// --- the token itself ------------------------------------------------------

// decodeAgentToken splits a minted token and returns its header and claims.
func decodeAgentToken(t *testing.T, tok string) (header, claims map[string]any, signing, sig string) {
	t.Helper()
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatalf("token has %d segments, want 3", len(parts))
	}
	decode := func(s string) map[string]any {
		raw, err := base64.RawURLEncoding.DecodeString(s)
		if err != nil {
			t.Fatalf("segment is not base64url: %v", err)
		}
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatalf("segment is not JSON: %v", err)
		}
		return m
	}
	return decode(parts[0]), decode(parts[1]), parts[0] + "." + parts[1], parts[2]
}

func TestAgentTokenVerifiesAgainstTheAdvertisedKeySet(t *testing.T) {
	agentTestServer(t)
	id := seedAgentIdentity(t, "reviewer", "ws1", []string{"/Acme", "/Acme/admin"})

	issuer := currentAgentIssuerURL()
	if issuer == "" {
		t.Fatal("no issuer for a server with a domain")
	}
	tok, err := mintAgentToken(id, issuer)
	if err != nil {
		t.Fatalf("mint: %v", err)
	}

	// Fetch the key set the way a worker would, then verify the signature with
	// it. This is the test that fails if the JWKS encoding is wrong — a token
	// that looks perfect and that nothing can check.
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "https://agent-auth.example.com"+agentJWKSPath, nil)
	r.Host = "agent-auth.example.com"
	if !serveAgentIDP(w, r) {
		t.Fatal("the key set was not served on the issuer host")
	}
	var jwks struct {
		Keys []struct {
			Kid, N, E string
		}
	}
	if err := json.Unmarshal(w.Body.Bytes(), &jwks); err != nil {
		t.Fatalf("key set is not JSON: %v", err)
	}
	if len(jwks.Keys) != 1 {
		t.Fatalf("key set has %d keys, want 1", len(jwks.Keys))
	}
	nBytes, err := base64.RawURLEncoding.DecodeString(jwks.Keys[0].N)
	if err != nil {
		t.Fatalf("modulus is not base64url: %v", err)
	}
	eBytes, err := base64.RawURLEncoding.DecodeString(jwks.Keys[0].E)
	if err != nil {
		t.Fatalf("exponent is not base64url: %v", err)
	}
	pub := &rsa.PublicKey{
		N: new(big.Int).SetBytes(nBytes),
		E: int(new(big.Int).SetBytes(eBytes).Int64()),
	}

	header, claims, signing, sig := decodeAgentToken(t, tok)
	if header["kid"] != jwks.Keys[0].Kid {
		t.Fatalf("token kid %v is not the key set's %v", header["kid"], jwks.Keys[0].Kid)
	}
	sigBytes, err := base64.RawURLEncoding.DecodeString(sig)
	if err != nil {
		t.Fatalf("signature is not base64url: %v", err)
	}
	digest := sha256.Sum256([]byte(signing))
	if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, digest[:], sigBytes); err != nil {
		t.Fatalf("token does not verify against the advertised key: %v", err)
	}
	if claims["iss"] != issuer {
		t.Fatalf("iss = %v, want %v", claims["iss"], issuer)
	}
	if claims["email"] != id.Email {
		t.Fatalf("email = %v, want %v", claims["email"], id.Email)
	}
}

func TestAgentTokenCarriesGroupsUnderBothClaimNames(t *testing.T) {
	agentTestServer(t)
	id := seedAgentIdentity(t, "reviewer", "ws1", []string{"/Acme", "/Acme/admin"})
	tok, err := mintAgentToken(id, "https://agent-auth.example.com")
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	_, claims, _, _ := decodeAgentToken(t, tok)
	// A worker started against Keycloak reads group_membership; one started
	// against the broker reads groups. An issuer that emitted only one of them
	// would work against half the deployments, so both are written.
	for _, name := range []string{"group_membership", "groups"} {
		raw, ok := claims[name].([]any)
		if !ok || len(raw) != 2 || raw[0] != "/Acme" || raw[1] != "/Acme/admin" {
			t.Fatalf("claim %q = %v, want the identity's two groups", name, claims[name])
		}
	}
}

func TestAgentDiscoveryPointsAtTheKeySet(t *testing.T) {
	agentTestServer(t)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "https://agent-auth.example.com"+agentDiscoveryPath, nil)
	r.Host = "agent-auth.example.com"
	if !serveAgentIDP(w, r) {
		t.Fatal("discovery was not served on the issuer host")
	}
	var doc struct {
		Issuer  string `json:"issuer"`
		JWKSURI string `json:"jwks_uri"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &doc); err != nil {
		t.Fatalf("discovery is not JSON: %v", err)
	}
	// A worker builds the discovery URL by appending to the issuer, so the
	// issuer it advertises has to be the host these documents are served on.
	if doc.Issuer != "https://agent-auth.example.com" {
		t.Fatalf("issuer = %q", doc.Issuer)
	}
	if doc.JWKSURI != doc.Issuer+agentJWKSPath {
		t.Fatalf("jwks_uri = %q, want %q", doc.JWKSURI, doc.Issuer+agentJWKSPath)
	}
}

func TestAgentIDPIsNotServedOnOtherHosts(t *testing.T) {
	agentTestServer(t)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "https://app-live-dev.example.com"+agentDiscoveryPath, nil)
	r.Host = "app-live-dev.example.com"
	if serveAgentIDP(w, r) {
		t.Fatal("the issuer's documents answered on an app's hostname")
	}
}

func TestAgentRouteIDDoesNotCollideWithTheEndpointsOwn(t *testing.T) {
	const host = "app-live-dev.example.com"
	if agentRouteID(host) == "app_live_dev_example_com" {
		t.Fatal("the agent router would replace the endpoint's own router")
	}
}

// The cookie predicate is the one genuinely new mechanism here: it is what lets
// one hostname serve a person through the sign-in and the agent through the
// gate. A typo in it fails open in the worst way — every request on the host
// keeps working, and the agent's simply never takes the bypass.
func TestAgentRouteRuleNamesTheHostAndTheCookie(t *testing.T) {
	rule := agentRouteRule("app-live-dev.example.com")
	for _, want := range []string{
		"Host(`app-live-dev.example.com`)",
		"HeaderRegexp(`Cookie`, `_bailey_agent=`)",
		"&&",
	} {
		if !strings.Contains(rule, want) {
			t.Fatalf("rule %q is missing %q", rule, want)
		}
	}
	// Traefik breaks ties by rule length, which would already favour this one,
	// but the bypass is too important to rest on that.
	if agentRoutePriority <= 0 {
		t.Fatal("the agent router has no priority over the hostname's own")
	}
}

// The browser loads two hostnames for one endpoint: the outer one that serves
// Bailey's chrome, and the inner one its iframe points at, which serves the app.
// Covering only the outer one renders a wrap around a frame that bounces to the
// sign-in — everything looks signed in except the part the agent came to see.
func TestAgentRoutesCoverBothHalvesOfTheEndpoint(t *testing.T) {
	hosts := agentRouteHosts("app-live-dev.example.com")
	if len(hosts) != 2 || hosts[0] != "app-live-dev.example.com" ||
		hosts[1] != "app-live-dev--inner.example.com" {
		t.Fatalf("agentRouteHosts = %v, want the outer and inner host", hosts)
	}
	if agentRouteID(hosts[0]) == agentRouteID(hosts[1]) {
		t.Fatal("both halves share a router id, so registering one removes the other")
	}
	// Given the inner host, the pair must still be the same two — a session is
	// issued against the outer host and the ACL keys on it.
	if got := agentRouteHosts(hosts[1]); got[0] != hosts[0] || got[1] != hosts[1] {
		t.Fatalf("agentRouteHosts(inner) = %v, want %v", got, hosts)
	}
}

// The hand-over is the fix for a browser that was already running when the
// session was minted: it reads its stored cookies once, at start, so writing a
// cookie to its state file reaches a browser that will never look again. These
// pin the two halves of the way out of that.
func TestSignInURLExchangesTheHandoverForTheCookie(t *testing.T) {
	agentTestServer(t)
	const host = "app-live-dev.example.com"
	seedAgentIdentity(t, "reviewer", "ws1", []string{"/Acme"})
	cookie, handover, _, err := dbCreateAgentSession("reviewer", host, "ws1", agentSessionTTL)
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if handover == cookie {
		t.Fatal("the cookie's own value travels in the URL")
	}

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "https://"+host+"/?"+agentHandoverParam+"="+handover, nil)
	r.Host = host
	if !serveAgentHandover(w, r) {
		t.Fatal("the sign-in URL was not handled")
	}
	if w.Code != http.StatusSeeOther {
		t.Fatalf("status = %d, want a redirect off the token-bearing URL", w.Code)
	}
	if loc := w.Header().Get("Location"); strings.Contains(loc, agentHandoverParam) {
		t.Fatalf("the redirect kept the token in the URL: %s", loc)
	}
	var got string
	for _, c := range w.Result().Cookies() {
		if c.Name == agentSessionCookie {
			got = c.Value
		}
	}
	if got != cookie {
		t.Fatalf("the cookie handed over does not open the session")
	}
	// And it does open it.
	if agentSessionFor(agentRequest(host, got)) == nil {
		t.Fatal("the handed-over cookie does not resolve to the session")
	}
}

func TestSignInURLRefusesAnotherEndpointAndSaysWhatToDo(t *testing.T) {
	agentTestServer(t)
	seedAgentIdentity(t, "reviewer", "ws1", nil)
	_, handover, _, err := dbCreateAgentSession("reviewer", "mine-live-dev.example.com", "ws1", agentSessionTTL)
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "https://theirs-live-dev.example.com/?"+agentHandoverParam+"="+handover, nil)
	r.Host = "theirs-live-dev.example.com"
	if !serveAgentHandover(w, r) {
		t.Fatal("the sign-in URL was not handled")
	}
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
	// An expired or wrong link looks exactly like a broken feature from the
	// agent's side unless the answer says what to do about it.
	if !strings.Contains(w.Body.String(), "browser session") {
		t.Fatalf("the refusal does not say how to recover: %s", w.Body.String())
	}
}

func TestAgentRouteRuleAdmitsTheSignInURLAsWellAsTheCookie(t *testing.T) {
	rule := agentRouteRule("app-live-dev.example.com")
	// Without this the sign-in URL is routed to the login page, which is the one
	// thing it exists to avoid.
	if !strings.Contains(rule, agentHandoverParam) {
		t.Fatalf("the router does not match a sign-in URL: %s", rule)
	}
	if !strings.Contains(rule, "||") {
		t.Fatalf("the router does not admit both ways in: %s", rule)
	}
}

// A live-dev worker is pointed at this issuer so that a business process
// deployed before any of this still accepts an agent token — those workers
// verify a signature against one issuer's keys and never look at the iss claim.
// The price is that this key set must ALSO carry the real provider's keys, or
// the same deployment would stop accepting the people who actually use it.
func TestKeySetCarriesTheProvidersKeysAsWellAsOurs(t *testing.T) {
	agentTestServer(t)
	upstreamKeysMu.Lock()
	upstreamKeysVal = []any{map[string]any{"kid": "upstream-1", "kty": "RSA"}}
	upstreamKeysExp = time.Now().Add(time.Hour)
	upstreamKeysMu.Unlock()
	t.Cleanup(func() {
		upstreamKeysMu.Lock()
		upstreamKeysVal, upstreamKeysExp = nil, time.Time{}
		upstreamKeysMu.Unlock()
	})

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "https://agent-auth.example.com"+agentJWKSPath, nil)
	r.Host = "agent-auth.example.com"
	if !serveAgentIDP(w, r) {
		t.Fatal("the key set was not served")
	}
	var set struct {
		Keys []map[string]any `json:"keys"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &set); err != nil {
		t.Fatalf("key set is not JSON: %v", err)
	}
	if len(set.Keys) != 2 {
		t.Fatalf("key set has %d keys, want ours plus the provider's", len(set.Keys))
	}
	key, err := loadOrCreateAgentKey()
	if err != nil {
		t.Fatal(err)
	}
	if set.Keys[0]["kid"] != agentKeyID(key) {
		t.Fatalf("our key is not first: %v", set.Keys[0]["kid"])
	}
	if set.Keys[1]["kid"] != "upstream-1" {
		t.Fatalf("the provider's key is missing: %v", set.Keys[1]["kid"])
	}
}

func TestKeySetStillServesOursWhenTheProviderIsUnreachable(t *testing.T) {
	agentTestServer(t)
	// No upstream configured and nothing cached: the agent's own key must still
	// be published, or nothing it signs can be verified at all.
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "https://agent-auth.example.com"+agentJWKSPath, nil)
	r.Host = "agent-auth.example.com"
	if !serveAgentIDP(w, r) {
		t.Fatal("the key set was not served")
	}
	var set struct {
		Keys []map[string]any `json:"keys"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &set); err != nil {
		t.Fatalf("key set is not JSON: %v", err)
	}
	if len(set.Keys) != 1 {
		t.Fatalf("key set has %d keys, want just ours", len(set.Keys))
	}
}

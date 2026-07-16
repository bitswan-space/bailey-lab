package daemon

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// gateRequest builds a request as the gate sees it: oauth2-proxy has
// already authenticated the user and forwards identity headers.
func gateRequest(t *testing.T, host, path, email string, groups ...string) *http.Request {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "https://"+host+path, nil)
	r.Host = host
	if email != "" {
		r.Header.Set("X-Forwarded-Email", email)
	}
	if len(groups) > 0 {
		r.Header.Set("X-Forwarded-Groups", strings.Join(groups, ","))
	}
	return r
}

func TestEnforceEndpointACL_UnregisteredHostIsOpen(t *testing.T) {
	w := httptest.NewRecorder()
	r := gateRequest(t, "gate-unregistered.example.com", "/", "anyone@example.com")
	if !enforceEndpointACL(w, r, "anyone@example.com", nil) {
		t.Error("unregistered endpoint should be open until an owner is set")
	}
}

func TestEnforceEndpointACL_OwnerPasses(t *testing.T) {
	host := "gate-owner.example.com"
	if _, err := registerEndpoint(host, "owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	r := gateRequest(t, host, "/", "owner@example.com")
	if !enforceEndpointACL(w, r, "owner@example.com", nil) {
		t.Error("owner was denied")
	}
}

func TestEnforceEndpointACL_StrangerDeniedAndRequestRecorded(t *testing.T) {
	host := "gate-stranger.example.com"
	if _, err := registerEndpoint(host, "owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	r := gateRequest(t, host, "/", "stranger@example.com")
	if enforceEndpointACL(w, r, "stranger@example.com", nil) {
		t.Fatal("stranger was allowed through")
	}
	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", w.Code)
	}
	body := w.Body.String()
	// The page must be generic — it must NOT leak the endpoint hostname,
	// its owner, or offer a request-access affordance to an outsider.
	if !strings.Contains(body, "not a member of this organization") {
		t.Errorf("denied page missing the generic message:\n%s", body)
	}
	if strings.Contains(body, "owner@example.com") || strings.Contains(body, host) || strings.Contains(body, "Request access") {
		t.Errorf("denied page leaks endpoint/owner or offers request-access:\n%s", body)
	}
	// The attempt is recorded so the owner sees it in the share dialog.
	reqs, err := listAccessRequests(host)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, q := range reqs {
		if strings.EqualFold(q.Email, "stranger@example.com") {
			found = true
		}
	}
	if !found {
		t.Errorf("access request not recorded: %+v", reqs)
	}
}

func TestEnforceEndpointACL_InnerHostUsesOuterACL(t *testing.T) {
	host := "gate-inner.example.com"
	if _, err := registerEndpoint(host, "owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	r := gateRequest(t, toInnerHost(host), "/", "stranger@example.com")
	if enforceEndpointACL(w, r, "stranger@example.com", nil) {
		t.Error("inner-host request bypassed the outer host's ACL")
	}
}

func TestEnforceEndpointACL_GroupGrantPasses(t *testing.T) {
	host := "gate-group.example.com"
	if _, err := registerEndpoint(host, "owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := addGrant(host, "group", "/Acme/devs", "access", "owner@example.com"); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	r := gateRequest(t, host, "/", "dev@example.com", "/Acme/devs")
	if !enforceEndpointACL(w, r, "dev@example.com", []string{"/Acme/devs"}) {
		t.Error("group-granted user was denied")
	}
}

func TestEnforceEndpointACL_BaileyHostFreePassAndAutoRegister(t *testing.T) {
	host := "bailey.gate-test.example.com"
	w := httptest.NewRecorder()
	r := gateRequest(t, host, "/", "first@example.com")
	if !enforceEndpointACL(w, r, "first@example.com", nil) {
		t.Fatal("bailey host must never be gated")
	}
	// First sign-in claims server ownership.
	ep, err := getEndpoint(host)
	if err != nil || ep == nil {
		t.Fatalf("bailey endpoint not auto-registered: %v", err)
	}
	if !strings.EqualFold(ep.OwnerEmail, "first@example.com") {
		t.Errorf("bailey owner = %q", ep.OwnerEmail)
	}
	// A later user passes too, but doesn't steal ownership.
	w2 := httptest.NewRecorder()
	r2 := gateRequest(t, host, "/", "second@example.com")
	if !enforceEndpointACL(w2, r2, "second@example.com", nil) {
		t.Error("second user gated on bailey host")
	}
	ep2, _ := getEndpoint(host)
	if !strings.EqualFold(ep2.OwnerEmail, "first@example.com") {
		t.Errorf("bailey ownership changed to %q", ep2.OwnerEmail)
	}
}

func TestEnforceProtectedGate_NoIdentityPassesThrough(t *testing.T) {
	// No identity → upstream OIDC failed; the gate lets the request
	// through so the upstream's own 401 surfaces instead of a confusing
	// gate page.
	host := "gate-noident.example.com"
	if _, err := registerEndpoint(host, "owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	r := gateRequest(t, host, "/", "")
	if !enforceProtectedGate(w, r) {
		t.Error("identity-less request should pass through to the upstream")
	}
}

func TestEnforceProtectedGate_DisableEnv(t *testing.T) {
	host := "gate-disabled.example.com"
	if _, err := registerEndpoint(host, "owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	t.Setenv("BAILEY_GATE_DISABLE", "1")
	w := httptest.NewRecorder()
	r := gateRequest(t, host, "/", "stranger@example.com")
	if !enforceProtectedGate(w, r) {
		t.Error("BAILEY_GATE_DISABLE=1 should bypass enforcement")
	}
}

func TestHandleGatePath_Whoami(t *testing.T) {
	w := httptest.NewRecorder()
	r := gateRequest(t, "any.example.com", gatePathPrefix+"/whoami", "me@example.com", "/Acme/admin")
	handleGatePath(w, r)
	body := w.Body.String()
	if !strings.Contains(body, "email=me@example.com") || !strings.Contains(body, "admin=true") {
		t.Errorf("whoami output: %s", body)
	}
}

func TestHandleGatePath_RequiresIdentity(t *testing.T) {
	w := httptest.NewRecorder()
	r := gateRequest(t, "any.example.com", gatePathPrefix+"/whoami", "")
	handleGatePath(w, r)
	if w.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", w.Code)
	}
}

func TestUpstreamForHost(t *testing.T) {
	if u := upstreamForHost("not-inner.example.com"); u != nil {
		t.Errorf("outer host must have no gate upstream, got %v", u)
	}
	if u := upstreamForHost("bailey--inner.example.com"); u == nil || u.Host != "localhost:8080" {
		t.Errorf("bailey inner upstream = %v, want daemon :8080", u)
	}
	t.Setenv("BAILEY_DAEMON_HOST", "daemon-container")
	if u := upstreamForHost("bailey--inner.example.com"); u == nil || u.Host != "daemon-container:8080" {
		t.Errorf("BAILEY_DAEMON_HOST override not honoured, got %v", u)
	}
}

func TestUpstreamForHost_ProtectedRouteRecord(t *testing.T) {
	// Route registration records the upstream; the gate resolves the
	// inner host through it regardless of workspace-traefik presence.
	if err := saveProtectedRoute("gateup-editor.example.com", "gateup-editor:9999"); err != nil {
		t.Fatal(err)
	}
	u := upstreamForHost("gateup-editor--inner.example.com")
	if u == nil || u.Host != "gateup-editor:9999" || u.Scheme != "http" {
		t.Errorf("recorded route upstream = %v, want http://gateup-editor:9999", u)
	}

	// Replacing the record (e.g. a redeploy moved the port) wins.
	if err := saveProtectedRoute("gateup-editor.example.com", "gateup-editor:8080"); err != nil {
		t.Fatal(err)
	}
	if u := upstreamForHost("gateup-editor--inner.example.com"); u == nil || u.Host != "gateup-editor:8080" {
		t.Errorf("replaced route upstream = %v, want gateup-editor:8080", u)
	}

	// Deleting the record falls back to (absent) workspace traefik → nil.
	if err := deleteProtectedRoute("gateup-editor.example.com"); err != nil {
		t.Fatal(err)
	}
	if u := upstreamForHost("gateup-editor--inner.example.com"); u != nil {
		t.Errorf("deleted route still resolves: %v", u)
	}
}

// --- Issue #127: the visitor's live Keycloak access token must never
// reach a tenant-code upstream ---------------------------------------

// directorRequest builds a request as the gate's proxy Director sees it:
// oauth2-proxy has authenticated the visitor and injected identity plus
// the live access token (OAUTH2_PROXY_PASS_ACCESS_TOKEN=true). The
// X-Auth-Request-Access-Token twin is never proxy-injected on the
// request leg, so a value there models a client forgery. Authorization
// models the documented BP pattern: frontend JS fetched the token from
// /oauth2/auth and sends it as a Bearer header to its own backend.
func directorRequest(t *testing.T, host string) *http.Request {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "https://"+host+"/", nil)
	r.Host = host
	r.Header.Set("X-Forwarded-Email", "visitor@example.com")
	r.Header.Set("X-Forwarded-Groups", "/Acme/devs")
	r.Header.Set("X-Forwarded-Access-Token", "kc-live-token")
	r.Header.Set("X-Auth-Request-Access-Token", "forged-xar-token")
	r.Header.Set("Authorization", "Bearer client-sent-token")
	return r
}

func TestGateDirector_TokenStrippedFromTenantUpstreams(t *testing.T) {
	for _, kind := range []string{endpointKindFrontend, endpointKindService} {
		t.Run(kind, func(t *testing.T) {
			outer := "gatetoken-" + kind + ".example.com"
			if _, err := registerEndpoint(outer, "owner@example.com", "", "", kind, ""); err != nil {
				t.Fatal(err)
			}
			if err := saveProtectedRoute(outer, "bp-upstream:3000"); err != nil {
				t.Fatal(err)
			}
			r := directorRequest(t, toInnerHost(outer))
			gateDirector(r)
			if r.URL.Host != "bp-upstream:3000" {
				t.Fatalf("upstream = %q, want bp-upstream:3000", r.URL.Host)
			}
			// The visitor's token — replayable to impersonate them — must
			// never reach tenant code.
			for _, h := range forwardedTokenHeaders {
				if v := r.Header.Get(h); v != "" {
					t.Errorf("token header %q = %q reached a tenant upstream", h, v)
				}
			}
			for _, h := range forwardedIdentityHeaders {
				if v := r.Header.Get(h); v != "" {
					t.Errorf("identity header %q = %q reached a tenant upstream", h, v)
				}
			}
			// Client-SENT credentials pass through: the BP pattern has the
			// frontend send its /oauth2/auth-fetched token as a Bearer
			// header to its own backend via this gate. oauth2-proxy never
			// injects Authorization in our config, so this is not a leak.
			if got := r.Header.Get("Authorization"); got != "Bearer client-sent-token" {
				t.Errorf("client-sent Authorization = %q, want it preserved", got)
			}
		})
	}
}

func TestGateDirector_TokenStrippedFromUnknownHost(t *testing.T) {
	// No registered endpoint/route at all → sentinel 502 upstream. The
	// strip must already have happened — an unknown host is untrusted.
	r := directorRequest(t, "gatetoken-unknown--inner.example.com")
	gateDirector(r)
	if r.URL.Host != "no-upstream.invalid" {
		t.Fatalf("unknown host resolved to %q", r.URL.Host)
	}
	for _, h := range forwardedTokenHeaders {
		if r.Header.Get(h) != "" {
			t.Errorf("token header %q survived on the unknown-host path", h)
		}
	}
}

func TestGateDirector_TokenPreservedForBaileyUpstream(t *testing.T) {
	r := directorRequest(t, "bailey--inner.example.com")
	gateDirector(r)
	if r.URL.Host != "localhost:8080" {
		t.Fatalf("bailey upstream = %q, want localhost:8080", r.URL.Host)
	}
	if got := r.Header.Get("X-Forwarded-Access-Token"); got != "kc-live-token" {
		t.Errorf("X-Forwarded-Access-Token = %q, want the gate-captured token re-applied", got)
	}
	// Only the canonical header is re-applied; the request-leg
	// X-Auth-Request- twin is always a forgery and stays stripped.
	if got := r.Header.Get("X-Auth-Request-Access-Token"); got != "" {
		t.Errorf("forged X-Auth-Request-Access-Token = %q survived", got)
	}
	if got := r.Header.Get("X-Forwarded-Email"); got != "visitor@example.com" {
		t.Errorf("X-Forwarded-Email = %q, want re-applied identity", got)
	}
}

func TestGateDirector_TokenPreservedForTrustedWorkspaceApp(t *testing.T) {
	outer := "gatetoken-dash.example.com"
	if _, err := registerEndpoint(outer, "owner@example.com", "", "", endpointKindWorkspace, ""); err != nil {
		t.Fatal(err)
	}
	if err := saveProtectedRoute(outer, "dash-upstream:3000"); err != nil {
		t.Fatal(err)
	}
	r := directorRequest(t, toInnerHost(outer))
	gateDirector(r)
	if r.URL.Host != "dash-upstream:3000" {
		t.Fatalf("upstream = %q, want dash-upstream:3000", r.URL.Host)
	}
	if got := r.Header.Get("X-Forwarded-Access-Token"); got != "kc-live-token" {
		t.Errorf("X-Forwarded-Access-Token = %q, want it re-applied to the first-party dashboard", got)
	}
	if got := r.Header.Get("X-Auth-Request-Access-Token"); got != "" {
		t.Errorf("forged X-Auth-Request-Access-Token = %q survived", got)
	}
	if got := r.Header.Get("X-Forwarded-Email"); got != "visitor@example.com" {
		t.Errorf("X-Forwarded-Email = %q, want re-applied identity", got)
	}
}

func TestIsAdminGroups(t *testing.T) {
	cases := []struct {
		groups []string
		want   bool
	}{
		{[]string{"/Acme Org/admin"}, true},
		{[]string{"admin"}, true},
		{[]string{"/Acme Org/ADMIN"}, true},
		{[]string{"/Acme Org/users"}, false},
		{[]string{"/Acme Org/administrators"}, false},
		{nil, false},
	}
	for _, tc := range cases {
		if got := isAdminGroups(tc.groups); got != tc.want {
			t.Errorf("isAdminGroups(%v) = %v, want %v", tc.groups, got, tc.want)
		}
	}
}

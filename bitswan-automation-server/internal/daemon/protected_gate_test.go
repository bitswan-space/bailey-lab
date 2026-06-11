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
	if _, err := registerEndpoint(host, "owner@example.com", ""); err != nil {
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
	if _, err := registerEndpoint(host, "owner@example.com", ""); err != nil {
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
	if !strings.Contains(body, "owner@example.com") || !strings.Contains(body, "Request access") {
		t.Errorf("denied page missing owner / request button:\n%s", body)
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
	if _, err := registerEndpoint(host, "owner@example.com", ""); err != nil {
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
	if _, err := registerEndpoint(host, "owner@example.com", ""); err != nil {
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
	if _, err := registerEndpoint(host, "owner@example.com", ""); err != nil {
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
	if _, err := registerEndpoint(host, "owner@example.com", ""); err != nil {
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

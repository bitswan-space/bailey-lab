package daemon

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestACMEChallengeFQDNAllowed(t *testing.T) {
	tests := []struct {
		fqdn   string
		domain string
		want   bool
	}{
		// Wildcard / parent challenge.
		{"_acme-challenge.acme-prod.bswn.io", "acme-prod.bswn.io", true},
		// Per-host challenge under the server's domain.
		{"_acme-challenge.myws-editor.acme-prod.bswn.io", "acme-prod.bswn.io", true},
		// Canonical FQDN form with trailing dot, mixed case.
		{"_acme-challenge.ACME-PROD.bswn.io.", "acme-prod.bswn.io", true},
		// Missing prefix.
		{"acme-prod.bswn.io", "acme-prod.bswn.io", false},
		// Bare prefix with nothing after it.
		{"_acme-challenge.", "acme-prod.bswn.io", false},
		// Other tenant's domain and suffix-substring attack.
		{"_acme-challenge.other.bswn.io", "acme-prod.bswn.io", false},
		{"_acme-challenge.evil-acme-prod.bswn.io", "acme-prod.bswn.io", false},
		// Empty inputs.
		{"", "acme-prod.bswn.io", false},
		{"_acme-challenge.acme-prod.bswn.io", "", false},
	}

	for _, tt := range tests {
		if got := acmeChallengeFQDNAllowed(tt.fqdn, tt.domain); got != tt.want {
			t.Errorf("acmeChallengeFQDNAllowed(%q, %q) = %v, want %v", tt.fqdn, tt.domain, got, tt.want)
		}
	}
}

func TestRenderTraefikStaticConfig(t *testing.T) {
	plain := renderTraefikStaticConfig("ops@example.com", false)
	if strings.Contains(plain, "dnsChallenge") {
		t.Error("config without DNS challenge should not contain a dnsChallenge block")
	}
	if !strings.Contains(plain, "httpChallenge") {
		t.Error("config should always contain the httpChallenge resolver")
	}

	withDNS := renderTraefikStaticConfig("ops@example.com", true)
	for _, want := range []string{
		"httpChallenge",
		dnsCertResolverName + ":",
		"provider: httpreq",
		"storage: /acme/acme-dns.json",
	} {
		if !strings.Contains(withDNS, want) {
			t.Errorf("config with DNS challenge missing %q:\n%s", want, withDNS)
		}
	}
}

// setupTestConfig points HOME at a temp dir with an automation server config
// registering the given AOC URL and domain, plus a bridge secret file.
// Returns the bridge secret.
func setupTestConfig(t *testing.T, aocURL, domain string) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	// getWildcardCertDomain → config.GetRealUserHomeDir checks SUDO_USER first.
	t.Setenv("SUDO_USER", "")

	configDir := filepath.Join(home, ".config", "bitswan")
	if err := os.MkdirAll(configDir, 0755); err != nil {
		t.Fatal(err)
	}
	configTOML := fmt.Sprintf("[aoc]\naoc_url = %q\nautomation_server_id = \"test-server\"\naccess_token = \"test-token\"\ndomain = %q\n", aocURL, domain)
	if err := os.WriteFile(filepath.Join(configDir, "automation_server_config.toml"), []byte(configTOML), 0644); err != nil {
		t.Fatal(err)
	}

	traefikDir := filepath.Join(configDir, "traefik")
	secret, err := getOrCreateACMEBridgeSecret(traefikDir)
	if err != nil {
		t.Fatal(err)
	}
	return secret
}

func TestGetWildcardCertDomain(t *testing.T) {
	setupTestConfig(t, "https://aoc.example.com", "Acme-Prod.bswn.io.")
	if got := getWildcardCertDomain(); got != "acme-prod.bswn.io" {
		t.Errorf("getWildcardCertDomain() = %q, want normalized %q", got, "acme-prod.bswn.io")
	}
}

func TestCertResolverForHostname(t *testing.T) {
	setupTestConfig(t, "https://aoc.example.com", "acme-prod.bswn.io")

	resolver, domains := certResolverForHostname("myws-editor.acme-prod.bswn.io")
	if resolver != dnsCertResolverName {
		t.Errorf("resolver = %q, want %q", resolver, dnsCertResolverName)
	}
	if len(domains) != 1 || domains[0].Main != "acme-prod.bswn.io" {
		t.Errorf("unexpected tls domains: %+v", domains)
	}

	resolver, domains = certResolverForHostname("unrelated.example.com")
	if resolver != "letsencrypt" || domains != nil {
		t.Errorf("expected per-host letsencrypt for unrelated hostname, got %q %+v", resolver, domains)
	}

	resolver, domains = certResolverForHostname("foo.bitswan.localhost")
	if resolver != "" || domains != nil {
		t.Errorf("expected no ACME resolver for .localhost, got %q %+v", resolver, domains)
	}
}

// TestACMEDNSBridge exercises the daemon's httpreq bridge end to end against
// a mock AOC: basic-auth gating, fqdn scoping, and Bearer-token forwarding.
func TestACMEDNSBridge(t *testing.T) {
	var gotAuth, gotPath string
	var gotBody map[string]string
	mockAOC := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, `{"ok": true}`)
	}))
	defer mockAOC.Close()

	secret := setupTestConfig(t, mockAOC.URL, "acme-prod.bswn.io")

	s := &Server{}
	handler := s.handleACMEDNSChallenge("present")

	post := func(body string, auth bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, acmeBridgePath+"/present", strings.NewReader(body))
		if auth {
			req.SetBasicAuth(acmeBridgeUsername, secret)
		}
		w := httptest.NewRecorder()
		handler(w, req)
		return w
	}

	// No credentials → 401, nothing forwarded.
	if w := post(`{"fqdn": "_acme-challenge.acme-prod.bswn.io.", "value": "tok"}`, false); w.Code != http.StatusUnauthorized {
		t.Errorf("unauthenticated request: status = %d, want 401", w.Code)
	}

	// Wrong password → 401.
	req := httptest.NewRequest(http.MethodPost, acmeBridgePath+"/present", strings.NewReader(`{"fqdn": "_acme-challenge.acme-prod.bswn.io.", "value": "tok"}`))
	req.SetBasicAuth(acmeBridgeUsername, "wrong-secret")
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("wrong password: status = %d, want 401", w.Code)
	}

	// FQDN outside the server's domain → 403, nothing forwarded.
	if w := post(`{"fqdn": "_acme-challenge.other-tenant.bswn.io.", "value": "tok"}`, true); w.Code != http.StatusForbidden {
		t.Errorf("out-of-scope fqdn: status = %d, want 403", w.Code)
	}
	if gotPath != "" {
		t.Fatalf("rejected request must not reach the AOC, but AOC saw %q", gotPath)
	}

	// Valid request → forwarded to the AOC with the Bearer token.
	if w := post(`{"fqdn": "_acme-challenge.acme-prod.bswn.io.", "value": "challenge-token"}`, true); w.Code != http.StatusOK {
		t.Fatalf("valid request: status = %d, want 200 (body: %s)", w.Code, w.Body.String())
	}
	if gotPath != "/api/automation_server/dns/acme-challenge/present" {
		t.Errorf("AOC path = %q, want /api/automation_server/dns/acme-challenge/present", gotPath)
	}
	if gotAuth != "Bearer test-token" {
		t.Errorf("AOC Authorization = %q, want Bearer test-token", gotAuth)
	}
	if gotBody["fqdn"] != "_acme-challenge.acme-prod.bswn.io." || gotBody["value"] != "challenge-token" {
		t.Errorf("AOC body = %v, want fqdn and value forwarded verbatim", gotBody)
	}

	// GET → 405.
	reqGet := httptest.NewRequest(http.MethodGet, acmeBridgePath+"/present", nil)
	wGet := httptest.NewRecorder()
	handler(wGet, reqGet)
	if wGet.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET: status = %d, want 405", wGet.Code)
	}
}

// TestACMEDNSBridgeAOCError verifies that AOC failures surface as 502.
func TestACMEDNSBridgeAOCError(t *testing.T) {
	mockAOC := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error": "route53 unavailable"}`, http.StatusBadGateway)
	}))
	defer mockAOC.Close()

	secret := setupTestConfig(t, mockAOC.URL, "acme-prod.bswn.io")

	s := &Server{}
	handler := s.handleACMEDNSChallenge("cleanup")

	req := httptest.NewRequest(http.MethodPost, acmeBridgePath+"/cleanup", strings.NewReader(`{"fqdn": "_acme-challenge.acme-prod.bswn.io.", "value": "tok"}`))
	req.SetBasicAuth(acmeBridgeUsername, secret)
	w := httptest.NewRecorder()
	handler(w, req)
	if w.Code != http.StatusBadGateway {
		t.Errorf("AOC error: status = %d, want 502", w.Code)
	}
}

func TestGetOrCreateACMEBridgeSecretIsStable(t *testing.T) {
	dir := t.TempDir()
	first, err := getOrCreateACMEBridgeSecret(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 64 {
		t.Errorf("secret length = %d, want 64 hex chars", len(first))
	}
	second, err := getOrCreateACMEBridgeSecret(dir)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Error("secret must be stable across calls — Traefik holds a copy in its environment")
	}
}

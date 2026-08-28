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

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
)

func customDNS(provider string, creds map[string]string) config.TLSDNSSettings {
	return config.TLSDNSSettings{Provider: provider, Credentials: creds}
}

// The provider id and every credential NAME are interpolated verbatim into
// Traefik's static config and compose environment, so validation here is a real
// gate: a value carrying a newline or an "=" would corrupt the YAML or define a
// different variable than the operator meant.
func TestValidateCustomDNS(t *testing.T) {
	good := map[string]string{"CF_DNS_API_TOKEN": "secret"}
	for _, tc := range []struct {
		name    string
		dns     config.TLSDNSSettings
		wantErr bool
	}{
		{"cloudflare", customDNS("cloudflare", good), false},
		{"route53 with two creds", customDNS("route53", map[string]string{
			"AWS_ACCESS_KEY_ID": "k", "AWS_SECRET_ACCESS_KEY": "s"}), false},
		{"underscored provider", customDNS("gcloud_dns", good), false},
		{"no provider", customDNS("", good), true},
		{"provider with space", customDNS("cloud flare", good), true},
		{"provider uppercase", customDNS("Cloudflare", good), true},
		{"provider with newline", customDNS("cloudflare\nfoo: bar", good), true},
		{"no credentials", customDNS("cloudflare", nil), true},
		{"lowercase credential name", customDNS("cloudflare", map[string]string{"cf_token": "x"}), true},
		{"credential name with equals", customDNS("cloudflare", map[string]string{"CF=X": "x"}), true},
		{"empty credential value", customDNS("cloudflare", map[string]string{"CF_DNS_API_TOKEN": ""}), true},
		{"credential value with newline", customDNS("cloudflare", map[string]string{"CF_DNS_API_TOKEN": "a\nb"}), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := validateCustomDNS(tc.dns)
			if (err != nil) != tc.wantErr {
				t.Errorf("validateCustomDNS(%+v) error = %v, wantErr = %v", tc.dns, err, tc.wantErr)
			}
		})
	}
}

// TestCustomDNSStaticConfigUsesTheOperatorsProvider: the resolver must name the
// operator's provider, must NOT carry the AOC bridge's httpreq provider, and must
// keep lego's propagation pre-flight — that check is disabled for the bridge only
// because the bridge already waits for the record to be live and because a NAT'd
// server often cannot reach arbitrary nameservers on :53. Against a real provider
// API it is a correct check and disabling it would race the CA.
func TestCustomDNSStaticConfigUsesTheOperatorsProvider(t *testing.T) {
	cfg := renderTraefikStaticConfigOpts(traefikStaticOptions{
		ACMEEmail:    "ops@example.com",
		DNSChallenge: true,
		Mode:         TLSModeCustomDNS,
		DNSProvider:  "cloudflare",
	})
	if !strings.Contains(cfg, "provider: cloudflare") {
		t.Errorf("static config does not use the configured provider:\n%s", cfg)
	}
	if strings.Contains(cfg, "httpreq") {
		t.Errorf("static config still points lego at the AOC bridge:\n%s", cfg)
	}
	if strings.Contains(cfg, "disablePropagationCheck") {
		t.Errorf("propagation check disabled for a real provider API:\n%s", cfg)
	}
	// Same resolver name and storage as aoc-dns: that is what makes switching
	// between the two modes need no route migration and no re-issuance.
	if !strings.Contains(cfg, dnsCertResolverName+":") {
		t.Errorf("resolver name changed; a mode switch would then orphan every route:\n%s", cfg)
	}
	if !strings.Contains(cfg, "storage: /acme/acme-dns.json") {
		t.Errorf("ACME storage changed; existing certificates would be re-issued:\n%s", cfg)
	}
	// The HTTP-01 resolver stays for hosts outside the wildcard, as on aoc-dns.
	if !strings.Contains(cfg, "letsencrypt:") {
		t.Errorf("lost the HTTP-01 resolver:\n%s", cfg)
	}
}

// A custom-dns server with no domain assigned yet must not render a resolver with
// an empty provider — that fails at certificate time with an error pointing
// nowhere near the cause.
func TestCustomDNSStaticConfigWithoutDomain(t *testing.T) {
	cfg := renderTraefikStaticConfigOpts(traefikStaticOptions{
		ACMEEmail:    "ops@example.com",
		DNSChallenge: false,
		Mode:         TLSModeCustomDNS,
	})
	if strings.Contains(cfg, "dnsChallenge") {
		t.Errorf("rendered a DNS-01 resolver with no domain:\n%s", cfg)
	}
}

func TestSetTLSModeCustomDNSValidatesBeforePersisting(t *testing.T) {
	writeTLSModeConfig(t, "")
	s := &Server{}

	// No provider stated and none stored: refuse, and leave the mode alone. A
	// server parked in custom-dns with no provider cannot issue or renew anything.
	rec := httptest.NewRecorder()
	s.handleIngressTLS(rec, httptest.NewRequest(http.MethodPost, "/ingress/tls",
		strings.NewReader(`{"mode":"custom-dns"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 (body %q)", rec.Code, rec.Body.String())
	}
	if got := currentTLSMode(); got != TLSModeAOCDNS {
		t.Errorf("mode = %q after a rejected switch, want it unchanged", got)
	}

	// A provider on a mode that has no use for one is a mistake worth reporting
	// rather than silently storing.
	rec = httptest.NewRecorder()
	s.handleIngressTLS(rec, httptest.NewRequest(http.MethodPost, "/ingress/tls",
		strings.NewReader(`{"mode":"manual","dns_provider":"cloudflare","dns_credentials":{"CF_DNS_API_TOKEN":"x"}}`)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 (body %q)", rec.Code, rec.Body.String())
	}
}

// TestTLSStatusNeverLeaksCredentialValues: this payload is printed to a terminal
// and can end up in logs and support tickets, so it carries credential NAMES only.
func TestTLSStatusNeverLeaksCredentialValues(t *testing.T) {
	writeTLSModeConfig(t, "")
	const secret = "super-secret-token-value"
	cfg := config.NewAutomationServerConfig()
	if err := cfg.SetTLSDNS(customDNS("cloudflare", map[string]string{"CF_DNS_API_TOKEN": secret})); err != nil {
		t.Fatal(err)
	}
	if err := cfg.SetTLSMode(string(TLSModeCustomDNS)); err != nil {
		t.Fatal(err)
	}

	s := &Server{}
	rec := httptest.NewRecorder()
	s.handleIngressTLS(rec, httptest.NewRequest(http.MethodGet, "/ingress/tls", nil))
	body := rec.Body.String()
	if strings.Contains(body, secret) {
		t.Fatalf("status leaked a credential value:\n%s", body)
	}

	var status IngressTLSStatus
	if err := json.Unmarshal([]byte(body), &status); err != nil {
		t.Fatal(err)
	}
	if status.DNSProvider != "cloudflare" {
		t.Errorf("provider = %q, want cloudflare", status.DNSProvider)
	}
	if len(status.DNSCredentialNames) != 1 || status.DNSCredentialNames[0] != "CF_DNS_API_TOKEN" {
		t.Errorf("credential names = %v, want [CF_DNS_API_TOKEN]", status.DNSCredentialNames)
	}
	if len(status.Warnings) != 0 {
		t.Errorf("a valid custom-dns config should not warn: %v", status.Warnings)
	}
}

func TestParseCredentialFlag(t *testing.T) {
	name, value, err := ParseCredentialFlag("CF_DNS_API_TOKEN=abc=def")
	if err != nil {
		t.Fatal(err)
	}
	if name != "CF_DNS_API_TOKEN" {
		t.Errorf("name = %q", name)
	}
	// Only the FIRST "=" separates: base64-ish secrets contain them.
	if value != "abc=def" {
		t.Errorf("value = %q, want abc=def", value)
	}
	for _, bad := range []string{"CF_DNS_API_TOKEN", "=value", "NAME=", ""} {
		if _, _, err := ParseCredentialFlag(bad); err == nil {
			t.Errorf("ParseCredentialFlag(%q) should have failed", bad)
		}
	}
}

// Switching between the two DNS-01 backends must not touch the route table: same
// resolver, same storage. "0 routes reconciled" is the correct outcome and the
// note explains it so it doesn't read as a switch that failed.
func TestSwitchBetweenACMEModesSaysNothingIsReIssued(t *testing.T) {
	notes := strings.Join(tlsModeSwitchNotes(TLSModeAOCDNS, TLSModeCustomDNS,
		IngressTLSStatus{Domain: "acme-prod.bswn.io"}), " ")
	if !strings.Contains(notes, "same CA") {
		t.Errorf("notes should explain nothing is re-issued: %q", notes)
	}
}

// TestCustomDNSIgnoresWhoManagesTheDomain is the whole point of the mode, and the
// one place the two DNS-01 backends diverge. aoc-dns cannot obtain a wildcard for
// a domain the AOC does not manage — its bridge writes into the AOC's own hosted
// zone. custom-dns challenges against a zone the OPERATOR runs, so a domain the
// AOC has never heard of is exactly the case it exists for, and gating it on
// dns_managed would disable it for every customer it is meant to serve.
func TestCustomDNSIgnoresWhoManagesTheDomain(t *testing.T) {
	writeTLSModeConfigWithDNSManaged(t, string(TLSModeCustomDNS), "false")
	if !canIssueWildcard(TLSModeCustomDNS) {
		t.Error("custom-dns must be able to claim the wildcard on a domain the AOC does not manage")
	}
	resolver, domains := certResolverForHostname("bailey.acme-prod.bswn.io")
	if resolver != dnsCertResolverName {
		t.Errorf("resolver = %q, want %q", resolver, dnsCertResolverName)
	}
	if len(domains) != 1 {
		t.Errorf("tls.domains = %v, want the shared wildcard", domains)
	}

	// aoc-dns on the very same config cannot.
	if canIssueWildcard(TLSModeAOCDNS) {
		t.Error("aoc-dns must not claim a wildcard it cannot have")
	}
}

// writeTLSModeConfigWithDNSManaged lays down a config with both an explicit mode
// and an explicit dns_managed.
func writeTLSModeConfigWithDNSManaged(t *testing.T, mode, dnsManaged string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("SUDO_USER", "")
	dir := filepath.Join(home, ".config", "bitswan")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	toml := fmt.Sprintf("tls_mode = %q\n[aoc]\naoc_url = \"https://aoc.example.com\"\n"+
		"automation_server_id = \"test-server\"\naccess_token = \"test-token\"\n"+
		"domain = \"acme-prod.bswn.io\"\ndns_managed = %s\n", mode, dnsManaged)
	if err := os.WriteFile(filepath.Join(dir, "automation_server_config.toml"), []byte(toml), 0644); err != nil {
		t.Fatal(err)
	}
}

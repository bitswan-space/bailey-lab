package config

import (
	"os"
	"path/filepath"
	"testing"
)

// ProtectedHostnameDomain's resolution order is load-bearing in two directions
// and had no test of its own. An AOC-registered server carries its domain in
// [aoc].domain and nothing else; protected_domain is the operator override for
// serving protected ingress on a different zone. Reversing the two, or dropping
// the fallback, renames every protected hostname on every registered server.
func TestProtectedHostnameDomainResolutionOrder(t *testing.T) {
	for _, tc := range []struct {
		name      string
		protected string
		aoc       string
		want      string
	}{
		{"registered server: the AOC domain, and only that", "", "acme-prod.bswn.io", "acme-prod.bswn.io"},
		{"operator override wins over the AOC domain", "apps.acme.com", "acme-prod.bswn.io", "apps.acme.com"},
		{"override with no AOC domain at all", "apps.acme.com", "", "apps.acme.com"},
		{"protected ingress not configured yet", "", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := &Config{ProtectedDomain: tc.protected}
			c.AutomationOperationsCenter.Domain = tc.aoc
			if got := c.ProtectedHostnameDomain(); got != tc.want {
				t.Errorf("ProtectedHostnameDomain() = %q, want %q", got, tc.want)
			}
		})
	}
}

// The e2e bring-up writes the daemon's config the way registration does — the
// domain under [aoc], no credentials — so that the suite runs on the branch
// real deployments take rather than on the operator override. This pins the
// file shape it produces: it has to parse, and it has to resolve.
func TestRegisteredServerConfigShapeResolvesItsDomain(t *testing.T) {
	dir := t.TempDir()
	const body = `active_workspace = "ws"

[aoc]
domain = "bs-e2e.localhost"
  aoc_url = ""
  automation_server_id = ""
  access_token = ""

[local_server]
  token = "abc"
`
	path := filepath.Join(dir, "automation_server_config.toml")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	cfg, err := NewAutomationServerConfigWithDir(dir).LoadConfig()
	if err != nil {
		t.Fatalf("the config bring-up writes does not parse: %v", err)
	}
	if got := cfg.ProtectedHostnameDomain(); got != "bs-e2e.localhost" {
		t.Errorf("ProtectedHostnameDomain() = %q, want bs-e2e.localhost", got)
	}
	if cfg.ProtectedDomain != "" {
		t.Errorf("protected_domain = %q — the override is set, so the AOC branch is not the one under test", cfg.ProtectedDomain)
	}
	// No token means every AOC-facing path stays inert: the DNS-01 wildcard
	// certificate (getWildcardCertDomain), the relay tunnel, the TLS self-check.
	if cfg.AutomationOperationsCenter.AccessToken != "" {
		t.Error("access_token is set — the stack would start dialling an AOC that does not exist")
	}
}

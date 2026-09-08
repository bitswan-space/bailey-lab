package daemon

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeRelayConfigDomain lays down a registration whose domain is `domain` (or
// no registration at all when it is empty).
func writeRelayConfigDomain(t *testing.T, domain string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("SUDO_USER", "")
	dir := filepath.Join(home, ".config", "bitswan")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	toml := "[aoc]\n"
	if domain != "" {
		toml += fmt.Sprintf(`aoc_url = "https://aoc.example.com"
automation_server_id = "test-server"
access_token = "test-token"
domain = %q
`, domain)
	}
	if err := os.WriteFile(filepath.Join(dir, "automation_server_config.toml"), []byte(toml), 0644); err != nil {
		t.Fatal(err)
	}
}

// A published endpoint is one label under this server's own domain, so the
// wildcard certificate it already holds covers it and its existing DNS already
// resolves it. Nothing about publishing should reach for the AOC's namespace,
// a second certificate, or a relay.
func TestDerivePublicHostSitsUnderTheServersOwnDomain(t *testing.T) {
	writeRelayConfigDomain(t, "acme-prod.bswn.io")

	got, err := derivePublicHost("invoices.acme-prod.bswn.io")
	if err != nil {
		t.Fatalf("derivePublicHost: %v", err)
	}
	if !strings.HasSuffix(got, ".acme-prod.bswn.io") {
		t.Errorf("published host %q is not under the server's domain", got)
	}
	if strings.Count(got, ".") != 3 {
		t.Errorf("published host %q is not one label down, so *.<domain> would not cover it", got)
	}
	if !strings.HasPrefix(got, "public-invoices-") {
		t.Errorf("published host %q should say it is public and name the endpoint", got)
	}
}

func TestDerivePublicHostIsStableAndCollisionFree(t *testing.T) {
	writeRelayConfigDomain(t, "acme-prod.bswn.io")

	first, err := derivePublicHost("app.acme-prod.bswn.io")
	if err != nil {
		t.Fatal(err)
	}
	again, err := derivePublicHost("app.acme-prod.bswn.io")
	if err != nil {
		t.Fatal(err)
	}
	if first != again {
		t.Errorf("the same endpoint published at two names: %q then %q", first, again)
	}
	other, err := derivePublicHost("app.other-prod.bswn.io")
	if err != nil {
		t.Fatal(err)
	}
	if other == first {
		t.Errorf("two endpoints share the published host %q", first)
	}
}

func TestDerivePublicHostRefusesBeforeRegistration(t *testing.T) {
	writeRelayConfigDomain(t, "")

	if _, err := derivePublicHost("invoices.acme-prod.bswn.io"); err == nil {
		t.Error("a server with no domain published a host anyway")
	}
}

// A DNS label is 63 characters. The published label is "public-", the
// endpoint's name, a separator and a digest, so the name part is bounded — and
// the bound is asserted here rather than trusted, because the failure mode is a
// record Route53 (or any resolver) rejects.
func TestDerivePublicHostFitsInADNSLabel(t *testing.T) {
	writeRelayConfigDomain(t, "acme-prod.bswn.io")

	long := strings.Repeat("harmonum-automations-frontend-production", 3) + ".acme-prod.bswn.io"
	got, err := derivePublicHost(long)
	if err != nil {
		t.Fatalf("derivePublicHost: %v", err)
	}
	label := strings.SplitN(got, ".", 2)[0]
	if len(label) > 63 {
		t.Errorf("label %q is %d characters; a DNS label allows 63", label, len(label))
	}
	if strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
		t.Errorf("label %q starts or ends with a hyphen, which DNS does not allow", label)
	}
	t.Logf("longest label is %d characters: %s", len(label), label)
}

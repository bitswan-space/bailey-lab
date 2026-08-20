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

// writeDNSManagedConfig lays down a registration whose dns_managed is present
// and true, present and false, or absent entirely — the three states that have to
// behave differently.
func writeDNSManagedConfig(t *testing.T, dnsManaged string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("SUDO_USER", "")

	dir := filepath.Join(home, ".config", "bitswan")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	line := ""
	if dnsManaged != "" {
		line = fmt.Sprintf("dns_managed = %s\n", dnsManaged)
	}
	toml := `[aoc]
aoc_url = "https://aoc.example.com"
automation_server_id = "test-server"
access_token = "test-token"
domain = "acme-prod.bswn.io"
` + line
	if err := os.WriteFile(filepath.Join(dir, "automation_server_config.toml"), []byte(toml), 0644); err != nil {
		t.Fatal(err)
	}
}

// TestAOCManagesDNSDefaultsToTrue is the upgrade guard. Every server registered
// before dns_managed was recorded has no value for it, and every one of them is
// currently using the AOC wildcard. Reading "absent" as "not managed" would take
// them all off it on the next daemon boot.
func TestAOCManagesDNSDefaultsToTrue(t *testing.T) {
	writeDNSManagedConfig(t, "") // absent
	if !aocManagesDNS() {
		t.Error("an absent dns_managed must be read as managed")
	}
	if !aocDNSUsable(TLSModeAOCDNS) {
		t.Error("aoc-dns must remain usable when the AOC never reported the field")
	}

	// No config at all (an unregistered server) is the same answer.
	t.Setenv("HOME", t.TempDir())
	if !aocManagesDNS() {
		t.Error("with no config, dns_managed must be read as managed")
	}
}

func TestAOCManagesDNSHonoursAnExplicitValue(t *testing.T) {
	writeDNSManagedConfig(t, "true")
	if !aocManagesDNS() {
		t.Error("explicit true read as false")
	}
	writeDNSManagedConfig(t, "false")
	if aocManagesDNS() {
		t.Error("explicit false read as true")
	}
	if aocDNSUsable(TLSModeAOCDNS) {
		t.Error("aoc-dns cannot be usable on a domain the AOC does not manage")
	}
}

// TestUnmanagedDomainFallsBackToHTTP01 is the behaviour dns_managed exists to
// select — the AOC serializer documents the flag as exactly this choice. Asking
// for the wildcard on an unmanaged domain produces a DNS-01 challenge the bridge
// rejects (502) on every attempt; a per-host HTTP-01 certificate is obtainable on
// a publicly reachable server.
func TestUnmanagedDomainFallsBackToHTTP01(t *testing.T) {
	const host = "bailey.acme-prod.bswn.io"

	writeDNSManagedConfig(t, "true")
	resolver, domains := certResolverForHostname(host)
	if resolver != dnsCertResolverName || len(domains) != 1 {
		t.Errorf("managed: resolver = %q, domains = %v; want the shared wildcard", resolver, domains)
	}

	writeDNSManagedConfig(t, "false")
	resolver, domains = certResolverForHostname(host)
	if resolver != httpCertResolverName {
		t.Errorf("unmanaged: resolver = %q, want %q", resolver, httpCertResolverName)
	}
	if domains != nil {
		t.Errorf("unmanaged: tls.domains = %v, want none — there is no wildcard to ask for", domains)
	}

	// Manual mode still asks for nothing at all: dns_managed is irrelevant when no
	// CA is contacted.
	writeDNSManagedConfigMode(t, "false", string(TLSModeManual))
	if resolver, _ := certResolverForHostname(host); resolver != "" {
		t.Errorf("manual: resolver = %q, want none", resolver)
	}
}

// writeDNSManagedConfigMode is writeDNSManagedConfig plus an explicit tls_mode.
func writeDNSManagedConfigMode(t *testing.T, dnsManaged, mode string) {
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

// TestSelectingAOCDNSOnAnUnmanagedDomainIsRefused: storing the mode would leave
// the server where every order fails, and the operator would meet that as an ACME
// error minutes later instead of as an answer to what they just asked.
func TestSelectingAOCDNSOnAnUnmanagedDomainIsRefused(t *testing.T) {
	writeDNSManagedConfigMode(t, "false", string(TLSModeManual))
	s := &Server{}
	rec := httptest.NewRecorder()
	s.handleIngressTLS(rec, httptest.NewRequest(http.MethodPost, "/ingress/tls",
		strings.NewReader(`{"mode":"aoc-dns"}`)))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %q)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "does not manage DNS") {
		t.Errorf("the refusal should name the cause: %q", rec.Body.String())
	}
	if got := currentTLSMode(); got != TLSModeManual {
		t.Errorf("mode changed to %q on a refused request", got)
	}
}

// The status surface has to report this, because nothing else on the server
// mentions it: a wildcard that never arrives looks like a slow CA.
func TestTLSStatusReportsUnmanagedDNS(t *testing.T) {
	writeDNSManagedConfig(t, "false")
	s := &Server{}
	rec := httptest.NewRecorder()
	s.handleIngressTLS(rec, httptest.NewRequest(http.MethodGet, "/ingress/tls", nil))

	var status IngressTLSStatus
	if err := json.NewDecoder(rec.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	if status.DNSManagedByAOC {
		t.Error("status claims the AOC manages DNS when it does not")
	}
	joined := strings.Join(status.Warnings, " ")
	if !strings.Contains(joined, "cannot obtain a wildcard") {
		t.Errorf("expected a warning about the unobtainable wildcard, got %v", status.Warnings)
	}
	if !strings.Contains(joined, string(TLSModeManual)) {
		t.Errorf("the warning should name a mode that can issue here, got %v", status.Warnings)
	}

	// Managed: no such warning. Decode into a FRESH struct — the managed response
	// omits "warnings" entirely, and unmarshalling into the previous value would
	// leave its warnings in place and quietly pass this assertion.
	writeDNSManagedConfig(t, "true")
	rec = httptest.NewRecorder()
	s.handleIngressTLS(rec, httptest.NewRequest(http.MethodGet, "/ingress/tls", nil))
	var managed IngressTLSStatus
	if err := json.NewDecoder(rec.Body).Decode(&managed); err != nil {
		t.Fatal(err)
	}
	if !managed.DNSManagedByAOC {
		t.Error("status should report the AOC manages DNS")
	}
	for _, w := range managed.Warnings {
		if strings.Contains(w, "cannot obtain a wildcard") {
			t.Errorf("spurious unmanaged-DNS warning on a managed domain: %q", w)
		}
	}
}

// TestReconcileTakesUnmanagedRoutesOffTheWildcard: routes registered while the
// domain looked managed keep asking for a wildcard that cannot be issued, so the
// reconcile has to move them too — the same reason the reconcile exists at all.
func TestReconcileTakesUnmanagedRoutesOffTheWildcard(t *testing.T) {
	writeDNSManagedConfig(t, "false")
	path := seedRouteState(t, dnsCertResolverName, "bailey.acme-prod.bswn.io")

	reconcileTLSMode()

	if got := resolversInState(t, path)["bailey_acme-prod_bswn_io"]; got != httpCertResolverName {
		t.Errorf("resolver = %q, want %q", got, httpCertResolverName)
	}
}

// The registration payload has to carry the pointer as three states, or the
// upgrade guard above is defeated at the boundary.
func TestAOCConfigPersistsDNSManagedTriState(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value *bool
	}{
		{"absent", nil},
		{"true", boolPtr(true)},
		{"false", boolPtr(false)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			writeDNSManagedConfig(t, "")
			body, _ := json.Marshal(AOCConfigRequest{
				AOCUrl:             "https://aoc.example.com",
				AutomationServerId: "test-server",
				AccessToken:        "tok",
				Domain:             "acme-prod.bswn.io",
				DNSManaged:         tc.value,
				Force:              true,
			})
			s := &Server{}
			rec := httptest.NewRecorder()
			s.handleAOCConfig(rec, httptest.NewRequest(http.MethodPost, "/aoc/config",
				strings.NewReader(string(body))))
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d (body %q)", rec.Code, rec.Body.String())
			}

			settings, err := config.NewAutomationServerConfig().GetAutomationOperationsCenterSettings()
			if err != nil {
				t.Fatal(err)
			}
			switch {
			case tc.value == nil && settings.DNSManaged != nil:
				t.Errorf("absent became %v", *settings.DNSManaged)
			case tc.value != nil && settings.DNSManaged == nil:
				t.Errorf("explicit %v became absent", *tc.value)
			case tc.value != nil && *settings.DNSManaged != *tc.value:
				t.Errorf("stored %v, want %v", *settings.DNSManaged, *tc.value)
			}
		})
	}
}

func boolPtr(b bool) *bool { return &b }

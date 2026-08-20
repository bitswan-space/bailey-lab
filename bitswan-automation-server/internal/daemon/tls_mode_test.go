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

// writeTLSModeConfig lays down a daemon config with a domain and (optionally) a
// tls_mode, in a temp HOME.
func writeTLSModeConfig(t *testing.T, mode string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("SUDO_USER", "")

	dir := filepath.Join(home, ".config", "bitswan")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	modeLine := ""
	if mode != "" {
		modeLine = fmt.Sprintf("tls_mode = %q\n", mode)
	}
	toml := modeLine + `[aoc]
aoc_url = "https://aoc.example.com"
automation_server_id = "test-server"
access_token = "test-token"
domain = "acme-prod.bswn.io"
`
	if err := os.WriteFile(filepath.Join(dir, "automation_server_config.toml"), []byte(toml), 0644); err != nil {
		t.Fatal(err)
	}
}

// stubIngressReconfigure replaces the reconfigure step for a test. Mandatory for
// anything that SUCCEEDS in setting a mode: the real call would `docker compose
// up` the fixed bitswan-traefik project against the fixed `bitswan` volume, i.e.
// recreate the ingress of whatever Bailey is installed on the machine running the
// test. See initTraefikIngressFn.
func stubIngressReconfigure(t *testing.T) *int {
	t.Helper()
	calls := 0
	original := initTraefikIngressFn
	initTraefikIngressFn = func(bool) (bool, error) {
		calls++
		return true, nil
	}
	t.Cleanup(func() { initTraefikIngressFn = original })
	return &calls
}

// writeTLSModeConfigKeepingHome rewrites the config in the CURRENT temp HOME, so a
// test can change mode without discarding the route state it already seeded.
func writeTLSModeConfigKeepingHome(t *testing.T, mode string) {
	t.Helper()
	dir := filepath.Join(os.Getenv("HOME"), ".config", "bitswan")
	modeLine := ""
	if mode != "" {
		modeLine = fmt.Sprintf("tls_mode = %q\n", mode)
	}
	toml := modeLine + `[aoc]
aoc_url = "https://aoc.example.com"
automation_server_id = "test-server"
access_token = "test-token"
domain = "acme-prod.bswn.io"
`
	if err := os.WriteFile(filepath.Join(dir, "automation_server_config.toml"), []byte(toml), 0644); err != nil {
		t.Fatal(err)
	}
}

// A server that has never heard of tls_mode must keep behaving exactly as it did.
func TestCurrentTLSModeDefaultsToAOCDNS(t *testing.T) {
	writeTLSModeConfig(t, "")
	if got := currentTLSMode(); got != TLSModeAOCDNS {
		t.Errorf("currentTLSMode() = %q, want %q", got, TLSModeAOCDNS)
	}
	// And an unreadable/absent config is the same answer, not a downgrade.
	t.Setenv("HOME", t.TempDir())
	if got := currentTLSMode(); got != TLSModeAOCDNS {
		t.Errorf("with no config, currentTLSMode() = %q, want %q", got, TLSModeAOCDNS)
	}
}

// A stored mode we don't recognise must not silently turn TLS into something the
// operator didn't ask for; it falls back to the CA-backed default.
func TestCurrentTLSModeRejectsUnknownStoredValue(t *testing.T) {
	writeTLSModeConfig(t, "letsdontencrypt")
	if got := currentTLSMode(); got != TLSModeAOCDNS {
		t.Errorf("currentTLSMode() = %q, want the default %q", got, TLSModeAOCDNS)
	}
}

func TestParseTLSMode(t *testing.T) {
	for _, in := range []string{"aoc-dns", "AOC-DNS", " manual ", "manual"} {
		if _, err := ParseTLSMode(in); err != nil {
			t.Errorf("ParseTLSMode(%q) errored: %v", in, err)
		}
	}
	for _, in := range []string{"", "http-01", "custom-dns", "letsencrypt"} {
		if _, err := ParseTLSMode(in); err == nil {
			t.Errorf("ParseTLSMode(%q) should have been rejected", in)
		}
	}
}

// The single decision point: in a mode that contacts no CA, no route asks for an
// ACME certificate — including the hostnames the daemon registers for itself.
func TestCertResolverForHostnameHonoursTheMode(t *testing.T) {
	writeTLSModeConfig(t, "")
	resolver, domains := certResolverForHostname("bailey.acme-prod.bswn.io")
	if resolver != dnsCertResolverName {
		t.Errorf("aoc-dns: resolver = %q, want %q", resolver, dnsCertResolverName)
	}
	if len(domains) != 1 {
		t.Errorf("aoc-dns: want the shared wildcard tls.domains, got %v", domains)
	}

	writeTLSModeConfig(t, string(TLSModeManual))
	resolver, domains = certResolverForHostname("bailey.acme-prod.bswn.io")
	if resolver != "" || domains != nil {
		t.Errorf("manual: resolver = %q, domains = %v; want no ACME at all", resolver, domains)
	}
	// Hosts outside the wildcard used to fall back to HTTP-01; in manual mode they
	// must not, since HTTP-01 would ask a CA too.
	if resolver, _ := certResolverForHostname("app.elsewhere.example.com"); resolver != "" {
		t.Errorf("manual: off-domain host got resolver %q, want none", resolver)
	}
}

// TestStaticConfigForModeHasNoResolversWhenNoCAIsUsed: leaving the HTTP-01
// resolver defined in a mode that cannot answer a challenge means any route that
// still names it starts an ACME order that can never complete, and Traefik retries
// it forever.
func TestStaticConfigForModeHasNoResolversWhenNoCAIsUsed(t *testing.T) {
	manual := renderTraefikStaticConfigForMode("ops@example.com", true, TLSModeManual)
	for _, forbidden := range []string{"certificatesResolvers", "acme", "letsencrypt", "httpChallenge", "dnsChallenge"} {
		if strings.Contains(manual, forbidden) {
			t.Errorf("manual static config mentions %q:\n%s", forbidden, manual)
		}
	}
	// The parts that are not about certificates must survive.
	for _, required := range []string{`address: ":80"`, `address: ":443"`, "providers:", "watch: true"} {
		if !strings.Contains(manual, required) {
			t.Errorf("manual static config lost %q:\n%s", required, manual)
		}
	}
	// The API/dashboard must stay off in every mode. Match a top-level YAML key,
	// not the word: the config explains in prose why the API is disabled.
	for _, line := range strings.Split(manual, "\n") {
		if line == "api:" || strings.HasPrefix(line, "api:") {
			t.Errorf("manual static config enables the API/dashboard:\n%s", manual)
		}
	}
}

// TestStaticConfigDefaultModeIsUnchanged is the upgrade guard: the daemon compares
// the rendered static config against the file on disk and recreates Traefik on any
// difference, so introducing the mode parameter must not alter a single byte of
// what an aoc-dns server renders.
func TestStaticConfigDefaultModeIsUnchanged(t *testing.T) {
	for _, dnsChallenge := range []bool{false, true} {
		legacy := renderTraefikStaticConfig("ops@example.com", dnsChallenge)
		viaMode := renderTraefikStaticConfigForMode("ops@example.com", dnsChallenge, TLSModeAOCDNS)
		if legacy != viaMode {
			t.Errorf("dnsChallenge=%v: mode-aware render differs from the legacy one:\n--- legacy\n%s\n--- mode\n%s",
				dnsChallenge, legacy, viaMode)
		}
		// Spot-check the shape too, so a change to BOTH functions can't pass.
		if !strings.Contains(viaMode, "certificatesResolvers:") ||
			!strings.Contains(viaMode, "storage: /acme/acme.json") {
			t.Errorf("dnsChallenge=%v: aoc-dns render lost its ACME resolver:\n%s", dnsChallenge, viaMode)
		}
		if dnsChallenge && !strings.Contains(viaMode, "provider: httpreq") {
			t.Errorf("aoc-dns with DNS-01 lost the httpreq provider:\n%s", viaMode)
		}
	}
}

func TestIngressTLSStatusEndpoint(t *testing.T) {
	writeTLSModeConfig(t, string(TLSModeManual))
	s := &Server{}

	rec := httptest.NewRecorder()
	s.handleIngressTLS(rec, httptest.NewRequest(http.MethodGet, "/ingress/tls", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var status IngressTLSStatus
	if err := json.NewDecoder(rec.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	if status.Mode != string(TLSModeManual) {
		t.Errorf("mode = %q, want %q", status.Mode, TLSModeManual)
	}
	if status.Domain != "acme-prod.bswn.io" {
		t.Errorf("domain = %q", status.Domain)
	}
	// Manual mode with nothing installed is a server whose TLS is broken. Saying
	// so is the whole point of the warning list.
	if len(status.Warnings) == 0 {
		t.Error("manual mode with no installed certificate should warn")
	}
}

func TestIngressTLSModeRejectsUnknownMode(t *testing.T) {
	writeTLSModeConfig(t, "")
	calls := stubIngressReconfigure(t)
	s := &Server{}
	rec := httptest.NewRecorder()
	body := strings.NewReader(`{"mode":"self-signed-and-hope"}`)
	s.handleIngressTLS(rec, httptest.NewRequest(http.MethodPost, "/ingress/tls", body))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 (body %q)", rec.Code, rec.Body.String())
	}
	// And the stored mode is untouched, and nothing was reconfigured.
	if got := currentTLSMode(); got != TLSModeAOCDNS {
		t.Errorf("mode changed to %q on a rejected request", got)
	}
	if *calls != 0 {
		t.Errorf("a rejected mode reconfigured the ingress (%d calls)", *calls)
	}
}

func TestTLSModeSwitchNotes(t *testing.T) {
	notes := tlsModeSwitchNotes(TLSModeAOCDNS, TLSModeManual, IngressTLSStatus{Domain: "acme-prod.bswn.io"})
	joined := strings.Join(notes, " ")
	if !strings.Contains(joined, "will not be") {
		t.Errorf("a switch off ACME must say existing certificates stop being renewed: %v", notes)
	}
	notes = tlsModeSwitchNotes(TLSModeManual, TLSModeManual, IngressTLSStatus{})
	if len(notes) == 0 || !strings.Contains(notes[0], "already") {
		t.Errorf("a no-op switch should say so: %v", notes)
	}
	notes = tlsModeSwitchNotes(TLSModeAOCDNS, TLSModeManual, IngressTLSStatus{})
	if !strings.Contains(strings.Join(notes, " "), "no domain") {
		t.Errorf("a switch with no domain should say nothing was reconciled: %v", notes)
	}
}

// seedRouteState writes a global Traefik rest-state.json under the current HOME
// holding one https route per hostname, each on the given resolver.
func seedRouteState(t *testing.T, resolver string, hosts ...string) string {
	t.Helper()
	dir := filepath.Join(os.Getenv("HOME"), ".config", "bitswan", "traefik")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	routers := map[string]interface{}{}
	for _, h := range hosts {
		routers[strings.ReplaceAll(h, ".", "_")] = map[string]interface{}{
			"rule":    fmt.Sprintf("Host(`%s`)", h),
			"service": "svc",
			"tls":     map[string]interface{}{"certResolver": resolver},
		}
	}
	state := map[string]interface{}{
		"http": map[string]interface{}{"routers": routers, "services": map[string]interface{}{}},
	}
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "rest-state.json")
	if err := os.WriteFile(path, data, 0644); err != nil {
		t.Fatal(err)
	}
	return path
}

func resolversInState(t *testing.T, path string) map[string]string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var state struct {
		HTTP struct {
			Routers map[string]struct {
				Rule string `json:"rule"`
				TLS  *struct {
					CertResolver string `json:"certResolver"`
				} `json:"tls"`
			} `json:"routers"`
		} `json:"http"`
	}
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for id, r := range state.HTTP.Routers {
		if r.TLS == nil {
			out[id] = "<no tls>"
			continue
		}
		out[id] = r.TLS.CertResolver
	}
	return out
}

// TestReconcileTLSModeMovesLiveRoutes is the "switch mode on a server that is
// already serving traffic" story. Without this, a switch would only apply to
// routes registered afterwards: every existing router keeps the resolver it was
// created with, so a server moved to manual mode would go on asking a CA for
// certificates it can no longer obtain.
func TestReconcileTLSModeMovesLiveRoutes(t *testing.T) {
	writeTLSModeConfig(t, string(TLSModeManual))
	path := seedRouteState(t, dnsCertResolverName,
		"bailey.acme-prod.bswn.io", "bailey--inner.acme-prod.bswn.io")

	reconcileTLSMode()

	for id, resolver := range resolversInState(t, path) {
		if resolver != "" {
			t.Errorf("%s: resolver = %q after switching to manual, want none", id, resolver)
		}
	}

	// And back: the same routes return to the wildcard resolver.
	writeTLSModeConfigKeepingHome(t, string(TLSModeAOCDNS))
	reconcileTLSMode()
	for id, resolver := range resolversInState(t, path) {
		if resolver != dnsCertResolverName {
			t.Errorf("%s: resolver = %q after switching back, want %q", id, resolver, dnsCertResolverName)
		}
	}
}

// TestReconcileTLSModeWithoutDomainIsANoop: before the AOC assigns a domain there
// is no wildcard to reconcile against, and touching routes on a guess would be
// worse than doing nothing.
func TestReconcileTLSModeWithoutDomainIsANoop(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("SUDO_USER", "")
	dir := filepath.Join(home, ".config", "bitswan")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	// Registered, but no domain yet.
	toml := "tls_mode = \"manual\"\n[aoc]\naoc_url = \"https://aoc.example.com\"\naccess_token = \"t\"\n"
	if err := os.WriteFile(filepath.Join(dir, "automation_server_config.toml"), []byte(toml), 0644); err != nil {
		t.Fatal(err)
	}
	path := seedRouteState(t, dnsCertResolverName, "bailey.acme-prod.bswn.io")

	reconcileTLSMode()

	if got := resolversInState(t, path)["bailey_acme-prod_bswn_io"]; got != dnsCertResolverName {
		t.Errorf("resolver = %q, want it untouched (%q)", got, dnsCertResolverName)
	}
}

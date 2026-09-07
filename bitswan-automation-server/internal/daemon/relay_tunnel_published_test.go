package daemon

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// seedPublishedEndpoint puts one published host in the cache the gate and the
// tunnel decision both read, and clears it again afterwards.
func seedPublishedEndpoint(t *testing.T) {
	t.Helper()
	publicHostMu.Lock()
	publicHostCache = map[string]string{
		"invoices-ab12cd.public.aoc.example.com": "invoices.acme-prod.bswn.io",
	}
	publicHostMu.Unlock()
	t.Cleanup(func() {
		publicHostMu.Lock()
		publicHostCache = nil
		publicHostMu.Unlock()
	})
}

// noPublishedEndpoints marks the cache loaded and empty, so the tunnel decision
// does not go looking in a database this test has not set up.
func noPublishedEndpoints(t *testing.T) {
	t.Helper()
	publicHostMu.Lock()
	publicHostCache = map[string]string{}
	publicHostMu.Unlock()
	t.Cleanup(func() {
		publicHostMu.Lock()
		publicHostCache = nil
		publicHostMu.Unlock()
	})
}

// writeRelayConfig lays down a registered-server config pointing at aocURL.
// Unlike writePrivateModeConfig it does not leave a second aoc_url in the file,
// which matters here: these tests reach the AOC rather than short-circuiting
// before it.
func writeRelayConfig(t *testing.T, aocURL string, extra string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("SUDO_USER", "")
	configDir := filepath.Join(home, ".config", "bitswan")
	if err := os.MkdirAll(configDir, 0755); err != nil {
		t.Fatal(err)
	}
	toml := fmt.Sprintf(`[aoc]
aoc_url = %q
automation_server_id = "test-server"
access_token = "test-token"
domain = "acme-prod.bswn.io"
%s
`, aocURL, extra)
	if err := os.WriteFile(filepath.Join(configDir, "automation_server_config.toml"),
		[]byte(toml), 0644); err != nil {
		t.Fatal(err)
	}
}

// aocSayingDirect is an AOC that reports this server is reached directly: its
// own domain does not go through the relay.
func aocSayingDirect(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"proxied":           false,
			"relay_addr":        "relay.example.com:8443",
			"relay_fingerprint": "deadbeef",
		})
	}))
}

// A published endpoint's host lives in the AOC's namespace and is served through
// the relay whatever this server's own DNS does, so the tunnel is needed for it
// alone — otherwise the AOC hands out a URL the relay cannot route anywhere.
func TestDirectServerDialsTheRelayForAPublishedEndpoint(t *testing.T) {
	aocSrv := aocSayingDirect(t)
	defer aocSrv.Close()
	writeRelayConfig(t, aocSrv.URL, "")
	seedPublishedEndpoint(t)

	s := &Server{}
	s.startRelayTunnel()

	if !s.relayStarted {
		t.Error("a directly-addressed server with a published endpoint did not dial the relay")
	}
}

// The same server publishing nothing keeps its traffic to itself.
func TestDirectServerPublishingNothingDoesNotDial(t *testing.T) {
	aocSrv := aocSayingDirect(t)
	defer aocSrv.Close()
	writeRelayConfig(t, aocSrv.URL, "")
	noPublishedEndpoints(t)

	s := &Server{}
	s.startRelayTunnel()

	if s.relayStarted {
		t.Error("a directly-addressed server with nothing published dialed the relay")
	}
}

// Publishing must not become a way around the private pin: a VPN-only server
// stays off the relay even with a published endpoint on it.
func TestPrivateServerStillNeverDialsWithAPublishedEndpoint(t *testing.T) {
	aocSrv := aocSayingDirect(t)
	defer aocSrv.Close()
	writeRelayConfig(t, aocSrv.URL, "private = true\nprivate_address = \"10.8.0.7\"")
	seedPublishedEndpoint(t)

	s := &Server{}
	s.startRelayTunnel()

	if s.relayStarted {
		t.Error("a private server dialed the relay because something was published")
	}
}

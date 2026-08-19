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

// writePrivateModeConfig lays down a daemon config in a temp HOME and returns
// the config dir. relayAddr being set is what a proxied server looks like.
func writePrivateModeConfig(t *testing.T, extra string) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	// config.GetRealUserHomeDir consults SUDO_USER first.
	t.Setenv("SUDO_USER", "")

	configDir := filepath.Join(home, ".config", "bitswan")
	if err := os.MkdirAll(configDir, 0755); err != nil {
		t.Fatal(err)
	}
	toml := fmt.Sprintf(`[aoc]
aoc_url = "https://aoc.example.com"
automation_server_id = "test-server"
access_token = "test-token"
domain = "acme-prod.bswn.io"
%s
`, extra)
	if err := os.WriteFile(filepath.Join(configDir, "automation_server_config.toml"),
		[]byte(toml), 0644); err != nil {
		t.Fatal(err)
	}
	return configDir
}

// TestPrivateServerNeverDialsTheRelay is the guarantee the whole private mode
// exists for. Pointing a NAT'd server at the relay is the AOC's uniform default,
// so without a hard local pin a VPN-only deployment would be republished on the
// public internet by the next daemon restart. The pin must hold BEFORE the AOC
// is consulted — so an AOC that says "proxied" (or an AOC that is rolled back to
// a build which doesn't know about private servers) cannot change the outcome.
func TestPrivateServerNeverDialsTheRelay(t *testing.T) {
	relayInfoCalls := 0
	aocSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		relayInfoCalls++
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"proxied":           true,
			"relay_addr":        "relay.example.com:8443",
			"relay_fingerprint": "deadbeef",
		})
	}))
	defer aocSrv.Close()

	writePrivateModeConfig(t, fmt.Sprintf("private = true\nprivate_address = \"10.8.0.7\"\naoc_url = %q", aocSrv.URL))

	s := &Server{}
	s.startRelayTunnel()

	if s.relayStarted {
		t.Error("startRelayTunnel marked the tunnel started on a private server")
	}
	if relayInfoCalls != 0 {
		t.Errorf("asked the AOC for relay info %d times on a private server; the pin must "+
			"short-circuit before the AOC is consulted", relayInfoCalls)
	}
}

// TestRelayStartRefusedOnPrivateServer: the endpoint `register` uses to kick the
// tunnel must refuse rather than silently no-op, so an operator who asks for the
// relay on a private server is told why they can't have it.
func TestRelayStartRefusedOnPrivateServer(t *testing.T) {
	writePrivateModeConfig(t, "private = true\nprivate_address = \"10.8.0.7\"")

	s := &Server{}
	rec := httptest.NewRecorder()
	s.handleRelayStart(rec, httptest.NewRequest(http.MethodPost, "/relay/start", nil))

	if rec.Code != http.StatusConflict {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusConflict)
	}
	if !strings.Contains(rec.Body.String(), "private") {
		t.Errorf("body should explain the refusal, got %q", rec.Body.String())
	}
	if s.relayStarted {
		t.Error("the tunnel was started despite the refusal")
	}
}

// TestAOCConfigRejectsPrivateAndProxied: the two flags are opposite answers to
// the same question. Storing both would make the relay decision depend on which
// check ran first, so the daemon refuses the combination outright.
func TestAOCConfigRejectsPrivateAndProxied(t *testing.T) {
	writePrivateModeConfig(t, "")

	body, _ := json.Marshal(AOCConfigRequest{
		AOCUrl:             "https://aoc.example.com",
		AutomationServerId: "test-server",
		AccessToken:        "tok",
		Private:            true,
		Proxied:            true,
		Force:              true,
	})
	s := &Server{}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/aoc/config", strings.NewReader(string(body)))
	s.handleAOCConfig(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d (body %q)", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
}

// TestAOCConfigPersistsPrivateRegistration: private/private_address must survive
// into the stored config, because that file is what the boot-time relay decision
// and a later disaster recovery both read.
func TestAOCConfigPersistsPrivateRegistration(t *testing.T) {
	writePrivateModeConfig(t, "")

	body, _ := json.Marshal(AOCConfigRequest{
		AOCUrl:             "https://aoc.example.com",
		AutomationServerId: "test-server",
		AccessToken:        "tok",
		Domain:             "acme-prod.bswn.io",
		Private:            true,
		PrivateAddress:     "10.8.0.7",
		Force:              true,
	})
	s := &Server{}
	rec := httptest.NewRecorder()
	s.handleAOCConfig(rec, httptest.NewRequest(http.MethodPost, "/aoc/config", strings.NewReader(string(body))))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}

	settings, err := config.NewAutomationServerConfig().GetAutomationOperationsCenterSettings()
	if err != nil {
		t.Fatal(err)
	}
	if !settings.Private {
		t.Error("private was not persisted")
	}
	if settings.PrivateAddress != "10.8.0.7" {
		t.Errorf("private_address = %q, want 10.8.0.7", settings.PrivateAddress)
	}

	// And the status endpoint must report it, since that is how the host side
	// (a recovery) learns the position it is restoring into.
	statusRec := httptest.NewRecorder()
	s.handleAOCStatus(statusRec, httptest.NewRequest(http.MethodGet, "/aoc/status", nil))
	var status AOCStatusResponse
	if err := json.NewDecoder(statusRec.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	if !status.Private || status.PrivateAddress != "10.8.0.7" {
		t.Errorf("AOCStatus = %+v, want private with address 10.8.0.7", status)
	}
}

func TestValidateIngressBindAddress(t *testing.T) {
	for _, tc := range []struct {
		addr    string
		wantErr bool
	}{
		{"", false},
		{"10.8.0.7", false},
		{"127.0.0.1", false},
		{"tun0", true},
		{"10.8.0.7:443", true},
		{"bailey.acme.bswn.io", true},
		{"fd00::1", true}, // v6 needs bracketed mappings we don't render
	} {
		err := validateIngressBindAddress(tc.addr)
		if (err != nil) != tc.wantErr {
			t.Errorf("validateIngressBindAddress(%q) error = %v, wantErr = %v", tc.addr, err, tc.wantErr)
		}
	}
}

func TestIngressInitPersistsBindAddress(t *testing.T) {
	writePrivateModeConfig(t, "")

	addr := "127.0.0.1"
	body, _ := json.Marshal(IngressInitRequest{BindAddress: &addr})
	s := &Server{}
	rec := httptest.NewRecorder()
	// initTraefikIngress will fail here (no docker in the test env); we only
	// assert the config write, which happens first and is the contract the CLI
	// depends on.
	s.handleIngressInit(rec, httptest.NewRequest(http.MethodPost, "/ingress/init", strings.NewReader(string(body))))

	if got := config.NewAutomationServerConfig().GetIngressBindAddress(); got != addr {
		t.Errorf("stored bind address = %q, want %q", got, addr)
	}

	// A rejected address must not be stored.
	bad := "not-an-ip"
	body, _ = json.Marshal(IngressInitRequest{BindAddress: &bad})
	rec = httptest.NewRecorder()
	s.handleIngressInit(rec, httptest.NewRequest(http.MethodPost, "/ingress/init", strings.NewReader(string(body))))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	if got := config.NewAutomationServerConfig().GetIngressBindAddress(); got != addr {
		t.Errorf("stored bind address = %q after a rejected request, want it unchanged (%q)", got, addr)
	}
}

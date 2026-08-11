package cmd

import (
	"encoding/json"
	"net"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
	"github.com/bitswan-space/bitswan-workspaces/internal/daemon"
)

// pointAtNoDaemon makes daemon.NewClient() fail (nothing listening), so
// aocBaseURL exercises its host-config fallback.
func pointAtNoDaemon(t *testing.T) {
	t.Helper()
	old := daemonSocketPath
	daemonSocketPath = filepath.Join(t.TempDir(), "absent.sock")
	t.Cleanup(func() { daemonSocketPath = old })
	// No auto-update on connect during tests (it would shell out to docker).
	daemon.SetVersionCheck("", nil)
}

// serveDaemonStub answers the two calls aocBaseURL makes over the daemon socket.
func serveDaemonStub(t *testing.T, status daemon.AOCStatusResponse) {
	t.Helper()
	sock := filepath.Join(t.TempDir(), "daemon.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/ping", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("/aoc/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(status)
	})
	srv := &http.Server{Handler: mux}
	go func() { _ = srv.Serve(ln) }()

	old := daemonSocketPath
	daemonSocketPath = sock
	t.Cleanup(func() {
		daemonSocketPath = old
		_ = srv.Close()
	})
	daemon.SetVersionCheck("", nil)
}

// Issue #347: `bitswan self-update` refused to run on a server registered from
// the AOC ("Create cloud server"). Registration lives in the daemon's config
// volume — the host config the CLI used to read is empty by design — so the AOC
// URL must come from the daemon.
func TestAOCBaseURL_AsksTheDaemon(t *testing.T) {
	t.Setenv("HOME", t.TempDir()) // no host config at all
	t.Setenv("SUDO_USER", "")
	serveDaemonStub(t, daemon.AOCStatusResponse{Registered: true, AOCUrl: "https://aoc.example.com", AutomationServerId: "srv-1"})

	got, err := aocBaseURL()
	if err != nil {
		t.Fatalf("aocBaseURL() error = %v, want the daemon's AOC URL", err)
	}
	if got != "https://aoc.example.com" {
		t.Errorf("aocBaseURL() = %q, want https://aoc.example.com", got)
	}
}

// An install registered before the daemon owned the config still has the URL on
// the host; keep honouring it when the daemon can't be reached.
func TestAOCBaseURL_FallsBackToHostConfig(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SUDO_USER", "")
	pointAtNoDaemon(t)

	if _, err := aocBaseURL(); err == nil {
		t.Error("aocBaseURL() with no daemon and no config: want an error")
	}

	if err := config.NewAutomationServerConfig().UpdateAutomationServer(
		config.AutomationOperationsCenterSettings{AOCUrl: "https://legacy.example.com", AutomationServerId: "x", AccessToken: "t"},
	); err != nil {
		t.Fatal(err)
	}
	got, err := aocBaseURL()
	if err != nil {
		t.Fatalf("aocBaseURL() error = %v", err)
	}
	if got != "https://legacy.example.com" {
		t.Errorf("aocBaseURL() = %q, want https://legacy.example.com", got)
	}
}

// A daemon that reports "not registered" must not mask a usable host config.
func TestAOCBaseURL_UnregisteredDaemonStillFallsBack(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SUDO_USER", "")
	serveDaemonStub(t, daemon.AOCStatusResponse{})
	if err := config.NewAutomationServerConfig().UpdateAutomationServer(
		config.AutomationOperationsCenterSettings{AOCUrl: "https://legacy.example.com", AutomationServerId: "x", AccessToken: "t"},
	); err != nil {
		t.Fatal(err)
	}
	got, err := aocBaseURL()
	if err != nil {
		t.Fatalf("aocBaseURL() error = %v", err)
	}
	if got != "https://legacy.example.com" {
		t.Errorf("aocBaseURL() = %q, want https://legacy.example.com", got)
	}
}

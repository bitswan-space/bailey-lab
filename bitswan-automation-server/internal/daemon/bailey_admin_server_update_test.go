package daemon

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
)

// collectNDJSON runs the handler and returns the emitted NDJSON events.
func collectNDJSON(t *testing.T, s *Server) []map[string]any {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/bailey/api/admin/server-update", nil)
	w := httptest.NewRecorder()
	s.handleAdminServerUpdate(w, r)
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(w.Body.String()), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("bad NDJSON line %q: %v", line, err)
		}
		out = append(out, m)
	}
	return out
}

func lastEvent(events []map[string]any) map[string]any {
	if len(events) == 0 {
		return nil
	}
	return events[len(events)-1]
}

// No AOC registration → the update can't find a binary to download and must
// fail loudly (not swap anything).
func TestAdminServerUpdate_NotRegistered(t *testing.T) {
	t.Setenv("HOME", t.TempDir()) // no config file → not registered
	t.Setenv("SUDO_USER", "")
	last := lastEvent(collectNDJSON(t, &Server{}))
	if last["event"] != "error" {
		t.Fatalf("last event = %v, want an error for an unregistered server", last)
	}
	if !strings.Contains(last["error"].(string), "not registered") {
		t.Errorf("error = %q, want it to mention not registered", last["error"])
	}
}

// AOC reachable but the binary endpoint 404s → fail with the upstream status,
// before touching the filesystem.
func TestAdminServerUpdate_DownloadNon200(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("SUDO_USER", "")
	aoc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "no binary here", http.StatusNotFound)
	}))
	defer aoc.Close()
	if err := config.NewAutomationServerConfig().UpdateAutomationServer(
		config.AutomationOperationsCenterSettings{AOCUrl: aoc.URL, AutomationServerId: "x", AccessToken: "t"},
	); err != nil {
		t.Fatal(err)
	}

	last := lastEvent(collectNDJSON(t, &Server{}))
	if last["event"] != "error" {
		t.Fatalf("last event = %v, want an error on a 404 download", last)
	}
	if !strings.Contains(last["error"].(string), "404") {
		t.Errorf("error = %q, want it to mention the 404", last["error"])
	}
}

// Full happy path: download a (fake but runnable) binary that passes the version
// sanity check, atomically swap it into place under a temp host root, keep a
// .bak, and end on the terminal "restarting" event.
func TestAdminServerUpdate_HappySwap(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("SUDO_USER", "")

	// Fake AOC serving a tiny executable that reports a bitswan version.
	fakeBinary := "#!/bin/sh\necho 'bitswan workspaces: vTEST'\n"
	aoc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write([]byte(fakeBinary))
	}))
	defer aoc.Close()
	if err := config.NewAutomationServerConfig().UpdateAutomationServer(
		config.AutomationOperationsCenterSettings{AOCUrl: aoc.URL, AutomationServerId: "x", AccessToken: "t"},
	); err != nil {
		t.Fatal(err)
	}

	// Redirect the "host" binary path into a temp tree with an existing binary
	// so the swap has something to back up. docker inspect will fail in the test
	// env, so hostBinaryPath falls back to <hostRootDir>/usr/local/bin/bitswan.
	saved := hostRootDir
	hostRootDir = t.TempDir()
	t.Cleanup(func() { hostRootDir = saved })
	binDir := filepath.Join(hostRootDir, "usr", "local", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	binPath := filepath.Join(binDir, "bitswan")
	if err := os.WriteFile(binPath, []byte("OLD BINARY"), 0o755); err != nil {
		t.Fatal(err)
	}

	events := collectNDJSON(t, &Server{})
	last := lastEvent(events)
	if last["event"] != "restarting" {
		t.Fatalf("last event = %v, want 'restarting' (body events: %v)", last, events)
	}

	// The new binary is installed and the old one preserved as .bak.
	got, err := os.ReadFile(binPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != fakeBinary {
		t.Errorf("installed binary = %q, want the downloaded fake", string(got))
	}
	bak, err := os.ReadFile(binPath + ".bak")
	if err != nil || string(bak) != "OLD BINARY" {
		t.Errorf(".bak = %q (err %v), want the previous binary preserved", string(bak), err)
	}
}

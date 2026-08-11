package daemon

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
	"github.com/bitswan-space/bitswan-workspaces/internal/workspace"
)

func TestTagOf(t *testing.T) {
	cases := map[string]string{
		"bitswan/gitops:2026.07.07.21":       "2026.07.07.21",
		"bitswan/gitops-staging:latest":      "latest",
		"registry.io:5000/bitswan/gitops:v1": "v1", // last colon wins
		"notag":                              "",
		"":                                   "",
	}
	for in, want := range cases {
		if got := tagOf(in); got != want {
			t.Errorf("tagOf(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestIsReleaseVersion(t *testing.T) {
	// The "v" prefix is optional: released binaries report the CalVer without it
	// (-X main.version=$VERSION), the AOC reports the tag with it.
	release := []string{"v2026.07.07.21", "  v2026.01.01.1  ", "2026.07.07.21", " 2026.01.01.1 "}
	notRelease := []string{"", "dev", "v2026.07.07.21-git-abc123", "v2026.07.07.21-dirty", "vlatest", "2026", "latest"}
	for _, v := range release {
		if !isReleaseVersion(v) {
			t.Errorf("isReleaseVersion(%q) = false, want true", v)
		}
	}
	for _, v := range notRelease {
		if isReleaseVersion(v) {
			t.Errorf("isReleaseVersion(%q) = true, want false", v)
		}
	}
}

func TestTagBehind(t *testing.T) {
	cases := []struct {
		deployed, latest string
		want             bool
	}{
		{"2026.07.01.1", "2026.07.02.1", true},  // behind → update
		{"2026.07.02.1", "2026.07.02.1", false}, // equal → no update
		{"", "2026.07.02.1", false},             // unknown deployed → never flag
		{"2026.07.01.1", "", false},             // unresolved latest → never flag
		{"", "", false},
	}
	for _, c := range cases {
		if got := tagBehind(c.deployed, c.latest); got != c.want {
			t.Errorf("tagBehind(%q,%q) = %v, want %v", c.deployed, c.latest, got, c.want)
		}
	}
}

func TestDeployedServiceImage(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	deployDir := filepath.Join(home, ".config", "bitswan", "workspaces", "ws1", "deployment")
	if err := os.MkdirAll(deployDir, 0755); err != nil {
		t.Fatal(err)
	}
	compose := "services:\n  bitswan-gitops:\n    image: bitswan/gitops-staging:2026.07.07.21\n"
	if err := os.WriteFile(filepath.Join(deployDir, "docker-compose.yml"), []byte(compose), 0644); err != nil {
		t.Fatal(err)
	}

	if got := deployedServiceImage("ws1", "docker-compose.yml", "bitswan-gitops"); got != "bitswan/gitops-staging:2026.07.07.21" {
		t.Errorf("deployedServiceImage = %q", got)
	}
	// Missing service / missing file both resolve to "" (never a false positive).
	if got := deployedServiceImage("ws1", "docker-compose.yml", "nope"); got != "" {
		t.Errorf("missing service = %q, want empty", got)
	}
	if got := deployedServiceImage("ws1", "docker-compose-dashboard.yml", "bitswan-dashboard"); got != "" {
		t.Errorf("missing file = %q, want empty", got)
	}
}

// detectServerVersion must never nag a dev / git-sha build, regardless of what
// the GitHub release endpoint says (or whether it's reachable at all).
func TestDetectServerVersion_DevBuildNeverFlags(t *testing.T) {
	for _, v := range []string{"", "v2026.07.07.21-git-abc123", "dev"} {
		info := detectServerVersion(v)
		if info.Current != v {
			t.Errorf("Current = %q, want %q", info.Current, v)
		}
		if info.UpdateAvailable {
			t.Errorf("detectServerVersion(%q).UpdateAvailable = true, want false", v)
		}
	}
}

// resetServerLatestCache drops the memoized AOC "latest release" answer, before
// and after the test, so a test's fake AOC is actually consulted and never
// leaks into another test.
func resetServerLatestCache(t *testing.T) {
	t.Helper()
	clear := func() {
		serverLatestMu.Lock()
		serverLatestVal = ""
		serverLatestAt = time.Time{}
		serverLatestMu.Unlock()
	}
	clear()
	t.Cleanup(clear)
}

// The exact shape of issue #347: the running binary reports the CalVer WITHOUT
// the "v" (the release workflow builds -X main.version=$VERSION and tags
// v$VERSION), while the AOC reports the tag. That pair must resolve to an
// offered update — the bug was "Up to date" shown next to a "current → latest"
// line, with no way to update.
func TestDetectServerVersion_UnprefixedCurrentIsBehindTaggedLatest(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SUDO_USER", "")
	aoc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"version":"v2026.08.05.70"}`))
	}))
	defer aoc.Close()
	if err := config.NewAutomationServerConfig().UpdateAutomationServer(
		config.AutomationOperationsCenterSettings{AOCUrl: aoc.URL, AutomationServerId: "x", AccessToken: "t"},
	); err != nil {
		t.Fatal(err)
	}
	resetServerLatestCache(t)

	info := detectServerVersion("2026.08.03.68")
	if info.Latest != "v2026.08.05.70" {
		t.Fatalf("Latest = %q, want v2026.08.05.70", info.Latest)
	}
	if !info.UpdateAvailable {
		t.Errorf("UpdateAvailable = false for 2026.08.03.68 → v2026.08.05.70, want true")
	}

	// Still conservative in the other direction: a server NEWER than what the
	// AOC serves is up to date, never offered a downgrade-as-update.
	if detectServerVersion("2026.09.01.1").UpdateAvailable {
		t.Errorf("UpdateAvailable = true for a version newer than the AOC's, want false")
	}
	// ...and an equal version (prefix difference only) is up to date too.
	if detectServerVersion("2026.08.05.70").UpdateAvailable {
		t.Errorf("UpdateAvailable = true for the same version as the AOC's, want false")
	}
}

// A workspace that was never deployed has no compose snapshot, so rollback must
// fail loudly rather than silently no-op.
func TestRollbackWorkspaceDeployment_NoSnapshot(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := workspace.RollbackWorkspaceDeployment("ghost"); err == nil {
		t.Fatal("expected an error rolling back a workspace with no snapshot")
	}
}

// SnapshotWorkspaceCompose captures the current compose so a later rollback can
// restore it; a workspace with no compose yet is a clean no-op (nothing to snap).
func TestSnapshotWorkspaceCompose(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	// No deployment yet → no-op, no error.
	if err := workspace.SnapshotWorkspaceCompose("ws1"); err != nil {
		t.Fatalf("snapshot with no compose should be a no-op: %v", err)
	}

	deployDir := filepath.Join(home, ".config", "bitswan", "workspaces", "ws1", "deployment")
	if err := os.MkdirAll(deployDir, 0755); err != nil {
		t.Fatal(err)
	}
	composePath := filepath.Join(deployDir, "docker-compose.yml")
	if err := os.WriteFile(composePath, []byte("services: {}\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := workspace.SnapshotWorkspaceCompose("ws1"); err != nil {
		t.Fatalf("snapshot failed: %v", err)
	}
	if _, err := os.Stat(composePath + ".rollback"); err != nil {
		t.Fatalf("expected a .rollback snapshot to exist: %v", err)
	}
}

// TestVersionLess pins the release-version ordering used to decide server
// update-availability: only genuinely-older → behind (a newer-than-latest
// pre-release must read as up to date, never as a downgrade-update).
func TestVersionLess(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"v2026.05.01.1", "v2026.06.02.81", true},   // older
		{"v2026.07.07.21", "v2026.06.02.81", false}, // NEWER than latest → not behind
		{"v2026.06.02.81", "v2026.06.02.81", false}, // equal
		{"v2026.06.02.9", "v2026.06.02.10", true},   // unpadded build number (lexical would fail)
		{"dev", "v2026.06.02.81", false},            // unparseable → never fabricate
		{"v2026.06.02.81", "garbage", false},
	}
	for _, c := range cases {
		if got := versionLess(c.a, c.b); got != c.want {
			t.Errorf("versionLess(%q,%q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

// fetchAOCBinaryVersion returns the version the AOC serves, "" on any failure.
func TestFetchAOCBinaryVersion(t *testing.T) {
	// No config → empty (nowhere to ask).
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SUDO_USER", "")
	if got := fetchAOCBinaryVersion(); got != "" {
		t.Errorf("no config: got %q, want empty", got)
	}

	// Configured AOC that reports a version → returned verbatim.
	aoc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"version":"v2026.07.23.9"}`))
	}))
	defer aoc.Close()
	if err := config.NewAutomationServerConfig().UpdateAutomationServer(
		config.AutomationOperationsCenterSettings{AOCUrl: aoc.URL, AutomationServerId: "x", AccessToken: "t"},
	); err != nil {
		t.Fatal(err)
	}
	if got := fetchAOCBinaryVersion(); got != "v2026.07.23.9" {
		t.Errorf("got %q, want v2026.07.23.9", got)
	}

	// AOC that errors → empty (never fabricate).
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusInternalServerError)
	}))
	defer bad.Close()
	if err := config.NewAutomationServerConfig().UpdateAutomationServer(
		config.AutomationOperationsCenterSettings{AOCUrl: bad.URL, AutomationServerId: "x", AccessToken: "t"},
	); err != nil {
		t.Fatal(err)
	}
	if got := fetchAOCBinaryVersion(); got != "" {
		t.Errorf("AOC 500: got %q, want empty", got)
	}
}

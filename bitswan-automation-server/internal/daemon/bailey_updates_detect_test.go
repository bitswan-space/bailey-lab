package daemon

import (
	"os"
	"path/filepath"
	"testing"

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
	release := []string{"v2026.07.07.21", "  v2026.01.01.1  "}
	notRelease := []string{"", "dev", "v2026.07.07.21-git-abc123", "v2026.07.07.21-dirty", "2026.07.07.21", "vlatest"}
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

package daemon

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// requireDocker skips the calling test unless it's running on Linux with the
// `docker` binary on PATH. The server-owner empty-trash path drives
// RunWorkspaceRemove, which is a docker-orchestration flow: it shells out to
// `docker compose down`/`up` for every known compose project and spawns a
// background goroutine that calls DetectIngressType()/
// DeleteTraefikRecordsWithWriter() (more `docker` calls, plus Linux-oriented
// ingress teardown) while still writing to the test's buffer.
//
// The macOS CI image has no docker at all; the windows-latest image ships the
// docker CLI (so a bare LookPath passes) but its daemon can't run our
// Linux-image compose stacks, so `docker compose up` exits 1. Gate on
// GOOS=="linux" too — these tests are a real exercise only on the Linux runner
// and a clean skip everywhere else.
func requireDocker(t *testing.T) {
	t.Helper()
	if runtime.GOOS != "linux" {
		t.Skipf("docker-orchestration test only runs on linux (GOOS=%s)", runtime.GOOS)
	}
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("docker not available; skipping docker-dependent workspace-remove path")
	}
}

// mkWorkspaceDir creates $HOME/.config/bitswan/workspaces/<name> (and
// optionally a deployment subdir) so the trash helpers have a real tree
// to operate on. Returns the workspace directory.
func mkWorkspaceDir(t *testing.T, name string, withDeployment bool) string {
	t.Helper()
	wsDir := filepath.Join(os.Getenv("HOME"), ".config", "bitswan", "workspaces", name)
	if err := os.MkdirAll(wsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if withDeployment {
		if err := os.MkdirAll(filepath.Join(wsDir, "deployment"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { os.RemoveAll(wsDir) })
	return wsDir
}

func TestTrashMarker_RoundTrip(t *testing.T) {
	name := "trashws"
	mkWorkspaceDir(t, name, false)

	if IsWorkspaceTrashed(name) {
		t.Fatal("workspace already trashed before marking")
	}
	if err := MarkWorkspaceTrashed(name); err != nil {
		t.Fatal(err)
	}
	if !IsWorkspaceTrashed(name) {
		t.Error("marker not detected after MarkWorkspaceTrashed")
	}
	// Marker path is under the workspace dir.
	p, err := trashMarkerPath(name)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(p, filepath.Join(name, trashMarkerName)) {
		t.Errorf("marker path = %q", p)
	}
	if _, err := os.Stat(p); err != nil {
		t.Errorf("marker file missing: %v", err)
	}
}

func TestMarkWorkspaceTrashed_MissingWorkspace(t *testing.T) {
	if err := MarkWorkspaceTrashed("does-not-exist-ws"); err == nil {
		t.Error("marking a missing workspace should error")
	}
}

func TestComposeProjectsForWorkspace(t *testing.T) {
	got := composeProjectsForWorkspace("MyWS")
	// Lowercased + all known historical project names present.
	want := map[string]bool{
		"myws-site": true, "myws-dashboard": true,
		"myws__traefik": true, "bitswan-myws-traefik": true,
	}
	for _, p := range got {
		delete(want, p)
	}
	if len(want) != 0 {
		t.Errorf("composeProjectsForWorkspace missing %v (got %v)", want, got)
	}
}

func TestRestoreWorkspace_MissingDirsError(t *testing.T) {
	var buf bytes.Buffer
	// No workspace at all.
	if err := RestoreWorkspace("no-such-restore-ws", &buf); err == nil {
		t.Error("restore of missing workspace should error")
	}
	// Workspace exists but has no deployment dir.
	name := "restore-nodeploy"
	mkWorkspaceDir(t, name, false)
	if err := RestoreWorkspace(name, &buf); err == nil {
		t.Error("restore without deployment dir should error")
	}
}

// TestRestoreWorkspace_HappyPath exercises the full restore flow: the
// deployment dir exists plus the optional dashboard + sub-traefik compose
// files, so every `docker compose up` branch runs (they're quiet no-ops for
// this synthetic workspace) and the trash marker is removed at the end.
// Gated on docker since RestoreWorkspace shells out to `docker compose`.
func TestRestoreWorkspace_HappyPath(t *testing.T) {
	requireDocker(t)
	name := "restore-happy-unique"
	wsDir := mkWorkspaceDir(t, name, true) // with deployment/

	// Main compose project: a single no-op service so `docker compose up -d`
	// succeeds (a missing/empty compose file makes compose exit non-zero,
	// which RestoreWorkspace treats as a hard error).
	if err := os.WriteFile(filepath.Join(wsDir, "deployment", "docker-compose.yml"),
		[]byte("services:\n  noop:\n    image: alpine:3\n    command: [\"true\"]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Optional compose files so the dashboard + sub-traefik branches run.
	if err := os.WriteFile(filepath.Join(wsDir, "deployment", "docker-compose-dashboard.yml"),
		[]byte("services: {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	traefikDir := filepath.Join(wsDir, "traefik")
	if err := os.MkdirAll(traefikDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(traefikDir, "docker-compose.yaml"),
		[]byte("services: {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := MarkWorkspaceTrashed(name); err != nil {
		t.Fatal(err)
	}
	if !IsWorkspaceTrashed(name) {
		t.Fatal("workspace not marked trashed")
	}

	// Tear down the compose projects RestoreWorkspace brings up, whatever
	// the test's outcome.
	lc := strings.ToLower(name)
	t.Cleanup(func() {
		for _, p := range []string{lc + "-site", lc + "-dashboard", name + "__traefik"} {
			_ = exec.Command("docker", "compose", "-p", p, "down", "--volumes").Run()
		}
	})

	var buf bytes.Buffer
	if err := RestoreWorkspace(name, &buf); err != nil {
		t.Fatalf("RestoreWorkspace happy path: %v\nlog:%s", err, buf.String())
	}
	// Marker removed on success.
	if IsWorkspaceTrashed(name) {
		t.Error("trash marker not removed after restore")
	}
	if !strings.Contains(buf.String(), "Workspace restored.") {
		t.Errorf("restore log missing completion line: %s", buf.String())
	}
}

func TestEmptyTrashFor_NoWorkspacesDir(t *testing.T) {
	// Point HOME at a temp dir with no workspaces subdir → read error.
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)
	t.Setenv("SUDO_USER", "")
	var buf bytes.Buffer
	if err := EmptyTrashFor("u@example.com", nil, false, &buf); err == nil {
		t.Error("EmptyTrashFor with no workspaces dir should error")
	}
}

func TestEmptyTrashFor_ServerOwnerRemovesOwnedEntry(t *testing.T) {
	requireDocker(t)
	writeTestConfig(t)
	name := "etf-zztoremove-unique"
	wsDir := mkWorkspaceDir(t, name, false)
	if err := MarkWorkspaceTrashed(name); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	// isServerOwner=true → bypasses the per-entry ACL check and calls
	// RunWorkspaceRemove. There are no real containers for this synthetic
	// name, so the docker compose downs are quiet no-ops.
	if err := EmptyTrashFor("srv-owner@example.com", nil, true, &buf); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(wsDir); !os.IsNotExist(err) {
		t.Errorf("workspace dir not removed by empty-trash: %v", err)
	}
	if !strings.Contains(buf.String(), "Permanently removing") {
		t.Errorf("log missing removal line: %s", buf.String())
	}
}

func TestEmptyTrashFor_SkipsNonOwnerEntries(t *testing.T) {
	domain := writeTestConfig(t)
	// A trashed workspace the caller does NOT own.
	name := "etf-notowned"
	mkWorkspaceDir(t, name, false)
	if err := MarkWorkspaceTrashed(name); err != nil {
		t.Fatal(err)
	}
	// Register the gitops endpoint to a different owner so directRoleFor
	// resolves the caller to non-owner.
	if _, err := registerEndpoint(name+"-gitops."+domain, "real-owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := EmptyTrashFor("not-the-owner@example.com", nil, false, &buf); err != nil {
		t.Fatal(err)
	}
	// The workspace must NOT have been removed (skipped as non-owner).
	if !IsWorkspaceTrashed(name) {
		t.Error("non-owner entry was emptied; should have been skipped")
	}
	if !strings.Contains(buf.String(), "not owner") {
		t.Errorf("expected a 'not owner' skip message, got: %s", buf.String())
	}
}

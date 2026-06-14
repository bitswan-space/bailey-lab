package daemon

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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

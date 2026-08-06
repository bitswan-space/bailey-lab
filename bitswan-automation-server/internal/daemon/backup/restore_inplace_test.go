package backup

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func inPlaceFixture(t *testing.T) string {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	writeServerConfig(t, "https://aoc.example.com")
	if err := SaveKey("k"); err != nil {
		t.Fatal(err)
	}
	return workspaceDir("ws1")
}

// The happy path: restic is invoked in place, at the live path, and the result
// is verified to exist.
func TestRestoreFilesInPlaceArgv(t *testing.T) {
	wsDir := inPlaceFixture(t)
	// The fake creates the tree so the post-restore verification passes.
	argvFile := fakeResticScript(t, "mkdir -p "+wsDir+"\nexit 0\n")

	snap := FilesSnapshot{ID: "files-1", ShortID: "f1", Time: time.Now(), Path: wsDir}
	if err := RestoreFilesInPlace(context.Background(), "ws1", snap, nil); err != nil {
		t.Fatal(err)
	}

	argv, err := os.ReadFile(argvFile)
	if err != nil {
		t.Fatal(err)
	}
	got := strings.TrimSpace(string(argv))
	want := "restore files-1 --target / --include " + wsDir
	if got != want {
		t.Errorf("argv = %q, want %q", got, want)
	}
}

// restic exits 0 when --include matches nothing, so a no-op must be caught
// rather than reported as success.
func TestRestoreFilesInPlaceDetectsNoOp(t *testing.T) {
	wsDir := inPlaceFixture(t)
	fakeResticScript(t, "exit 0\n") // writes nothing

	snap := FilesSnapshot{ID: "files-1", Path: wsDir}
	err := RestoreFilesInPlace(context.Background(), "ws1", snap, nil)
	if err == nil {
		t.Fatal("expected an error when the restore produced no tree")
	}
	if !strings.Contains(err.Error(), "still missing") {
		t.Errorf("unhelpful error: %v", err)
	}
}

// Excluding the per-BP snapshots directory keeps a large, re-fetchable subtree
// out of the restore.
func TestRestoreFilesInPlaceExcludes(t *testing.T) {
	wsDir := inPlaceFixture(t)
	argvFile := fakeResticScript(t, "mkdir -p "+wsDir+"\nexit 0\n")

	snap := FilesSnapshot{ID: "files-1", Path: wsDir}
	excl := []string{filepath.Join(wsDir, "snapshots")}
	if err := RestoreFilesInPlace(context.Background(), "ws1", snap, excl); err != nil {
		t.Fatal(err)
	}
	argv, _ := os.ReadFile(argvFile)
	if !strings.Contains(string(argv), "--exclude "+excl[0]) {
		t.Errorf("argv missing the exclude: %s", argv)
	}
}

// A snapshot recorded under a different absolute path would land somewhere
// other than the live tree and still report success, so it must be refused.
func TestRestoreFilesInPlaceRefusesForeignPath(t *testing.T) {
	inPlaceFixture(t)
	argvFile := fakeResticScript(t, "exit 0\n")

	snap := FilesSnapshot{ID: "files-1", ShortID: "f1", Path: "/somewhere/else/workspaces/ws1"}
	err := RestoreFilesInPlace(context.Background(), "ws1", snap, nil)
	if err == nil {
		t.Fatal("expected a refusal for a snapshot recorded at a different path")
	}
	if !strings.Contains(err.Error(), "refusing an in-place restore") {
		t.Errorf("unhelpful error: %v", err)
	}
	if _, statErr := os.Stat(argvFile); statErr == nil {
		t.Error("restic ran despite the path mismatch")
	}
}

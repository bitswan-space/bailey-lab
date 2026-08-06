package backup

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeResticScript installs a restic fake whose behavior is the given shell
// script body ("$@" is the argv). Records every call's argv.
func fakeResticScript(t *testing.T, body string) (argvFile string) {
	t.Helper()
	binDir := t.TempDir()
	argvFile = filepath.Join(binDir, "argv")
	script := "#!/bin/sh\necho \"$@\" >> " + argvFile + "\n" + body
	if err := os.WriteFile(filepath.Join(binDir, "restic"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+":"+os.Getenv("PATH"))
	return argvFile
}

// Two nightlies: only the OLDER one still contains the pruned snapshot dir.
const twoNightliesScript = `
case "$1" in
snapshots)
  cat <<'EOF'
[
 {"id":"newer-full-id","short_id":"newer","time":"2026-07-28T02:00:00Z","tags":["files","ws:ws1"]},
 {"id":"older-full-id","short_id":"older","time":"2026-07-20T02:00:00Z","tags":["files","ws:ws1"]}
]
EOF
  ;;
ls)
  case "$2" in
  older-full-id)
    echo "$3"
    echo "$3/manifest.json"
    ;;
  *)
    echo "path not found" >&2
    exit 1
    ;;
  esac
  ;;
restore)
  ;;
esac
exit 0
`

func TestFindSnapshotWithPath(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	writeServerConfig(t, "https://aoc.example.com")
	fakeResticScript(t, twoNightliesScript)

	restic, err := newResticFromStateForTest(t)
	if err != nil {
		t.Fatal(err)
	}

	id, err := FindSnapshotWithPath(context.Background(), restic,
		[]string{"files,ws:ws1"}, "/data/snapshots/bp1/production/snap-1")
	if err != nil {
		t.Fatal(err)
	}
	if id != "older-full-id" {
		t.Errorf("found %q, want the older nightly that still has the path", id)
	}
}

func newResticFromStateForTest(t *testing.T) (*Restic, error) {
	t.Helper()
	if err := SaveKey("test-key"); err != nil {
		t.Fatal(err)
	}
	return newResticFromState()
}

func TestFindSnapshotWithPathMissingEverywhere(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	writeServerConfig(t, "https://aoc.example.com")
	fakeResticScript(t, `
case "$1" in
snapshots) echo "[]" ;;
esac
exit 0
`)
	restic, err := newResticFromStateForTest(t)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := FindSnapshotWithPath(context.Background(), restic, nil, "/nope"); err == nil {
		t.Fatal("expected error when no snapshot has the path")
	}
}

func TestListOffsiteSnapshots(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	writeServerConfig(t, "https://aoc.example.com")

	prefix := filepath.Join(home, ".config", "bitswan", "workspaces", "ws1", "snapshots", "bp1", "production")
	script := `
case "$1" in
snapshots)
  cat <<'EOF'
[
 {"id":"n1","short_id":"n1s","time":"2026-07-28T02:00:00Z","tags":["files","ws:ws1"]},
 {"id":"n2","short_id":"n2s","time":"2026-07-20T02:00:00Z","tags":["files","ws:ws1"]}
]
EOF
  ;;
ls)
  case "$2" in
  n1)
    echo "PREFIX/snap-b/manifest.json"
    ;;
  n2)
    echo "PREFIX/snap-a/manifest.json"
    echo "PREFIX/snap-b/manifest.json"
    ;;
  esac
  ;;
esac
exit 0
`
	fakeResticScript(t, strings.ReplaceAll(script, "PREFIX", prefix))
	if err := SaveKey("k"); err != nil {
		t.Fatal(err)
	}

	refs, err := ListOffsiteSnapshots(context.Background(), "ws1", "bp1", "production")
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 2 {
		t.Fatalf("refs = %+v, want snap-a and snap-b", refs)
	}
	byID := map[string]OffsiteSnapshotRef{}
	for _, ref := range refs {
		byID[ref.SnapshotID] = ref
	}
	// snap-b appears in both nightlies — the NEWEST capture wins.
	if byID["snap-b"].ResticSnapshot != "n1s" {
		t.Errorf("snap-b from %q, want newest nightly", byID["snap-b"].ResticSnapshot)
	}
	if byID["snap-a"].ResticSnapshot != "n2s" {
		t.Errorf("snap-a from %q, want the only nightly holding it", byID["snap-a"].ResticSnapshot)
	}
}

func TestFetchSnapshotAlreadyLocal(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	writeServerConfig(t, "https://aoc.example.com")
	argvFile := fakeResticScript(t, "exit 0\n")
	if err := SaveKey("k"); err != nil {
		t.Fatal(err)
	}

	local := filepath.Join(home, ".config", "bitswan", "workspaces", "ws1", "snapshots", "bp1", "production", "snap-1")
	if err := os.MkdirAll(local, 0o755); err != nil {
		t.Fatal(err)
	}

	if err := FetchSnapshot(context.Background(), "ws1", "bp1", "production", "snap-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(argvFile); !os.IsNotExist(err) {
		t.Error("restic should not run when the snapshot is already local")
	}
}

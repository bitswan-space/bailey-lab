package backup

import (
	"context"
	"os"
	"strings"
	"testing"
)

// Two nightly runs. Within each run the FILES snapshot is captured before the
// dumps (Engine.backupWorkspace does files first), so every dump timestamp is
// NEWER than its run's files timestamp. That ordering is the whole reason
// selection has to bracket by the NEXT files snapshot: a naive "newest dump at
// or before the files snapshot" rule picks the previous night's databases.
const twoRunsScript = `
tag=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--tag" ]; then tag="$a"; fi
  prev="$a"
done
case "$1" in
snapshots)
  case "$tag" in
  files,ws:ws1)
    cat <<'EOF'
[
 {"id":"files-old","short_id":"fold","time":"2026-07-28T02:00:00Z","tags":["files","ws:ws1"],"paths":["/data/workspaces/ws1"]},
 {"id":"files-new","short_id":"fnew","time":"2026-07-29T02:00:00Z","tags":["files","ws:ws1"],"paths":["/data/workspaces/ws1"]}
]
EOF
    ;;
  postgres,ws:ws1,stage:production)
    cat <<'EOF'
[
 {"id":"pg-old","short_id":"pold","time":"2026-07-28T02:00:05Z","tags":["postgres","ws:ws1","stage:production"]},
 {"id":"pg-new","short_id":"pnew","time":"2026-07-29T02:00:05Z","tags":["postgres","ws:ws1","stage:production"]}
]
EOF
    ;;
  couchdb,ws:ws1,stage:production)
    # Only the OLD run captured couchdb (the container was down in the new run).
    cat <<'EOF'
[
 {"id":"couch-old","short_id":"cold","time":"2026-07-28T02:00:07Z","tags":["couchdb","ws:ws1","stage:production"]}
]
EOF
    ;;
  *)
    echo "[]"
    ;;
  esac
  ;;
esac
exit 0
`

func selectFixture(t *testing.T) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	writeServerConfig(t, "https://aoc.example.com")
	if err := SaveKey("k"); err != nil {
		t.Fatal(err)
	}
}

// The regression test: anchoring on the newest files snapshot must select the
// SAME run's dump, not the previous night's.
func TestSelectSnapshotSetPicksSameRunDumps(t *testing.T) {
	selectFixture(t)
	fakeResticScript(t, twoRunsScript)

	set, err := SelectSnapshotSet(context.Background(), "ws1", "",
		[]string{"postgres"}, []string{"production"})
	if err != nil {
		t.Fatal(err)
	}
	if set.Files.ID != "files-new" {
		t.Fatalf("anchor = %q, want the newest files snapshot", set.Files.ID)
	}
	if !set.Files.NextTime.IsZero() {
		t.Errorf("NextTime = %v, want zero for the newest run", set.Files.NextTime)
	}
	dump, ok := set.Dump("postgres", "production")
	if !ok {
		t.Fatal("no postgres dump selected")
	}
	if dump.ID != "pg-new" {
		t.Errorf("postgres dump = %q, want pg-new (the same run); pg-old would be the previous night's data", dump.ID)
	}
	if dump.Stale {
		t.Error("dump marked stale although it is from the anchor run")
	}
}

// Anchoring on an older files snapshot must select that run's dumps — the
// point-in-time case, which also proves the upper bound is applied.
func TestSelectSnapshotSetPointInTime(t *testing.T) {
	selectFixture(t)
	fakeResticScript(t, twoRunsScript)

	set, err := SelectSnapshotSet(context.Background(), "ws1", "files-old",
		[]string{"postgres"}, []string{"production"})
	if err != nil {
		t.Fatal(err)
	}
	if set.Files.NextTime.IsZero() {
		t.Fatal("NextTime not set, so the run window has no upper bound")
	}
	dump, _ := set.Dump("postgres", "production")
	if dump.ID != "pg-old" {
		t.Errorf("postgres dump = %q, want pg-old (the anchored run)", dump.ID)
	}
}

// A series with nothing in the anchor run's window falls back to an older
// snapshot, but must say so rather than restoring stale data silently.
func TestSelectSnapshotSetFlagsStaleFallback(t *testing.T) {
	selectFixture(t)
	fakeResticScript(t, twoRunsScript)

	set, err := SelectSnapshotSet(context.Background(), "ws1", "",
		[]string{"couchdb"}, []string{"production"})
	if err != nil {
		t.Fatal(err)
	}
	dump, ok := set.Dump("couchdb", "production")
	if !ok || dump.ID != "couch-old" {
		t.Fatalf("couchdb dump = %+v, want the older snapshot as a fallback", dump)
	}
	if !dump.Stale {
		t.Error("fallback not marked stale")
	}
	if len(set.Warnings) == 0 || !strings.Contains(strings.Join(set.Warnings, " "), "couchdb/production") {
		t.Errorf("no warning naming the stale series: %v", set.Warnings)
	}
}

// An absent series is reported missing so the caller skips it instead of
// restoring something unrelated.
func TestSelectSnapshotSetMissingSeries(t *testing.T) {
	selectFixture(t)
	fakeResticScript(t, twoRunsScript)

	set, err := SelectSnapshotSet(context.Background(), "ws1", "",
		[]string{"garage"}, []string{"production"})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := set.Dump("garage", "production"); ok {
		t.Error("garage reported usable although the series is empty")
	}
}

// Every series query must carry exactly ONE --tag with comma-joined values:
// multiple --tag flags OR, which would widen the query across workspaces.
func TestSelectSnapshotSetUsesAndedTags(t *testing.T) {
	selectFixture(t)
	argvFile := fakeResticScript(t, twoRunsScript)

	if _, err := SelectSnapshotSet(context.Background(), "ws1", "",
		[]string{"postgres"}, []string{"production"}); err != nil {
		t.Fatal(err)
	}
	argv, err := os.ReadFile(argvFile)
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(strings.TrimSpace(string(argv)), "\n") {
		if !strings.HasPrefix(line, "snapshots") {
			continue
		}
		if n := strings.Count(line, "--tag"); n != 1 {
			t.Errorf("%q carries %d --tag flags, want exactly 1 (multiple flags OR)", line, n)
		}
		if !strings.Contains(line, "ws:ws1") {
			t.Errorf("%q is not scoped to the workspace", line)
		}
	}
}

// No files series at all must fail with an explanatory error, not silently
// recover nothing.
func TestSelectSnapshotSetNoFilesSnapshot(t *testing.T) {
	selectFixture(t)
	fakeResticScript(t, "echo '[]'\nexit 0\n")

	_, err := SelectSnapshotSet(context.Background(), "ws1", "", nil, nil)
	if err == nil {
		t.Fatal("expected an error when the workspace has no file-tree backup")
	}
	if !strings.Contains(err.Error(), "no file-tree backup") {
		t.Errorf("unhelpful error: %v", err)
	}
}

func TestSelectSnapshotSetUnknownAnchor(t *testing.T) {
	selectFixture(t)
	fakeResticScript(t, twoRunsScript)

	if _, err := SelectSnapshotSet(context.Background(), "ws1", "nope", nil, nil); err == nil {
		t.Fatal("expected an error for a snapshot id that is not a files backup of this workspace")
	}
}

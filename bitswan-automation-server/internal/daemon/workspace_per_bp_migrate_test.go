package daemon

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// testRunner runs commands directly (tests don't have a user1000 to su into).
func testRunner(t *testing.T) gitRunner {
	t.Helper()
	env := append(os.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
		// The migration chowns repos to uid 1000 (production runs git AS
		// user1000); the test runs git as the test user, so waive git's
		// dubious-ownership refusal for the temp dirs.
		"GIT_CONFIG_COUNT=1",
		"GIT_CONFIG_KEY_0=safe.directory", "GIT_CONFIG_VALUE_0=*",
	)
	return func(dir, cmd string) (string, error) {
		c := exec.Command("sh", "-c", cmd)
		c.Dir = dir
		c.Env = env
		out, err := c.CombinedOutput()
		return strings.TrimSpace(string(out)), err
	}
}

func gitOut(t *testing.T, dir string, args ...string) string {
	t.Helper()
	c := exec.Command("git", args...)
	c.Dir = dir
	c.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
		"GIT_CONFIG_COUNT=1",
		"GIT_CONFIG_KEY_0=safe.directory", "GIT_CONFIG_VALUE_0=*",
	)
	out, err := c.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v in %s: %v\n%s", args, dir, err, out)
	}
	return strings.TrimSpace(string(out))
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// buildLegacyWorkspace fabricates the OLD layout: one bare repo.git, a main
// copy (clone of main with two BPs) and a user copy `u1` on its own branch
// with a synced base, one committed-but-unsynced change, and one uncommitted
// edit + one untracked artifact file.
func buildLegacyWorkspace(t *testing.T) string {
	t.Helper()
	wsDir := t.TempDir()
	run := testRunner(t)

	bare := filepath.Join(wsDir, "repo.git")
	if _, err := run(wsDir, "git init -q --bare --initial-branch=main repo.git"); err != nil {
		t.Fatal(err)
	}

	seed := filepath.Join(wsDir, "seedwork")
	gitOut(t, wsDir, "clone", "-q", bare, seed)
	write(t, filepath.Join(seed, "bpa", "process.toml"), "process-id = \"a\"\n")
	write(t, filepath.Join(seed, "bpa", "worker", "main.py"), "print('a0')\n")
	write(t, filepath.Join(seed, "bpb", "process.toml"), "process-id = \"b\"\n")
	gitOut(t, seed, "add", "-A")
	gitOut(t, seed, "commit", "-qm", "seed")
	gitOut(t, seed, "push", "-q", "origin", "HEAD:refs/heads/main")

	copies := filepath.Join(wsDir, "copies")
	mainCopy := filepath.Join(copies, "main")
	gitOut(t, wsDir, "clone", "-q", "-b", "main", bare, mainCopy)

	u1 := filepath.Join(copies, "u1")
	gitOut(t, wsDir, "clone", "-q", "-b", "main", bare, u1)
	gitOut(t, u1, "checkout", "-qb", "u1")
	// Committed-but-unsynced change in bpa.
	write(t, filepath.Join(u1, "bpa", "worker", "main.py"), "print('a1')\n")
	gitOut(t, u1, "add", "-A")
	gitOut(t, u1, "commit", "-qm", "u1 work on bpa")
	// Uncommitted edit in bpb + an untracked build artifact in bpa.
	write(t, filepath.Join(u1, "bpb", "notes.md"), "uncommitted\n")
	write(t, filepath.Join(u1, "bpa", "worker", ".venv", "lib.txt"), "artifact\n")
	// Make the artifact ignored so it stays untracked through the swap.
	write(t, filepath.Join(u1, "bpa", ".gitignore"), ".venv/\n")

	// A deployed compose marker is not needed here — migrateToPerBPRepos is
	// called directly, not via the workspace loop.
	return wsDir
}

func TestMigrateToPerBPRepos_FreshStartSplit(t *testing.T) {
	wsDir := buildLegacyWorkspace(t)
	run := testRunner(t)

	if err := migrateToPerBPRepos("ws1", wsDir, run); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	reposDir := filepath.Join(wsDir, "git-repos")
	// Per-BP bares exist with the import commit on main.
	for _, bp := range []string{"bpa", "bpb"} {
		bare := filepath.Join(reposDir, bp+".git")
		if _, err := os.Stat(filepath.Join(bare, "objects")); err != nil {
			t.Fatalf("missing bare for %s", bp)
		}
		subjects := gitOut(t, bare, "log", "--format=%s", "main")
		if !strings.Contains(subjects, "Import "+bp+" from shared workspace repo") {
			t.Fatalf("%s main missing import commit: %s", bp, subjects)
		}
		if !strings.Contains(subjects, "Initialize business process "+bp) {
			t.Fatalf("%s main missing seed commit: %s", bp, subjects)
		}
	}

	// The u1 branch carries u1's state as CONTENT: the committed change AND
	// the previously-uncommitted edit.
	bpaBare := filepath.Join(reposDir, "bpa.git")
	if got := gitOut(t, bpaBare, "show", "u1:worker/main.py"); got != "print('a1')" {
		t.Fatalf("bpa u1 content = %q", got)
	}
	bpbBare := filepath.Join(reposDir, "bpb.git")
	if got := gitOut(t, bpbBare, "show", "u1:notes.md"); got != "uncommitted" {
		t.Fatalf("bpb u1 uncommitted edit lost: %q", got)
	}
	// main did NOT get u1's changes (fresh split keeps scopes apart).
	if got := gitOut(t, bpaBare, "show", "main:worker/main.py"); got != "print('a0')" {
		t.Fatalf("bpa main content changed: %q", got)
	}

	// Copies were converted in place: copy roots are plain dirs, BP dirs are
	// clones on the right branch with per-BP origins.
	copies := filepath.Join(wsDir, "copies")
	if _, err := os.Stat(filepath.Join(copies, "u1", ".git")); err == nil {
		t.Fatal("copy-root .git should be gone")
	}
	if _, err := os.Stat(filepath.Join(copies, "main", ".git")); err == nil {
		t.Fatal("main copy-root .git should be gone")
	}
	u1bpa := filepath.Join(copies, "u1", "bpa")
	if got := gitOut(t, u1bpa, "rev-parse", "--abbrev-ref", "HEAD"); got != "u1" {
		t.Fatalf("u1/bpa branch = %q", got)
	}
	if got := gitOut(t, u1bpa, "remote", "get-url", "origin"); got != "http://ws1-gitops:8079/git/bpa.git" {
		t.Fatalf("u1/bpa origin = %q", got)
	}
	// The untracked (ignored) artifact survived the clone-swap.
	if _, err := os.Stat(filepath.Join(u1bpa, "worker", ".venv", "lib.txt")); err != nil {
		t.Fatal("untracked artifact lost in clone-swap")
	}
	// The main copy's BP checkouts track main.
	mainBpb := filepath.Join(copies, "main", "bpb")
	if got := gitOut(t, mainBpb, "rev-parse", "--abbrev-ref", "HEAD"); got != "main" {
		t.Fatalf("main/bpb branch = %q", got)
	}

	// Legacy repo archived; an empty repo.git dir remains for stale mounts.
	archives, _ := filepath.Glob(filepath.Join(wsDir, "repo.git.archived-*"))
	if len(archives) != 1 {
		t.Fatalf("expected 1 archive, got %v", archives)
	}
	if _, err := os.Stat(filepath.Join(wsDir, "repo.git", "objects")); err == nil {
		t.Fatal("repo.git should be an empty placeholder")
	}

	// Marker written.
	if _, err := os.Stat(filepath.Join(wsDir, perBPMigratedMarker)); err != nil {
		t.Fatal("marker missing")
	}
}

func TestMigrateToPerBPRepos_Idempotent(t *testing.T) {
	wsDir := buildLegacyWorkspace(t)
	run := testRunner(t)

	if err := migrateToPerBPRepos("ws1", wsDir, run); err != nil {
		t.Fatalf("first run: %v", err)
	}
	bpaBare := filepath.Join(wsDir, "git-repos", "bpa.git")
	mainBefore := gitOut(t, bpaBare, "rev-parse", "main")
	u1Before := gitOut(t, bpaBare, "rev-parse", "u1")

	// Marker present → immediate no-op.
	if err := migrateToPerBPRepos("ws1", wsDir, run); err != nil {
		t.Fatalf("second run: %v", err)
	}
	// Even with the marker removed (simulated partial failure), a re-run must
	// not duplicate imports or move refs.
	if err := os.Remove(filepath.Join(wsDir, perBPMigratedMarker)); err != nil {
		t.Fatal(err)
	}
	if err := migrateToPerBPRepos("ws1", wsDir, run); err != nil {
		t.Fatalf("re-run after marker removal: %v", err)
	}
	if got := gitOut(t, bpaBare, "rev-parse", "main"); got != mainBefore {
		t.Fatalf("main moved on re-run: %s -> %s", mainBefore, got)
	}
	if got := gitOut(t, bpaBare, "rev-parse", "u1"); got != u1Before {
		t.Fatalf("u1 moved on re-run: %s -> %s", u1Before, got)
	}
	// Only one archive even after re-runs.
	archives, _ := filepath.Glob(filepath.Join(wsDir, "repo.git.archived-*"))
	if len(archives) != 1 {
		t.Fatalf("expected 1 archive after re-runs, got %v", archives)
	}
}

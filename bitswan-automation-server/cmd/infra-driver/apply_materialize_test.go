package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// An apply waits on the workspace apply lock, so it can run minutes after its
// own push. Everything gitops committed in that window — an audit sign-off, a
// freeze, a firewall edit, a secret — lives in the working tree the apply used
// to rebuild, and rebuilding it reverted those files silently while gitops's
// HEAD still carried them.
//
// That is not hypothetical: it is how an auditor's approval disappeared between
// being recorded and the release gate being asked for it.
//
// A per-BP apply no longer has a working tree to get this wrong with: it reads
// the one file it needs out of the pushed commit. The materialize tests below
// cover the legacy whole-workspace repo, which still has to rebuild a tree
// because there the push really does carry one.

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// pushedWorkspace builds the real shape: a bare repo the driver received a push
// into, and gitops's own working tree that pushed it. Returns the bare repo, the
// work tree, and the pushed sha.
func pushedWorkspace(t *testing.T) (bare, work, pushed string) {
	t.Helper()
	root := t.TempDir()
	bare = filepath.Join(root, "deploy.git")
	work = filepath.Join(root, "work")
	if err := os.MkdirAll(work, 0o755); err != nil {
		t.Fatal(err)
	}
	git(t, root, "init", "--bare", "-b", "main", bare)
	git(t, work, "init", "-b", "main")
	write(t, filepath.Join(work, "bitswan.yaml"), "deployments: {}\n")
	git(t, work, "add", "-A")
	git(t, work, "commit", "-m", "deploy")
	git(t, work, "push", bare, "HEAD:refs/heads/main")
	pushed = trim(git(t, work, "rev-parse", "HEAD"))
	return bare, work, pushed
}

func trim(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r') {
		s = s[:len(s)-1]
	}
	return s
}

func TestMaterializeKeepsWhatGitopsCommittedAfterThePush(t *testing.T) {
	bare, work, pushed := pushedWorkspace(t)

	// gitops records an audit sign-off while this apply is still queued.
	write(t, filepath.Join(work, "bitswan.yaml"), "deployments: {}\naudits:\n  invoices: approved\n")
	git(t, work, "add", "-A")
	git(t, work, "commit", "-m", "audit")

	if err := materialize(bare, pushed, work); err != nil {
		t.Fatalf("materialize: %v", err)
	}

	got, err := os.ReadFile(filepath.Join(work, "bitswan.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "approved") {
		t.Fatalf("the sign-off was reverted by the apply; file is now:\n%s", got)
	}
}

func TestMaterializeStillMirrorsThePushedTreeWhenGitopsHasNotMoved(t *testing.T) {
	bare, work, pushed := pushedWorkspace(t)

	// A leftover file the push does not contain must still be cleared: the
	// mirror-exactly property is what makes a deletion in the push take effect.
	write(t, filepath.Join(work, "stale.yaml"), "gone\n")

	if err := materialize(bare, pushed, work); err != nil {
		t.Fatalf("materialize: %v", err)
	}
	if _, err := os.Stat(filepath.Join(work, "stale.yaml")); err == nil {
		t.Fatal("an untracked leftover survived the materialise")
	}
	if _, err := os.Stat(filepath.Join(work, ".git")); err != nil {
		t.Fatal("the working repo was destroyed")
	}
}

// A commit that is not a descendant of the pushed ref is not "newer" — it is a
// divergence, and the push is what the driver was asked to apply.
func TestMaterializeIgnoresAnUnrelatedLocalCommit(t *testing.T) {
	bare, work, pushed := pushedWorkspace(t)

	git(t, work, "checkout", "-q", "-b", "sideline", pushed+"^{commit}")
	git(t, work, "checkout", "-q", "--orphan", "unrelated")
	write(t, filepath.Join(work, "bitswan.yaml"), "deployments: {}\nunrelated: true\n")
	git(t, work, "add", "-A")
	git(t, work, "commit", "-m", "unrelated history")

	if err := materialize(bare, pushed, work); err != nil {
		t.Fatalf("materialize: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(work, "bitswan.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(got), "unrelated") {
		t.Fatal("an unrelated history won over the tree the driver was asked to apply")
	}
}

// The per-BP path: a commit is immutable, so it does not matter how long the
// apply waited — and the working tree it never reads is also a working tree it
// cannot damage.
func TestShowPushedFileReadsTheCommitAndLeavesTheWorktreeAlone(t *testing.T) {
	bare, work, pushed := pushedWorkspace(t)

	// gitops records an audit sign-off while this apply is still queued.
	const withSignoff = "deployments: {}\naudits:\n  invoices: approved\n"
	write(t, filepath.Join(work, "bitswan.yaml"), withSignoff)
	git(t, work, "add", "-A")
	git(t, work, "commit", "-m", "audit")

	got, err := showPushedFile(bare, pushed, "bitswan.yaml")
	if err != nil {
		t.Fatalf("showPushedFile: %v", err)
	}
	// The apply deploys what was pushed, not what happened to be on disk when it
	// finally got the lock.
	if strings.Contains(string(got), "approved") {
		t.Fatalf("read the working tree instead of the pushed commit:\n%s", got)
	}
	if !strings.Contains(string(got), "deployments") {
		t.Fatalf("did not read the pushed bitswan.yaml:\n%s", got)
	}

	// And the sign-off is still there afterwards, which is the whole point.
	onDisk, err := os.ReadFile(filepath.Join(work, "bitswan.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if string(onDisk) != withSignoff {
		t.Fatalf("the apply disturbed gitops's working tree:\n%s", onDisk)
	}
}

func TestShowPushedFileSaysWhichFileIsMissing(t *testing.T) {
	bare, _, pushed := pushedWorkspace(t)
	_, err := showPushedFile(bare, pushed, "not-there.yaml")
	if err == nil {
		t.Fatal("a missing file was not reported")
	}
	if !strings.Contains(err.Error(), "not-there.yaml") {
		t.Fatalf("the error does not name the file: %v", err)
	}
}

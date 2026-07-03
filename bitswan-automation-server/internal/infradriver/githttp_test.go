package infradriver

import (
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// TestGitSmartHTTPPushRunsHook is the transport contract: gitops pushes the
// resolved bitswan.yaml over git smart-HTTP and the deploy repo's post-receive
// hook fires IN THE DRIVER (the whole reason this is HTTP, not a file:// push).
// It also asserts the shared token guards the push.
func TestGitSmartHTTPPushRunsHook(t *testing.T) {
	if _, err := os.Stat(gitHTTPBackend); err != nil {
		t.Skipf("git-http-backend not present: %v", err)
	}
	root := t.TempDir()
	bare := filepath.Join(root, "deploy.git")
	mustGit(t, "", "init", "--bare", bare)
	mustGit(t, bare, "config", "http.receivepack", "true")

	// A post-receive hook that records that it ran (stands in for `infra-driver
	// apply`). Proves the hook executes server-side on push.
	marker := filepath.Join(root, "applied")
	hook := "#!/bin/sh\necho applied > " + marker + "\n"
	if err := os.WriteFile(filepath.Join(bare, "hooks", "post-receive"), []byte(hook), 0o755); err != nil {
		t.Fatal(err)
	}

	srv := httptest.NewServer((&Server{GitProjectRoot: root, Token: "s3cret"}).Handler())
	defer srv.Close()
	repoURL := func(tok string) string {
		// git sends the Basic password as the token (gitops's push URL form).
		return "http://x:" + tok + "@" + srv.Listener.Addr().String() + "/deploy.git"
	}

	// A local work repo with one commit to push.
	work := filepath.Join(root, "work")
	mustGit(t, "", "init", work)
	gitEnv := []string{"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e", "GIT_TERMINAL_PROMPT=0"}
	if err := os.WriteFile(filepath.Join(work, "bitswan.yaml"), []byte("deployments: {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustGitEnv(t, work, gitEnv, "add", "-A")
	mustGitEnv(t, work, gitEnv, "commit", "-m", "init")

	// Wrong token: push must be rejected and the hook must NOT run.
	if err := gitErr(work, gitEnv, "push", repoURL("wrong"), "HEAD:refs/heads/main"); err == nil {
		t.Fatal("push with wrong token unexpectedly succeeded")
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("hook ran for an unauthorized push")
	}

	// Correct token: push succeeds and the post-receive hook fires.
	mustGitEnv(t, work, gitEnv, "push", repoURL("s3cret"), "HEAD:refs/heads/main")
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("post-receive hook did not run on authorized push: %v", err)
	}
}

func mustGit(t *testing.T, dir string, args ...string) { mustGitEnv(t, dir, nil, args...) }

func mustGitEnv(t *testing.T, dir string, env []string, args ...string) {
	t.Helper()
	if err := gitErr(dir, env, args...); err != nil {
		t.Fatalf("git %v: %v", args, err)
	}
}

func gitErr(dir string, env []string, args ...string) error {
	cmd := exec.Command("git", args...)
	if dir != "" {
		cmd.Dir = dir
	}
	if env != nil {
		cmd.Env = append(os.Environ(), env...)
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return &gitError{args: args, out: string(out), err: err}
	}
	return nil
}

type gitError struct {
	args []string
	out  string
	err  error
}

func (e *gitError) Error() string { return e.err.Error() + ": " + e.out }

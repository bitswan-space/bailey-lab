package infradriver

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// isolateSystemGitConfig points `git config --system` (used by
// ensureDeployRepoAt for safe.directory) at a throwaway file, so the tests pass
// as a non-root CI user that can't write /etc/gitconfig. In production the
// driver runs as root and writes the real system config.
func isolateSystemGitConfig(t *testing.T) {
	t.Helper()
	t.Setenv("GIT_CONFIG_SYSTEM", filepath.Join(t.TempDir(), "gitconfig"))
}

func gitCfg(t *testing.T, gitDir, key string) string {
	t.Helper()
	out, err := exec.Command("git", "--git-dir", gitDir, "config", "--get", key).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// A per-BP deploy repo is provisioned as a bare repo whose git-config records
// bitswan.bp (so the hook applies only that BP) alongside the workspace context,
// with the post-receive apply hook installed. Idempotent.
func TestEnsureDeployRepoAt_PerBP(t *testing.T) {
	isolateSystemGitConfig(t)
	reposDir := t.TempDir()
	cf := ctxFlags{workspace: "ws1", domain: "d.example", secretsDir: "/s", gitopsDir: "/gitops/gitops"}
	gitDir := deployRepoDirFor(reposDir, "issues")

	for i := 0; i < 2; i++ { // twice → idempotent
		if err := ensureDeployRepoAt(gitDir, "issues", cf); err != nil {
			t.Fatalf("ensureDeployRepoAt (pass %d): %v", i, err)
		}
	}

	if _, err := os.Stat(filepath.Join(gitDir, "HEAD")); err != nil {
		t.Fatalf("bare repo not created: %v", err)
	}
	if got := gitCfg(t, gitDir, "bitswan.bp"); got != "issues" {
		t.Errorf("bitswan.bp = %q, want issues", got)
	}
	if got := gitCfg(t, gitDir, "bitswan.workspace"); got != "ws1" {
		t.Errorf("bitswan.workspace = %q, want ws1", got)
	}
	if got := gitCfg(t, gitDir, "bitswan.gitopsdir"); got != "/gitops/gitops" {
		t.Errorf("bitswan.gitopsdir = %q, want /gitops/gitops", got)
	}
	if got := gitCfg(t, gitDir, "receive.denyNonFastForwards"); got != "true" {
		t.Errorf("denyNonFastForwards = %q, want true", got)
	}
	hook, err := os.ReadFile(filepath.Join(gitDir, "hooks", "post-receive"))
	if err != nil {
		t.Fatalf("post-receive hook missing: %v", err)
	}
	if !strings.Contains(string(hook), "infra-driver apply --git-dir") {
		t.Errorf("hook does not invoke apply: %q", hook)
	}
	if !strings.Contains(string(hook), gitDir) {
		t.Errorf("hook does not target this repo: %q", hook)
	}
}

// The legacy whole-workspace repo carries NO bitswan.bp (so apply stays
// whole-workspace).
func TestEnsureBareRepo_LegacyHasNoBP(t *testing.T) {
	isolateSystemGitConfig(t)
	gitDir := filepath.Join(t.TempDir(), "deploy.git")
	if err := ensureBareRepo(gitDir, ctxFlags{workspace: "ws1"}); err != nil {
		t.Fatalf("ensureBareRepo: %v", err)
	}
	if got := gitCfg(t, gitDir, "bitswan.bp"); got != "" {
		t.Errorf("legacy repo has bitswan.bp = %q, want empty", got)
	}
}

// serve startup provisions every existing <bp>.deploy.git and skips non-repo
// entries.
func TestEnsureAllDeployRepos(t *testing.T) {
	isolateSystemGitConfig(t)
	reposDir := t.TempDir()
	for _, bp := range []string{"issues", "invoices"} {
		if err := os.MkdirAll(deployRepoDirFor(reposDir, bp), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := ensureAllDeployRepos(reposDir, ctxFlags{workspace: "ws1", gitopsDir: "/gitops/gitops"}); err != nil {
		t.Fatalf("ensureAllDeployRepos: %v", err)
	}
	for _, bp := range []string{"issues", "invoices"} {
		gitDir := deployRepoDirFor(reposDir, bp)
		if _, err := os.Stat(filepath.Join(gitDir, "HEAD")); err != nil {
			t.Errorf("%s not initialized: %v", bp, err)
		}
		if got := gitCfg(t, gitDir, "bitswan.bp"); got != bp {
			t.Errorf("%s bitswan.bp = %q", bp, got)
		}
	}
}

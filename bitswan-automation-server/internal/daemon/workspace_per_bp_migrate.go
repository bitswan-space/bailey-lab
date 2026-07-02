package daemon

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Fresh-start migration from the single shared workspace repo to one git repo
// per business process.
//
// Old layout: one canonical bare repo (repo.git) + whole-repo clones at
// copies/<name> (BPs are subdirectories inside each clone).
// New layout: one bare repo per BP (git-repos/<bp>.git) + per-BP clones at
// copies/<name>/<bp> on branch <name>; the copy root is a plain directory.
//
// "Fresh start" (user-confirmed): no history is carried over. Each BP repo's
// main starts with an empty seed commit + ONE import commit of the main
// copy's current tree; each other copy's branch carries ONE import commit of
// that copy's current tree — so uncommitted/unsynced work is preserved as
// CONTENT, not history. The old repo.git is archived on the volume (renamed,
// never served) for forensics.

// gitRunner runs a shell command in a directory. Production uses user1000 via
// `su` (the repos/copies are owned by uid 1000 and git refuses cross-owner
// repos); tests inject a plain runner.
type gitRunner func(dir, cmd string) (string, error)

func user1000Runner(verbose bool) gitRunner {
	return func(dir, cmd string) (string, error) {
		c := exec.Command("su", "-s", "/bin/sh", "user1000", "-c", cmd) //nolint:gosec
		c.Dir = dir
		out, err := c.CombinedOutput()
		if verbose || err != nil {
			fmt.Printf("[per-bp-migrate] (%s) %s\n%s", dir, cmd, string(out))
		}
		return strings.TrimSpace(string(out)), err
	}
}

const perBPMigratedMarker = ".per-bp-repos-migrated"

// mechanical committer identity for migration commits.
const migGitIdent = "-c user.name=Bailey -c user.email=bailey@bitswan"

// listSubdirs returns non-hidden directory names under path (empty when the
// path doesn't exist).
func listSubdirs(path string) []string {
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
			out = append(out, e.Name())
		}
	}
	return out
}

// ensureMigBareRepo creates git-repos/<bp>.git with an empty seed commit on
// main (idempotent), mirroring gitops's ensure_bp_bare_repo. Hooks/ff config
// are installed by the NEW gitops at its next startup (ensure_all_bp_repos) —
// at migration time nothing serves these repos yet.
func ensureMigBareRepo(run gitRunner, reposDir, bp string) (string, error) {
	bare := filepath.Join(reposDir, bp+".git")
	if _, err := os.Stat(filepath.Join(bare, "objects")); err != nil {
		if _, err := run(reposDir, fmt.Sprintf("git init --bare --initial-branch=main %q", bare)); err != nil {
			return "", fmt.Errorf("init bare for %s: %w", bp, err)
		}
	}
	if _, err := run(bare, "git rev-parse --verify refs/heads/main"); err != nil {
		seed := fmt.Sprintf(
			`tree=$(git hash-object -t tree -w /dev/null) && commit=$(git %s commit-tree "$tree" -m %q) && git update-ref refs/heads/main "$commit"`,
			migGitIdent, "Initialize business process "+bp,
		)
		if _, err := run(bare, seed); err != nil {
			return "", fmt.Errorf("seed main for %s: %w", bp, err)
		}
	}
	return bare, nil
}

// importTreeAsBranch clones `bare` into a staging dir, replaces the checkout's
// tree with the CONTENT of srcDir (excluding any .git), commits, and publishes
// the result as `branch` (direct push — no hook exists at migration time).
// Branching starts from startPoint (origin/main for copy branches).
func importTreeAsBranch(run gitRunner, stagingRoot, bare, srcDir, branch, msg string) error {
	tmp := filepath.Join(stagingRoot, "import-"+branch+"-"+filepath.Base(srcDir))
	_ = os.RemoveAll(tmp)
	if _, err := run(stagingRoot, fmt.Sprintf("git clone -q %q %q", bare, tmp)); err != nil {
		return fmt.Errorf("clone: %w", err)
	}
	defer os.RemoveAll(tmp)
	if branch != "main" {
		if _, err := run(tmp, fmt.Sprintf("git checkout -q -b %q origin/main", branch)); err != nil {
			return fmt.Errorf("branch: %w", err)
		}
	}
	// Replace the tracked tree with srcDir's current content: clear everything
	// except .git, then tar-copy the source in (preserves symlinks/modes).
	if _, err := run(tmp, `find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +`); err != nil {
		return fmt.Errorf("clear staging tree: %w", err)
	}
	copyCmd := fmt.Sprintf(`cd %q && tar --exclude=./.git -cf - . | (cd %q && tar -xf -)`, srcDir, tmp)
	if _, err := run(stagingRoot, copyCmd); err != nil {
		return fmt.Errorf("copy tree: %w", err)
	}
	if _, err := run(tmp, "git add -A"); err != nil {
		return fmt.Errorf("stage: %w", err)
	}
	if _, err := run(tmp, "git diff --cached --quiet"); err != nil {
		// Non-zero exit = staged changes exist → commit them.
		if _, err := run(tmp, fmt.Sprintf("git %s commit -q -m %q", migGitIdent, msg)); err != nil {
			return fmt.Errorf("commit: %w", err)
		}
	}
	if _, err := run(tmp, fmt.Sprintf("git push -q %q HEAD:refs/heads/%s", bare, branch)); err != nil {
		return fmt.Errorf("publish %s: %w", branch, err)
	}
	return nil
}

// cloneSwapBPDir converts copies/<copy>/<bp> in place: the plain dir (or old
// shared-clone subtree) becomes a real clone of the BP's bare on `branch`,
// with every untracked/ignored file the old dir had copied back (live-dev
// containers bind-mount paths inside — build artifacts and virtualenvs must
// survive). Any content that changed between import and swap is committed and
// pushed so nothing is lost.
func cloneSwapBPDir(run gitRunner, wsName, copyDir, bp, bare, branch string) error {
	bpDir := filepath.Join(copyDir, bp)
	if fi, err := os.Stat(filepath.Join(bpDir, ".git")); err == nil && fi.IsDir() {
		if url, err := run(bpDir, "git remote get-url origin"); err == nil &&
			strings.HasSuffix(strings.TrimSpace(url), "/"+bp+".git") {
			return nil // already converted (idempotent re-run)
		}
	}
	staging := bpDir + ".migrating"
	_ = os.RemoveAll(staging)
	if err := os.Rename(bpDir, staging); err != nil {
		return fmt.Errorf("stage aside: %w", err)
	}
	if _, err := run(copyDir, fmt.Sprintf("git clone -q -b %q %q %q", branch, bare, bpDir)); err != nil {
		// Restore the original dir on failure so a retry starts clean.
		_ = os.RemoveAll(bpDir)
		_ = os.Rename(staging, bpDir)
		return fmt.Errorf("clone-swap: %w", err)
	}
	// Copy back anything the clone lacks (untracked artifacts). Tracked files
	// are identical (the import commit was taken from this very tree moments
	// ago); --skip-old-files keeps them and adds only what's missing.
	backfill := fmt.Sprintf(`cd %q && tar --exclude=./.git -cf - . | (cd %q && tar -xf - --skip-old-files)`, staging, bpDir)
	if _, err := run(copyDir, backfill); err != nil {
		return fmt.Errorf("backfill untracked: %w", err)
	}
	remote := fmt.Sprintf("http://%s-gitops:8079/git/%s.git", wsName, bp)
	_, _ = run(bpDir, fmt.Sprintf("git remote set-url origin %q", remote))
	// If live containers wrote tracked-path changes during the window, keep
	// them: commit + publish (direct push; hooks arrive with the new gitops).
	if out, err := run(bpDir, "git status --porcelain"); err == nil && strings.TrimSpace(out) != "" {
		_, _ = run(bpDir, "git add -A")
		_, _ = run(bpDir, fmt.Sprintf("git %s commit -q -m %q", migGitIdent, "Post-migration adjustments"))
		_, _ = run(bpDir, fmt.Sprintf("git push -q %q HEAD:refs/heads/%s", bare, branch))
	}
	return os.RemoveAll(staging)
}

// migrateToPerBPRepos performs the fresh-start migration for one workspace.
// Marker-guarded and idempotent per sub-step: a mid-failure leaves no marker
// and is retried on the next daemon start.
func migrateToPerBPRepos(wsName, wsDir string, run gitRunner) error {
	marker := filepath.Join(wsDir, perBPMigratedMarker)
	if _, err := os.Stat(marker); err == nil {
		return nil
	}
	reposDir := filepath.Join(wsDir, "git-repos")
	copiesDir := filepath.Join(wsDir, "copies")
	mainCopy := filepath.Join(copiesDir, "main")

	if err := os.MkdirAll(reposDir, 0o755); err != nil {
		return err
	}
	// The runner's user must be able to write here (and into the staging dir).
	_ = exec.Command("chown", "1000:1000", reposDir).Run()
	stagingRoot := filepath.Join(wsDir, ".per-bp-migrate")
	if err := os.MkdirAll(stagingRoot, 0o755); err != nil {
		return err
	}
	_ = exec.Command("chown", "1000:1000", stagingRoot).Run()
	defer os.RemoveAll(stagingRoot)

	// 1) Import every BP under the main copy into its own repo's main.
	for _, bp := range listSubdirs(mainCopy) {
		bare, err := ensureMigBareRepo(run, reposDir, bp)
		if err != nil {
			return err
		}
		// Skip the import when main already carries content (idempotent
		// re-run after a partial failure).
		if out, err := run(bare, "git ls-tree main"); err != nil || strings.TrimSpace(out) == "" {
			if err := importTreeAsBranch(
				run, stagingRoot, bare, filepath.Join(mainCopy, bp), "main",
				"Import "+bp+" from shared workspace repo",
			); err != nil {
				return fmt.Errorf("import main/%s: %w", bp, err)
			}
		}
	}

	// 2) Import every other copy's per-BP tree as branch <copy>.
	for _, copyName := range listSubdirs(copiesDir) {
		if copyName == "main" {
			continue
		}
		copyDir := filepath.Join(copiesDir, copyName)
		for _, bp := range listSubdirs(copyDir) {
			bare, err := ensureMigBareRepo(run, reposDir, bp)
			if err != nil {
				return err
			}
			if _, err := run(bare, fmt.Sprintf("git rev-parse --verify refs/heads/%s", copyName)); err == nil {
				continue // branch already imported
			}
			if err := importTreeAsBranch(
				run, stagingRoot, bare, filepath.Join(copyDir, bp), copyName,
				fmt.Sprintf("Import copy %s state of %s", copyName, bp),
			); err != nil {
				return fmt.Errorf("import %s/%s: %w", copyName, bp, err)
			}
		}
	}

	// 3) Convert the on-disk copies in place (the main copy included): drop
	// the copy-root .git (the old whole-repo clone) and clone-swap every BP
	// dir onto its per-BP repo — branch main for the main copy, <copy>
	// otherwise.
	for _, copyName := range listSubdirs(copiesDir) {
		copyDir := filepath.Join(copiesDir, copyName)
		branch := copyName
		if copyName == "main" {
			branch = "main"
		}
		for _, bp := range listSubdirs(copyDir) {
			bare := filepath.Join(reposDir, bp+".git")
			if err := cloneSwapBPDir(run, wsName, copyDir, bp, bare, branch); err != nil {
				return fmt.Errorf("convert %s/%s: %w", copyName, bp, err)
			}
		}
		// The copy root stops being a git repo — remove the old shared clone's
		// .git AFTER the swaps (the imports above read only the worktrees).
		_ = os.RemoveAll(filepath.Join(copyDir, ".git"))
	}

	// 4) Archive the legacy canonical repo — never served again. An empty
	// repo.git dir is recreated so stale composes with the old subpath mount
	// still start until they're regenerated.
	legacy := filepath.Join(wsDir, "repo.git")
	if _, err := os.Stat(filepath.Join(legacy, "objects")); err == nil {
		archived := fmt.Sprintf("%s.archived-%s", legacy, time.Now().UTC().Format("20060102-150405"))
		if err := os.Rename(legacy, archived); err != nil {
			return fmt.Errorf("archive legacy repo: %w", err)
		}
		_ = os.MkdirAll(legacy, 0o755)
	}

	// 5) Ownership for the gitops/editor containers (uid 1000).
	_ = exec.Command("chown", "-R", "1000:1000", reposDir, copiesDir).Run()

	return os.WriteFile(marker, []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0o644)
}

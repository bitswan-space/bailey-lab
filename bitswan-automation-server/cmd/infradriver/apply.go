package infradriver

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver/dockerdriver"
	"github.com/spf13/cobra"
)

// newApplyCmd is the post-receive entry point: check out the pushed tree, read
// bitswan.yaml + the recorded workspace context, and run the Docker compiler.
// Its stdout is the apply progress, which git relays to the pushing client (so
// gitops can forward it to the dashboard).
func newApplyCmd() *cobra.Command {
	var gitDir string
	cmd := &cobra.Command{
		Use:   "apply",
		Short: "Compile + apply the pushed bitswan.yaml (run by the post-receive hook)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if gitDir == "" {
				return fmt.Errorf("--git-dir is required")
			}
			gitopsDir := gitConfig(gitDir, "bitswan.gitopsdir")
			if gitopsDir == "" {
				return fmt.Errorf("bitswan.gitopsdir not configured on %s", gitDir)
			}
			ref := pushedRef() // post-receive feeds "<old> <new> <ref>" on stdin
			// Materialize the pushed tree into the gitops volume dir — the
			// authoritative deployed tree the generated compose bind-mounts
			// reference (workspaces/<ws>/gitops/<source>). It must mirror the push
			// exactly (deletions included), so the dir is rebuilt from the archive.
			if err := materialize(gitDir, ref, gitopsDir); err != nil {
				return err
			}

			yamlBytes, err := os.ReadFile(gitopsDir + "/bitswan.yaml")
			if err != nil {
				return fmt.Errorf("read bitswan.yaml from push: %w", err)
			}
			wctx := infradriver.WorkspaceContext{
				WorkspaceName: gitConfig(gitDir, "bitswan.workspace"),
				Domain:        gitConfig(gitDir, "bitswan.domain"),
				GitopsDir:     gitopsDir,
				SecretsDir:    gitConfig(gitDir, "bitswan.secretsdir"),
				WrapAvailable: gitConfig(gitDir, "bitswan.wrap") == "true",
			}
			// The driver configures ingress itself inside Apply (k8s-style: the
			// applier owns the Ingress), so the returned routes are informational —
			// log a one-line summary for the push output, not a contract.
			routes, err := dockerdriver.New(wctx.WorkspaceName).Apply(cmd.Context(),
				infradriver.ApplyRequest{Ctx: wctx, BitswanYAML: string(yamlBytes)},
				func(p infradriver.Progress) { fmt.Printf("[%s] %s\n", p.Step, p.Message) })
			if err != nil {
				return err
			}
			fmt.Printf("[done] applied %d ingress route(s)\n", len(routes))
			return nil
		},
	}
	cmd.Flags().StringVar(&gitDir, "git-dir", "", "the bare repo that received the push")
	return cmd
}

// pushedRef reads the updated ref from the post-receive stdin protocol
// ("<old-sha> <new-sha> <refname>"), falling back to HEAD for manual runs.
func pushedRef() string {
	fi, err := os.Stdin.Stat()
	if err != nil || (fi.Mode()&os.ModeCharDevice) != 0 {
		return "HEAD" // no piped stdin (manual invocation)
	}
	sc := bufio.NewScanner(os.Stdin)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) == 3 && fields[1] != strings.Repeat("0", 40) {
			return fields[1] // the new sha
		}
	}
	return "HEAD"
}

// materialize rebuilds dest to mirror the pushed ref's tree exactly: it clears
// dest's contents (dest is the gitops volume subpath mount point, so the mount
// itself is kept) and extracts the ref via `git archive | tar`. Deletions in
// the push are reflected because dest is cleared first. dest holds only
// deploy-managed content (bitswan.yaml + source trees + the generated
// docker-compose.yaml); secrets/snapshots/firewall are separate volume subpaths
// mounted elsewhere, so clearing dest never touches them.
//
// CRITICAL: dest is gitops's OWN git working tree (it commits bitswan.yaml there
// and pushes HEAD to us), so .git is PRESERVED — wiping it would destroy gitops's
// repo. The pushed tree's content matches what gitops just committed, so keeping
// .git and refreshing the worktree is consistent.
func materialize(gitDir, ref, dest string) error {
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	if err := clearDir(dest); err != nil {
		return fmt.Errorf("clear gitops dir %s: %w", dest, err)
	}
	archive := exec.Command("git", "--git-dir", gitDir, "archive", ref)
	untar := exec.Command("tar", "-x", "-C", dest)
	pipe, err := archive.StdoutPipe()
	if err != nil {
		return err
	}
	untar.Stdin = pipe
	if err := untar.Start(); err != nil {
		return err
	}
	if err := archive.Run(); err != nil {
		return fmt.Errorf("git archive %s: %w", ref, err)
	}
	if err := untar.Wait(); err != nil {
		return fmt.Errorf("untar push into %s: %w", dest, err)
	}
	return nil
}

// clearDir removes every entry inside dir, keeping dir itself (a volume mount)
// AND .git (gitops's working repo lives here — see materialize).
func clearDir(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.Name() == ".git" {
			continue // preserve gitops's git repo
		}
		if err := os.RemoveAll(filepath.Join(dir, e.Name())); err != nil {
			return err
		}
	}
	return nil
}

func gitConfig(gitDir, key string) string {
	out, err := exec.Command("git", "--git-dir", gitDir, "config", "--get", key).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

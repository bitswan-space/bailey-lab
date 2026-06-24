package infradriver

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
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
			ref := pushedRef() // post-receive feeds "<old> <new> <ref>" on stdin
			work, cleanup, err := checkout(gitDir, ref)
			if err != nil {
				return err
			}
			defer cleanup()

			yamlBytes, err := os.ReadFile(work + "/bitswan.yaml")
			if err != nil {
				return fmt.Errorf("read bitswan.yaml from push: %w", err)
			}
			wctx := infradriver.WorkspaceContext{
				WorkspaceName: gitConfig(gitDir, "bitswan.workspace"),
				Domain:        gitConfig(gitDir, "bitswan.domain"),
				GitopsDir:     work,
				SecretsDir:    gitConfig(gitDir, "bitswan.secretsdir"),
				WrapAvailable: gitConfig(gitDir, "bitswan.wrap") == "true",
			}
			_, err = dockerdriver.New().Apply(cmd.Context(),
				infradriver.ApplyRequest{Ctx: wctx, BitswanYAML: string(yamlBytes)},
				func(p infradriver.Progress) { fmt.Printf("[%s] %s\n", p.Step, p.Message) })
			return err
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

// checkout materializes a ref's tree into a temp dir via `git archive`.
func checkout(gitDir, ref string) (string, func(), error) {
	work, err := os.MkdirTemp("", "infra-apply-")
	if err != nil {
		return "", func() {}, err
	}
	cleanup := func() { _ = os.RemoveAll(work) }
	archive := exec.Command("git", "--git-dir", gitDir, "archive", ref)
	untar := exec.Command("tar", "-x", "-C", work)
	pipe, err := archive.StdoutPipe()
	if err != nil {
		cleanup()
		return "", func() {}, err
	}
	untar.Stdin = pipe
	if err := untar.Start(); err != nil {
		cleanup()
		return "", func() {}, err
	}
	if err := archive.Run(); err != nil {
		cleanup()
		return "", func() {}, fmt.Errorf("git archive %s: %w", ref, err)
	}
	if err := untar.Wait(); err != nil {
		cleanup()
		return "", func() {}, fmt.Errorf("untar push: %w", err)
	}
	return work, cleanup, nil
}

func gitConfig(gitDir, key string) string {
	out, err := exec.Command("git", "--git-dir", gitDir, "config", "--get", key).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

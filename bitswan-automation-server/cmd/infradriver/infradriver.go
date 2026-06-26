// Package infradriver provides the `bitswan infra-driver` subcommands: a
// per-workspace driver that (a) hosts a bare git remote whose post-receive hook
// compiles + applies the pushed bitswan.yaml, and (b) serves the operational
// container primitives + build-image over a private UNIX socket. See
// internal/infradriver/README.md for the architecture.
package infradriver

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver"
	"github.com/bitswan-space/bitswan-workspaces/internal/infradriver/dockerdriver"
	"github.com/spf13/cobra"
)

// NewInfraDriverCmd is the `infra-driver` command group.
func NewInfraDriverCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "infra-driver",
		Short: "Per-workspace infrastructure driver (git-push apply + container primitives)",
	}
	cmd.AddCommand(newServeCmd())
	cmd.AddCommand(newApplyCmd())
	return cmd
}

// ctxFlags holds the WorkspaceContext supplied to serve and recorded in the
// bare repo's git config so the post-receive `apply` can read it back.
type ctxFlags struct {
	workspace  string
	domain     string
	secretsDir string
	gitopsDir  string
	wrap       bool
}

func (f *ctxFlags) bind(cmd *cobra.Command) {
	cmd.Flags().StringVar(&f.workspace, "workspace", "", "workspace name")
	cmd.Flags().StringVar(&f.domain, "domain", "", "workspace domain")
	cmd.Flags().StringVar(&f.secretsDir, "secrets-dir", "", "shared secrets volume path")
	cmd.Flags().StringVar(&f.gitopsDir, "gitops-dir", "", "gitops volume dir the push is materialized into (the deployed tree the compose binds reference)")
	cmd.Flags().BoolVar(&f.wrap, "wrap", false, "protected-proxy present (wrap topology)")
}

func newServeCmd() *cobra.Command {
	var (
		listen string
		gitDir string
		token  string
		cf     ctxFlags
	)
	cmd := &cobra.Command{
		Use:   "serve",
		Short: "Host the deploy git remote (smart-HTTP) + container primitives over TCP",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if listen == "" || gitDir == "" {
				return fmt.Errorf("--listen and --git-dir are required")
			}
			if token == "" {
				token = os.Getenv("BITSWAN_INFRA_DRIVER_TOKEN")
			}
			// Fail loudly rather than serve open: the driver holds docker.sock,
			// so an unauthenticated serve would expose host-equivalent power. An
			// empty token must never silently disable the guard.
			if token == "" {
				return fmt.Errorf("no driver token configured (set --token or BITSWAN_INFRA_DRIVER_TOKEN); refusing to serve without authentication")
			}
			if err := ensureBareRepo(gitDir, cf); err != nil {
				return err
			}
			return serveHTTP(cmd.Context(), listen, gitDir, token, cf.workspace)
		},
	}
	cmd.Flags().StringVar(&listen, "listen", "", "TCP address to serve git smart-HTTP + the primitive API on (e.g. :9090)")
	cmd.Flags().StringVar(&gitDir, "git-dir", "", "bare git repo to host (post-receive applies on push)")
	cmd.Flags().StringVar(&token, "token", "", "shared bearer token guarding every endpoint (defaults to $BITSWAN_INFRA_DRIVER_TOKEN)")
	cf.bind(cmd)
	return cmd
}

// ensureBareRepo creates the bare repo if missing, records the workspace
// context in its git config, and installs the post-receive hook that runs
// `bitswan infra-driver apply`.
func ensureBareRepo(gitDir string, cf ctxFlags) error {
	// The deploy repo lives on the workspace volume (owned by user1000) but the
	// driver runs as root, so every git op (init, http-backend receive-pack, the
	// apply hook's archive) trips git's "dubious ownership" guard and fails. Mark
	// all repos safe in SYSTEM config (/etc/gitconfig) — not --global, because the
	// git-http-backend CGI child does not inherit HOME and so never reads
	// ~/.gitconfig; system config is read regardless of HOME. (The CGI handler
	// also injects this via GIT_CONFIG_* env as a belt-and-suspenders.)
	if out, err := exec.Command("git", "config", "--system", "--add", "safe.directory", "*").CombinedOutput(); err != nil {
		return fmt.Errorf("git config safe.directory: %w: %s", err, out)
	}
	if _, err := os.Stat(filepath.Join(gitDir, "HEAD")); os.IsNotExist(err) {
		if out, err := exec.Command("git", "init", "--bare", gitDir).CombinedOutput(); err != nil {
			return fmt.Errorf("git init --bare: %w: %s", err, out)
		}
	}
	// gitops pushes to refs/heads/main, but `git init --bare` points HEAD at
	// init.defaultBranch (often 'master'). The post-receive hook's apply reads
	// the pushed tree via `git archive HEAD`, so a HEAD that doesn't track the
	// branch gitops pushes resolves to an unborn ref and every deploy fails with
	// "git archive HEAD: exit status 128". Pin HEAD to main (idempotent, every
	// serve) so the apply always sees the deployed tree.
	if out, err := exec.Command("git", "--git-dir", gitDir, "symbolic-ref", "HEAD", "refs/heads/main").CombinedOutput(); err != nil {
		return fmt.Errorf("git symbolic-ref HEAD main: %w: %s", err, out)
	}
	// Record the context so the hook can rebuild it without flags.
	for k, v := range map[string]string{
		"bitswan.workspace":  cf.workspace,
		"bitswan.domain":     cf.domain,
		"bitswan.secretsdir": cf.secretsDir,
		"bitswan.gitopsdir":  cf.gitopsDir,
		"bitswan.wrap":       fmt.Sprintf("%t", cf.wrap),
		// git-http-backend refuses receive-pack (push) unless this is set.
		"http.receivepack": "true",
		// Forbid force-push and ref deletion server-side: the deploy history is
		// the authoritative record of what was deployed, and a non-fast-forward
		// push would rewrite/clobber it. Enforced at the repo regardless of what
		// any client sends — `git push --force` is rejected here, not just absent
		// from our own client. Deploys are always roll-FORWARD (a rollback is a
		// new commit that restores a prior tree), so this never blocks a deploy.
		"receive.denyNonFastForwards": "true",
		"receive.denyDeletes":         "true",
	} {
		if err := exec.Command("git", "--git-dir", gitDir, "config", k, v).Run(); err != nil {
			return fmt.Errorf("git config %s: %w", k, err)
		}
	}
	self, err := os.Executable()
	if err != nil {
		self = "bitswan"
	}
	hook := fmt.Sprintf("#!/bin/sh\nexec %q infra-driver apply --git-dir %q\n", self, gitDir)
	hookPath := filepath.Join(gitDir, "hooks", "post-receive")
	if err := os.WriteFile(hookPath, []byte(hook), 0o755); err != nil {
		return fmt.Errorf("write post-receive hook: %w", err)
	}
	return nil
}

// serveHTTP serves the driver over TCP until the context is cancelled: git
// smart-HTTP for the deploy repo (gitops pushes here; post-receive applies) plus
// the build-image + container primitives, all guarded by the shared token.
func serveHTTP(ctx context.Context, listen, gitDir, token, workspace string) error {
	ln, err := net.Listen("tcp", listen)
	if err != nil {
		return fmt.Errorf("listen %s: %w", listen, err)
	}
	// The driver is scoped to its workspace: container primitives refuse any
	// container not labelled gitops.workspace=<workspace>.
	server := infradriver.NewServer(dockerdriver.New(workspace))
	server.GitProjectRoot = filepath.Dir(gitDir) // GIT_PROJECT_ROOT holds the bare repo
	server.Token = token
	srv := &http.Server{Handler: server.Handler()}

	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		_ = srv.Close()
	}()
	fmt.Printf("infra-driver serving git+primitives on %s (repo %s)\n", listen, filepath.Base(gitDir))
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

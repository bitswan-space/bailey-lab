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
	wrap       bool
}

func (f *ctxFlags) bind(cmd *cobra.Command) {
	cmd.Flags().StringVar(&f.workspace, "workspace", "", "workspace name")
	cmd.Flags().StringVar(&f.domain, "domain", "", "workspace domain")
	cmd.Flags().StringVar(&f.secretsDir, "secrets-dir", "", "shared secrets volume path")
	cmd.Flags().BoolVar(&f.wrap, "wrap", false, "protected-proxy present (wrap topology)")
}

func newServeCmd() *cobra.Command {
	var (
		socket string
		gitDir string
		cf     ctxFlags
	)
	cmd := &cobra.Command{
		Use:   "serve",
		Short: "Host the deploy git remote + serve container primitives on a UNIX socket",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if socket == "" || gitDir == "" {
				return fmt.Errorf("--socket and --git-dir are required")
			}
			if err := ensureBareRepo(gitDir, cf); err != nil {
				return err
			}
			return serveHTTP(cmd.Context(), socket)
		},
	}
	cmd.Flags().StringVar(&socket, "socket", "", "UNIX socket to serve the HTTP API on")
	cmd.Flags().StringVar(&gitDir, "git-dir", "", "bare git repo to host (post-receive applies on push)")
	cf.bind(cmd)
	return cmd
}

// ensureBareRepo creates the bare repo if missing, records the workspace
// context in its git config, and installs the post-receive hook that runs
// `bitswan infra-driver apply`.
func ensureBareRepo(gitDir string, cf ctxFlags) error {
	if _, err := os.Stat(filepath.Join(gitDir, "HEAD")); os.IsNotExist(err) {
		if out, err := exec.Command("git", "init", "--bare", gitDir).CombinedOutput(); err != nil {
			return fmt.Errorf("git init --bare: %w: %s", err, out)
		}
	}
	// Record the context so the hook can rebuild it without flags.
	for k, v := range map[string]string{
		"bitswan.workspace":  cf.workspace,
		"bitswan.domain":     cf.domain,
		"bitswan.secretsdir": cf.secretsDir,
		"bitswan.wrap":       fmt.Sprintf("%t", cf.wrap),
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

// serveHTTP serves the driver's HTTP API (build-image + container primitives)
// on the UNIX socket until the context is cancelled.
func serveHTTP(ctx context.Context, socket string) error {
	_ = os.Remove(socket) // clear a stale socket
	ln, err := net.Listen("unix", socket)
	if err != nil {
		return fmt.Errorf("listen %s: %w", socket, err)
	}
	srv := &http.Server{Handler: infradriver.NewServer(dockerdriver.New()).Handler()}

	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		_ = srv.Close()
	}()
	fmt.Printf("infra-driver serving on %s\n", socket)
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

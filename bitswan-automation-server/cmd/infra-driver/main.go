// Command infra-driver is the standalone per-workspace infrastructure driver.
// It ships as its own self-contained image (docker CLI + compose + git +
// git-http-backend + syft, with this binary baked in) — NOT as a subcommand of
// the bitswan CLI. It (a) hosts a bare git remote whose post-receive hook
// compiles + applies the pushed bitswan.yaml, and (b) serves the operational
// container primitives + build-image over TCP, guarded by a shared token.
// See internal/infradriver/README.md for the architecture.
package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

func main() {
	root := &cobra.Command{
		Use:   "infra-driver",
		Short: "Per-workspace infrastructure driver (git-push apply + container primitives)",
	}
	root.AddCommand(newServeCmd())
	root.AddCommand(newApplyCmd())
	if err := root.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

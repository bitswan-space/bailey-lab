package cmd

import (
	"fmt"
	"os"

	"github.com/bitswan-space/bitswan-workspaces/internal/daemon"
	"github.com/spf13/cobra"
)

// newRollbackCmd creates the top-level `bitswan rollback <workspace>` command.
// Rollback is intentionally CLI-only (there is no GUI button): reverting a
// workspace to its previous images should require host access. The snapshot it
// restores is written automatically before every `bitswan workspace update`, and
// the swap is reversible — running `rollback` again re-applies the update.
func newRollbackCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:          "rollback <workspace-name>",
		Short:        "Roll a workspace back to its previous deployment",
		Long:         "Restore the workspace's previous docker-compose snapshot (saved before the last `bitswan workspace update`) and re-deploy. Running it again re-applies the update.",
		Args:         cobra.ExactArgs(1),
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := daemon.NewClient()
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				fmt.Fprintln(os.Stderr, "Run 'bitswan automation-server-daemon init' to start it.")
				os.Exit(1)
			}
			if err := client.WorkspaceRollback(args[0]); err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}
			return nil
		},
		ValidArgsFunction: validWorkspaceArgs,
	}
	return cmd
}

package cmd

import (
	"fmt"
	"os"

	"github.com/bitswan-space/bitswan-workspaces/internal/daemon"
	"github.com/spf13/cobra"
)

func resolveWorkspaceName(client *daemon.Client, args []string) (string, error) {
	if len(args) > 0 {
		return args[0], nil
	}
	ws, err := client.ActiveWorkspace()
	if err != nil {
		return "", fmt.Errorf("no workspace specified and no active workspace set: %w", err)
	}
	return ws, nil
}

func newStartCmd() *cobra.Command {
	var automationsOnly bool

	cmd := &cobra.Command{
		Use:          "start [workspace]",
		Short:        "Start all services in a workspace",
		Long:         "Start the GitOps container and deploy all automations in a workspace. If no workspace is specified, the active workspace is used.",
		Args:         cobra.MaximumNArgs(1),
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := daemon.NewClient()
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				fmt.Fprintln(os.Stderr, "Run 'bitswan automation-server-daemon init' to start it.")
				os.Exit(1)
			}

			workspaceName, err := resolveWorkspaceName(client, args)
			if err != nil {
				return err
			}

			if err := client.WorkspaceStart(workspaceName, automationsOnly); err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}
			return nil
		},
	}

	cmd.Flags().BoolVar(&automationsOnly, "automations", false, "Only start automations and their dependent services (skip GitOps)")

	return cmd
}

func newStopCmd() *cobra.Command {
	var automationsOnly bool

	cmd := &cobra.Command{
		Use:          "stop [workspace]",
		Short:        "Stop all services in a workspace",
		Long:         "Stop all automations and the GitOps container in a workspace. If no workspace is specified, the active workspace is used.",
		Args:         cobra.MaximumNArgs(1),
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := daemon.NewClient()
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				fmt.Fprintln(os.Stderr, "Run 'bitswan automation-server-daemon init' to start it.")
				os.Exit(1)
			}

			workspaceName, err := resolveWorkspaceName(client, args)
			if err != nil {
				return err
			}

			if err := client.WorkspaceStop(workspaceName, automationsOnly); err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}
			return nil
		},
	}

	cmd.Flags().BoolVar(&automationsOnly, "automations", false, "Only stop automations (skip GitOps)")

	return cmd
}

func newRestartCmd() *cobra.Command {
	var automationsOnly bool

	cmd := &cobra.Command{
		Use:          "restart [workspace]",
		Short:        "Restart all services in a workspace",
		Long:         "Stop and then start all services in a workspace. If no workspace is specified, the active workspace is used.",
		Args:         cobra.MaximumNArgs(1),
		SilenceUsage: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := daemon.NewClient()
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				fmt.Fprintln(os.Stderr, "Run 'bitswan automation-server-daemon init' to start it.")
				os.Exit(1)
			}

			workspaceName, err := resolveWorkspaceName(client, args)
			if err != nil {
				return err
			}

			if err := client.WorkspaceRestart(workspaceName, automationsOnly); err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}
			return nil
		},
	}

	cmd.Flags().BoolVar(&automationsOnly, "automations", false, "Only restart automations (skip GitOps)")

	return cmd
}

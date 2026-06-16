package cmd

import (
	"fmt"
	"os/exec"
	"runtime"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/daemon"
	"github.com/spf13/cobra"
)

func newOpenCmd() *cobra.Command {
	return &cobra.Command{
		Use:               "open",
		Short:             "Open the editor for a workspace",
		Args:              cobra.ExactArgs(1),
		SilenceUsage:      true,
		ValidArgsFunction: validWorkspaceArgs,
		RunE:              runOpenCmd,
	}
}

func runOpenCmd(cmd *cobra.Command, args []string) error {
	// Workspace data now lives in a Docker volume the host CLI can't read
	// directly, so ask the daemon for the workspace's editor URL.
	client, err := daemon.NewClient()
	if err != nil {
		return fmt.Errorf("automation server daemon is not available: %w", err)
	}
	resp, err := client.ListWorkspaces(false, false)
	if err != nil {
		return fmt.Errorf("failed to list workspaces: %w", err)
	}

	name := args[0]
	for _, ws := range resp.Workspaces {
		if ws.Name == name {
			if strings.TrimSpace(ws.EditorURL) == "" {
				return fmt.Errorf("workspace %q has no editor URL", name)
			}
			fmt.Printf("Opening editor at: %s\n", ws.EditorURL)
			return openURL(ws.EditorURL)
		}
	}
	return fmt.Errorf("workspace %q not found", name)
}

func openURL(url string) error {
	var cmd *exec.Cmd

	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("start", url)
	case "darwin":
		cmd = exec.Command("open", url)
	case "linux":
		cmd = exec.Command("xdg-open", url)
	default:
		return fmt.Errorf("unsupported operating system")
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to open URL: %w", err)
	}

	return nil
}

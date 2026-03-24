package cmd

import (
	"bufio"
	"fmt"

	"github.com/spf13/cobra"
)

var deploymentsExecCmd = &cobra.Command{
	Use:   "exec DEPLOYMENT_ID -- command [args...]",
	Short: "Execute a command in a live-dev container",
	Long:  "Run a command inside a worktree-specific live-dev deployment container.",
	Args:  cobra.MinimumNArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		deploymentID := args[0]

		// Find the -- separator
		commandArgs := args[1:]
		if len(commandArgs) > 0 && commandArgs[0] == "--" {
			commandArgs = commandArgs[1:]
		}

		if len(commandArgs) == 0 {
			return fmt.Errorf("no command specified after --")
		}

		body := map[string]interface{}{
			"command": commandArgs,
		}

		resp, err := agentRequest("POST", fmt.Sprintf("/deployments/%s/exec", deploymentID), body)
		if err != nil {
			return fmt.Errorf("failed to exec command: %w", err)
		}
		defer resp.Body.Close()

		scanner := bufio.NewScanner(resp.Body)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			fmt.Println(scanner.Text())
		}

		return scanner.Err()
	},
}

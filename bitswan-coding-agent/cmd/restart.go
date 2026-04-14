package cmd

import (
	"bufio"
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var deploymentsRestartCmd = &cobra.Command{
	Use:   "restart DEPLOYMENT_ID",
	Short: "Restart a live-dev deployment",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		deploymentID := args[0]

		err := agentRequestJSON("POST", fmt.Sprintf("/deployments/%s/restart", deploymentID), nil, nil)
		if err != nil {
			return fmt.Errorf("failed to restart deployment: %w", err)
		}

		fmt.Printf("Deployment %s restarted successfully\n", deploymentID)
		return nil
	},
}

var deploymentsBuildAndRestartCmd = &cobra.Command{
	Use:   "build-and-restart DEPLOYMENT_ID",
	Short: "Build image and restart a live-dev deployment",
	Long: `Build the automation image and restart the deployment.

Streams the build output and deploy progress in real time.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		deploymentID := args[0]

		// The server streams progress as text/plain
		resp, err := agentRequest("POST", fmt.Sprintf("/deployments/%s/build-and-restart", deploymentID), nil)
		if err != nil {
			return fmt.Errorf("build-and-restart failed: %w", err)
		}
		defer resp.Body.Close()

		// Stream the response line by line to stdout
		scanner := bufio.NewScanner(resp.Body)
		for scanner.Scan() {
			line := scanner.Text()
			fmt.Println(line)
			// Check for error lines
			if len(line) >= 6 && line[:6] == "ERROR:" {
				os.Exit(1)
			}
		}
		if err := scanner.Err(); err != nil {
			return fmt.Errorf("error reading response: %w", err)
		}

		return nil
	},
}

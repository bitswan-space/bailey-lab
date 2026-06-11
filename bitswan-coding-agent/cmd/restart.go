package cmd

import (
	"bufio"
	"encoding/json"
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

Streams Docker build output and deploy progress in real time (ndjson).`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		deploymentID := args[0]

		resp, err := agentRequest("POST", fmt.Sprintf("/deployments/%s/build-and-restart", deploymentID), nil)
		if err != nil {
			return fmt.Errorf("build-and-restart failed: %w", err)
		}
		defer resp.Body.Close()

		hadError := false
		scanner := bufio.NewScanner(resp.Body)
		for scanner.Scan() {
			var line map[string]interface{}
			if err := json.Unmarshal(scanner.Bytes(), &line); err != nil {
				// Not JSON, print raw
				fmt.Println(scanner.Text())
				continue
			}

			if s, ok := line["stream"].(string); ok {
				fmt.Print(s)
			}
			if s, ok := line["status"].(string); ok {
				fmt.Printf("=> %s\n", s)
			}
			if s, ok := line["error"].(string); ok {
				fmt.Fprintf(os.Stderr, "ERROR: %s\n", s)
				hadError = true
			}
			if s, ok := line["errorDetail"].(map[string]interface{}); ok {
				if msg, ok := s["message"].(string); ok {
					fmt.Fprintf(os.Stderr, "ERROR: %s\n", msg)
					hadError = true
				}
			}
		}
		if err := scanner.Err(); err != nil {
			return fmt.Errorf("error reading response: %w", err)
		}
		if hadError {
			os.Exit(1)
		}
		return nil
	},
}

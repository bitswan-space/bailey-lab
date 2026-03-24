package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var restartCmd = &cobra.Command{
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

var buildAndRestartCmd = &cobra.Command{
	Use:   "build-and-restart DEPLOYMENT_ID",
	Short: "Build image and restart a live-dev deployment",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		deploymentID := args[0]

		err := agentRequestJSON("POST", fmt.Sprintf("/deployments/%s/build-and-restart", deploymentID), nil, nil)
		if err != nil {
			return fmt.Errorf("failed to build and restart deployment: %w", err)
		}

		fmt.Printf("Deployment %s build and restart triggered\n", deploymentID)
		return nil
	},
}

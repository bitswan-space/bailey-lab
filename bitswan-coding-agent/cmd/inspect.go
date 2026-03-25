package cmd

import (
	"encoding/json"
	"fmt"

	"github.com/spf13/cobra"
)

var deploymentsInspectCmd = &cobra.Command{
	Use:   "inspect DEPLOYMENT_ID",
	Short: "Show full container details for a deployment",
	Long:  "Displays state, image, networks, ports, mounts, and labels from docker inspect.",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		deploymentID := args[0]

		var result map[string]interface{}
		if err := agentRequestJSON("GET", fmt.Sprintf("/deployments/%s/inspect", deploymentID), nil, &result); err != nil {
			return fmt.Errorf("failed to inspect: %w", err)
		}

		data, err := json.MarshalIndent(result, "", "  ")
		if err != nil {
			return err
		}
		fmt.Println(string(data))
		return nil
	},
}

package cmd

import (
	"fmt"
	"os"
	"sort"
	"text/tabwriter"

	"github.com/spf13/cobra"
)

var deploymentsInspectEnvCmd = &cobra.Command{
	Use:   "inspect-env DEPLOYMENT_ID",
	Short: "Show environment variables for a deployment",
	Long:  "Lists all environment variables configured on the deployment container.",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		deploymentID := args[0]

		var result struct {
			DeploymentID string            `json:"deployment_id"`
			Env          map[string]string `json:"env"`
		}
		if err := agentRequestJSON("GET", fmt.Sprintf("/deployments/%s/env", deploymentID), nil, &result); err != nil {
			return fmt.Errorf("failed to get env: %w", err)
		}

		if len(result.Env) == 0 {
			fmt.Println("No environment variables found.")
			return nil
		}

		// Sort keys for consistent output
		keys := make([]string, 0, len(result.Env))
		for k := range result.Env {
			keys = append(keys, k)
		}
		sort.Strings(keys)

		w := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
		for _, k := range keys {
			fmt.Fprintf(w, "%s\t%s\n", k, result.Env[k])
		}
		w.Flush()

		return nil
	},
}

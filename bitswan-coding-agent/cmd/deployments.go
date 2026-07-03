package cmd

import (
	"fmt"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"
)

type deployment struct {
	DeploymentID   string `json:"deployment_id"`
	State          string `json:"state"`
	AutomationName string `json:"automation_name"`
	RelativePath   string `json:"relative_path"`
	URL            string `json:"url"`
}

var deploymentsCmd = &cobra.Command{
	Use:   "deployments",
	Short: "Manage deployments",
}

var deploymentsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all deployments for the current copy (running and not started)",
	RunE: func(cmd *cobra.Command, args []string) error {
		copy, err := detectCopyOrFlag(copyFlag)
		if err != nil {
			return fmt.Errorf("cannot detect copy: %w", err)
		}

		var result []deployment
		path := fmt.Sprintf("/deployments?copy=%s", copy)
		if err := agentRequestJSON("GET", path, nil, &result); err != nil {
			return err
		}

		if len(result) == 0 {
			fmt.Println("No automations found in this copy.")
			return nil
		}

		w := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
		fmt.Fprintln(w, "DEPLOYMENT_ID\tSTATUS\tAUTOMATION\tURL")
		for _, d := range result {
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", d.DeploymentID, d.State, d.AutomationName, d.URL)
		}
		w.Flush()

		return nil
	},
}

var deploymentsStartCmd = &cobra.Command{
	Use:   "start DEPLOYMENT_ID",
	Short: "Start a live-dev deployment",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		deploymentID := args[0]

		copy, err := detectCopyOrFlag(copyFlag)
		if err != nil {
			return fmt.Errorf("cannot detect copy: %w", err)
		}

		// The start endpoint identifies the automation by its source path, not
		// its deployment ID (the ID only exists once deployed) — resolve the
		// given ID to a relative_path via the deployments listing.
		var deployments []deployment
		if err := agentRequestJSON("GET", fmt.Sprintf("/deployments?copy=%s", copy), nil, &deployments); err != nil {
			return err
		}
		var relPath string
		for _, d := range deployments {
			if d.DeploymentID == deploymentID {
				relPath = d.RelativePath
				break
			}
		}
		if relPath == "" {
			var all []string
			for _, d := range deployments {
				all = append(all, d.DeploymentID)
			}
			return fmt.Errorf("deployment %q not found in copy %q. Available: %s",
				deploymentID, copy, strings.Join(all, ", "))
		}

		body := map[string]string{"relative_path": relPath, "copy": copy}

		var result map[string]interface{}
		if err := agentRequestJSON("POST", "/deployments/start", body, &result); err != nil {
			return err
		}

		fmt.Printf("Deployment %s started (task: %v)\n", deploymentID, result["task_id"])
		return nil
	},
}

var copyFlag string

func init() {
	deploymentsListCmd.Flags().StringVar(&copyFlag, "copy", "", "Copy name (auto-detected from $PWD if omitted)")
	deploymentsStartCmd.Flags().StringVar(&copyFlag, "copy", "", "Copy name (auto-detected from $PWD if omitted)")
	deploymentsCmd.AddCommand(deploymentsListCmd)
	deploymentsCmd.AddCommand(deploymentsStartCmd)
	deploymentsCmd.AddCommand(deploymentsExecCmd)
	deploymentsCmd.AddCommand(deploymentsLogsCmd)
	deploymentsCmd.AddCommand(deploymentsRestartCmd)
	deploymentsCmd.AddCommand(deploymentsBuildAndRestartCmd)
	deploymentsCmd.AddCommand(deploymentsInspectCmd)
	deploymentsCmd.AddCommand(deploymentsInspectEnvCmd)
}

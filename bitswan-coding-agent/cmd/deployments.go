package cmd

import (
	"fmt"
	"os"
	"text/tabwriter"

	"github.com/spf13/cobra"
)

type deployment struct {
	DeploymentID   string `json:"deployment_id"`
	State          string `json:"state"`
	AutomationName string `json:"automation_name"`
	URL            string `json:"url"`
}

var deploymentsCmd = &cobra.Command{
	Use:   "deployments",
	Short: "Manage deployments",
}

var deploymentsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all deployments for the current worktree (running and not started)",
	RunE: func(cmd *cobra.Command, args []string) error {
		worktree, err := detectWorktreeOrFlag(worktreeFlag)
		if err != nil {
			return fmt.Errorf("cannot detect worktree: %w", err)
		}

		var result []deployment
		path := fmt.Sprintf("/deployments?worktree=%s", worktree)
		if err := agentRequestJSON("GET", path, nil, &result); err != nil {
			return err
		}

		if len(result) == 0 {
			fmt.Println("No automations found in this worktree.")
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

		worktree, err := detectWorktreeOrFlag(worktreeFlag)
		if err != nil {
			return fmt.Errorf("cannot detect worktree: %w", err)
		}

		body := map[string]string{"deployment_id": deploymentID}
		path := fmt.Sprintf("/deployments/start?worktree=%s", worktree)

		var result map[string]interface{}
		if err := agentRequestJSON("POST", path, body, &result); err != nil {
			return err
		}

		fmt.Printf("Deployment %s started (task: %v)\n", deploymentID, result["task_id"])
		return nil
	},
}

var worktreeFlag string

func init() {
	deploymentsListCmd.Flags().StringVar(&worktreeFlag, "worktree", "", "Worktree name (auto-detected from $PWD if omitted)")
	deploymentsStartCmd.Flags().StringVar(&worktreeFlag, "worktree", "", "Worktree name (auto-detected from $PWD if omitted)")
	deploymentsCmd.AddCommand(deploymentsListCmd)
	deploymentsCmd.AddCommand(deploymentsStartCmd)
	deploymentsCmd.AddCommand(deploymentsExecCmd)
	deploymentsCmd.AddCommand(deploymentsLogsCmd)
	deploymentsCmd.AddCommand(deploymentsRestartCmd)
	deploymentsCmd.AddCommand(deploymentsBuildAndRestartCmd)
}

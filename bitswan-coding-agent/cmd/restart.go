package cmd

import (
	"fmt"
	"time"

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

If a build is already in progress, attaches to it and streams the
progress until completion. Otherwise, triggers a new build.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		deploymentID := args[0]

		// Try to trigger build-and-restart
		var result map[string]interface{}
		err := agentRequestJSON("POST", fmt.Sprintf("/deployments/%s/build-and-restart", deploymentID), nil, &result)

		var taskID string
		if err != nil {
			// If 409, a deploy is already in progress — attach to it
			var status map[string]interface{}
			statusErr := agentRequestJSON("GET", fmt.Sprintf("/deployments/%s/deploy-status", deploymentID), nil, &status)
			if statusErr != nil {
				return fmt.Errorf("build-and-restart failed: %w", err)
			}
			deploying, _ := status["deploying"].(bool)
			if !deploying {
				return fmt.Errorf("build-and-restart failed: %w", err)
			}
			taskID, _ = status["task_id"].(string)
			if taskID == "" {
				return fmt.Errorf("build-and-restart failed: %w", err)
			}
			step, _ := status["step"].(string)
			message, _ := status["message"].(string)
			fmt.Printf("Build already in progress (task %s)\n", taskID)
			if step != "" || message != "" {
				fmt.Printf("  [%s] %s\n", step, message)
			}
		} else {
			taskID, _ = result["task_id"].(string)
			if taskID == "" {
				fmt.Println("Build triggered (no task ID returned)")
				return nil
			}
			fmt.Printf("Build started (task %s)\n", taskID)
		}

		// Poll task progress until done
		return pollDeployProgress(deploymentID, taskID)
	},
}

func pollDeployProgress(deploymentID, taskID string) error {
	lastStep := ""
	lastMessage := ""

	for {
		var status map[string]interface{}
		err := agentRequestJSON("GET", fmt.Sprintf("/deployments/%s/deploy-status", deploymentID), nil, &status)
		if err != nil {
			return fmt.Errorf("failed to check deploy status: %w", err)
		}

		deploying, _ := status["deploying"].(bool)
		taskStatus, _ := status["status"].(string)
		step, _ := status["step"].(string)
		message, _ := status["message"].(string)
		errMsg, _ := status["error"].(string)

		// Print progress when it changes
		if step != lastStep || message != lastMessage {
			if step != "" {
				fmt.Printf("  [%s] %s\n", step, message)
			} else if message != "" {
				fmt.Printf("  %s\n", message)
			}
			lastStep = step
			lastMessage = message
		}

		if taskStatus == "completed" {
			fmt.Printf("Deployment %s build and restart completed successfully\n", deploymentID)
			return nil
		}
		if taskStatus == "failed" {
			if errMsg != "" {
				return fmt.Errorf("build and restart failed: %s", errMsg)
			}
			return fmt.Errorf("build and restart failed")
		}
		if !deploying && taskStatus == "" {
			// Task disappeared — assume done
			fmt.Printf("Deployment %s completed\n", deploymentID)
			return nil
		}

		time.Sleep(2 * time.Second)
	}
}

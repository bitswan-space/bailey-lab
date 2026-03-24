package cmd

import (
	"bufio"
	"fmt"

	"github.com/spf13/cobra"
)

var logsFollow bool

var logsCmd = &cobra.Command{
	Use:   "logs DEPLOYMENT_ID",
	Short: "View deployment logs",
	Long:  "Stream logs from a worktree-specific live-dev deployment.",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		deploymentID := args[0]

		path := fmt.Sprintf("/deployments/%s/logs", deploymentID)
		if logsFollow {
			path += "?follow=true"
		}

		resp, err := agentRequest("GET", path, nil)
		if err != nil {
			return fmt.Errorf("failed to get logs: %w", err)
		}
		defer resp.Body.Close()

		scanner := bufio.NewScanner(resp.Body)
		// Increase buffer size for long log lines
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			fmt.Println(scanner.Text())
		}

		if err := scanner.Err(); err != nil {
			return fmt.Errorf("error reading logs: %w", err)
		}

		return nil
	},
}

func init() {
	logsCmd.Flags().BoolVar(&logsFollow, "follow", false, "Follow log output")
	logsCmd.Flags().BoolVarP(&logsFollow, "f", "f", false, "Follow log output (shorthand)")
}

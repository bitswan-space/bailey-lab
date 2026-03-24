package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var (
	commitMessage string
	commitEmail   string
)

var commitCmd = &cobra.Command{
	Use:   "commit",
	Short: "Commit changes in the current worktree",
	RunE: func(cmd *cobra.Command, args []string) error {
		worktree, err := detectWorktreeOrFlag("")
		if err != nil {
			return fmt.Errorf("could not detect worktree: %w", err)
		}

		if commitMessage == "" {
			return fmt.Errorf("--message is required")
		}

		body := map[string]string{
			"message": commitMessage,
		}
		if commitEmail != "" {
			body["author_email"] = commitEmail
		}

		var result map[string]interface{}
		err = agentRequestJSON("POST", fmt.Sprintf("/worktrees/%s/commit", worktree), body, &result)
		if err != nil {
			return fmt.Errorf("failed to commit: %w", err)
		}

		if hash, ok := result["commit_hash"]; ok {
			fmt.Printf("Committed successfully: %v\n", hash)
		} else {
			fmt.Println("Committed successfully")
		}
		return nil
	},
}

func init() {
	commitCmd.Flags().StringVarP(&commitMessage, "message", "m", "", "Commit message")
	commitCmd.Flags().StringVar(&commitEmail, "email", "", "Author email (default: agent@bitswan.local)")
}

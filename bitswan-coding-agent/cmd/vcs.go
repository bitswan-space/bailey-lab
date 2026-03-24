package cmd

import (
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"
)

var vcsCmd = &cobra.Command{
	Use:   "vcs",
	Short: "Version control commands for the current worktree",
	Long: `Git operations scoped to the current worktree.

The commit subcommand automatically stages all changes (git add -A) before
committing. If you have files you don't want committed, add them to
.gitignore or delete them before committing.

The committer email is read from the SSH_USER_EMAIL environment variable,
which is set automatically when you connect via the Coding Agents panel.`,
}

var vcsStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show working tree status",
	RunE: func(cmd *cobra.Command, args []string) error {
		worktree, err := detectWorktree()
		if err != nil {
			return err
		}
		var result map[string]string
		if err := agentRequestJSON("GET", fmt.Sprintf("/worktrees/%s/status", worktree), nil, &result); err != nil {
			return err
		}
		fmt.Print(result["output"])
		return nil
	},
}

var vcsLogCmd = &cobra.Command{
	Use:   "log",
	Short: "Show commit log",
	RunE: func(cmd *cobra.Command, args []string) error {
		worktree, err := detectWorktree()
		if err != nil {
			return err
		}
		var result map[string]string
		if err := agentRequestJSON("GET", fmt.Sprintf("/worktrees/%s/log?n=%d", worktree, logCount), nil, &result); err != nil {
			return err
		}
		fmt.Print(result["output"])
		return nil
	},
}

var vcsDiffCmd = &cobra.Command{
	Use:   "diff [path]",
	Short: "Show uncommitted changes",
	RunE: func(cmd *cobra.Command, args []string) error {
		worktree, err := detectWorktree()
		if err != nil {
			return err
		}
		endpoint := fmt.Sprintf("/worktrees/%s/diff", worktree)
		if len(args) > 0 {
			endpoint += "?path=" + args[0]
		}
		var result map[string]string
		if err := agentRequestJSON("GET", endpoint, nil, &result); err != nil {
			return err
		}
		output := result["output"]
		if output == "" {
			fmt.Println("No uncommitted changes.")
		} else {
			fmt.Print(output)
		}
		return nil
	},
}

var vcsCommitMessage string
var logCount int

var vcsCommitCmd = &cobra.Command{
	Use:   "commit",
	Short: "Stage all changes and commit",
	Long: `Stage all changes (git add -A) and commit with the given message.

All tracked and untracked files are staged automatically. If you have
files that should not be committed, either:
  - Add them to .gitignore
  - Delete them before committing

The author email is taken from the SSH_USER_EMAIL environment variable.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		if vcsCommitMessage == "" {
			return fmt.Errorf("--message is required")
		}

		worktree, err := detectWorktree()
		if err != nil {
			return fmt.Errorf("could not detect worktree: %w", err)
		}

		email := os.Getenv("SSH_USER_EMAIL")
		if email == "" {
			email = "agent@bitswan.local"
		}

		body := map[string]string{
			"message":      vcsCommitMessage,
			"author_email": email,
		}

		var result map[string]interface{}
		err = agentRequestJSON("POST", fmt.Sprintf("/worktrees/%s/commit", worktree), body, &result)
		if err != nil {
			if strings.Contains(err.Error(), "Nothing to commit") {
				fmt.Println("Nothing to commit, working tree clean.")
				return nil
			}
			return fmt.Errorf("failed to commit: %w", err)
		}

		if hash, ok := result["commit_hash"]; ok {
			fmt.Printf("Committed: %v\n", hash)
		} else {
			fmt.Println("Committed successfully.")
		}
		return nil
	},
}

func init() {
	vcsCommitCmd.Flags().StringVarP(&vcsCommitMessage, "message", "m", "", "Commit message (required)")
	vcsLogCmd.Flags().IntVarP(&logCount, "count", "n", 20, "Number of commits to show")
	vcsCmd.AddCommand(vcsStatusCmd)
	vcsCmd.AddCommand(vcsLogCmd)
	vcsCmd.AddCommand(vcsDiffCmd)
	vcsCmd.AddCommand(vcsCommitCmd)
}

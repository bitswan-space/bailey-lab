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

type rebaseResult struct {
	Status          string   `json:"status"`
	Detail          string   `json:"detail"`
	Message         string   `json:"message"`
	MergedInto      string   `json:"merged_into"`
	Tip             string   `json:"tip"`
	StashConflict   bool     `json:"stash_conflict"`
	StashMessage    string   `json:"stash_message"`
	ConflictedFiles []string `json:"conflicted_files"`
	RebaseOutput    string   `json:"rebase_output"`
}

func printSyncResult(r rebaseResult) {
	switch r.Status {
	case "conflicts":
		fmt.Println("Sync paused — conflicts in:")
		for _, f := range r.ConflictedFiles {
			fmt.Printf("  - %s\n", f)
		}
		fmt.Println("\nResolve these files, then run: bitswan-coding-agent vcs sync-continue")
		fmt.Println("Or abort with: bitswan-coding-agent vcs sync-abort")
	case "success":
		fmt.Printf("Synced with %s (tip: %s)\n", r.MergedInto, r.Tip)
		if r.StashConflict {
			fmt.Fprintf(os.Stderr, "\nWarning: stash pop had conflicts. Previously uncommitted changes are still stashed.\n%s\n", r.StashMessage)
		}
	}
}

var vcsSyncCmd = &cobra.Command{
	Use:   "sync",
	Short: "Sync this worktree with the default branch",
	Long: `Rebases this worktree's branch onto the workspace's current default
branch, then fast-forwards the default branch to include the worktree's commits.

If conflicts occur, the rebase pauses and shows the conflicted files.
Resolve them (edit the files to remove conflict markers), then run:
  bitswan-coding-agent vcs sync-continue

To abort the sync entirely:
  bitswan-coding-agent vcs sync-abort

If the workspace has uncommitted changes, they are stashed and left stashed.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		worktree, err := detectWorktree()
		if err != nil {
			return err
		}

		var result rebaseResult
		err = agentRequestJSON("POST", fmt.Sprintf("/worktrees/%s/sync", worktree), nil, &result)
		if err != nil {
			return fmt.Errorf("sync failed: %w", err)
		}

		printSyncResult(result)
		if result.Status == "conflicts" {
			os.Exit(1)
		}
		if result.StashConflict {
			os.Exit(2)
		}
		return nil
	},
}

var vcsSyncContinueCmd = &cobra.Command{
	Use:   "sync-continue",
	Short: "Continue sync after resolving conflicts",
	Long:  "Stages all resolved files and continues the sync. If more conflicts arise, reports them.",
	RunE: func(cmd *cobra.Command, args []string) error {
		worktree, err := detectWorktree()
		if err != nil {
			return err
		}

		var result rebaseResult
		err = agentRequestJSON("POST", fmt.Sprintf("/worktrees/%s/sync-continue", worktree), nil, &result)
		if err != nil {
			return fmt.Errorf("sync-continue failed: %w", err)
		}

		printSyncResult(result)
		if result.Status == "conflicts" {
			os.Exit(1)
		}
		if result.StashConflict {
			os.Exit(2)
		}
		return nil
	},
}

var vcsSyncAbortCmd = &cobra.Command{
	Use:   "sync-abort",
	Short: "Abort an in-progress sync",
	Long:  "Aborts the sync rebase and cleans up any leftover conflict state.",
	RunE: func(cmd *cobra.Command, args []string) error {
		worktree, err := detectWorktree()
		if err != nil {
			return err
		}

		var result struct {
			Status  string `json:"status"`
			Message string `json:"message"`
		}
		err = agentRequestJSON("POST", fmt.Sprintf("/worktrees/%s/sync-abort", worktree), nil, &result)
		if err != nil {
			return fmt.Errorf("sync-abort failed: %w", err)
		}

		fmt.Println(result.Message)
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
	vcsCmd.AddCommand(vcsSyncCmd)
	vcsCmd.AddCommand(vcsSyncContinueCmd)
	vcsCmd.AddCommand(vcsSyncAbortCmd)
}

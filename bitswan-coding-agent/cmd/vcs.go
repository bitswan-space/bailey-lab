package cmd

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
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

func printRebaseResult(r rebaseResult) {
	if r.Status == "conflicts" {
		fmt.Println("Rebase paused — conflicts in:")
		for _, f := range r.ConflictedFiles {
			fmt.Printf("  - %s\n", f)
		}
		fmt.Println("\nResolve these files, then run: bitswan-agent vcs rebase-continue")
		fmt.Println("Or abort with: bitswan-agent vcs rebase-abort")
	} else if r.Status == "success" {
		fmt.Printf("Merged into %s (tip: %s)\n", r.MergedInto, r.Tip)
		if r.StashConflict {
			fmt.Fprintf(os.Stderr, "\nWarning: stash pop had conflicts. Previously uncommitted changes are still stashed.\n%s\n", r.StashMessage)
		}
	}
}

var vcsRebaseMergeCmd = &cobra.Command{
	Use:   "rebase-and-merge",
	Short: "Rebase onto default branch, then fast-forward merge",
	Long: `Rebases this worktree's branch onto the workspace's current branch,
then fast-forwards the workspace branch to include the worktree's commits.

If conflicts occur, the rebase pauses and shows the conflicted files.
Resolve them (edit the files to remove conflict markers), then run:
  bitswan-agent vcs rebase-continue

To abort the rebase entirely:
  bitswan-agent vcs rebase-abort

If the workspace has uncommitted changes, they are stashed and restored after.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		worktree, err := detectWorktree()
		if err != nil {
			return err
		}

		var result rebaseResult
		err = agentRequestJSON("POST", fmt.Sprintf("/worktrees/%s/rebase-and-merge", worktree), nil, &result)
		if err != nil {
			return fmt.Errorf("rebase-and-merge failed: %w", err)
		}

		printRebaseResult(result)
		if result.Status == "conflicts" {
			os.Exit(1)
		}
		if result.StashConflict {
			os.Exit(2)
		}
		return nil
	},
}

var vcsRebaseContinueCmd = &cobra.Command{
	Use:   "rebase-continue",
	Short: "Continue rebase after resolving conflicts",
	Long:  "Stages all resolved files and continues the rebase. If more conflicts arise, reports them.",
	RunE: func(cmd *cobra.Command, args []string) error {
		worktree, err := detectWorktree()
		if err != nil {
			return err
		}

		var result rebaseResult
		err = agentRequestJSON("POST", fmt.Sprintf("/worktrees/%s/rebase-continue", worktree), nil, &result)
		if err != nil {
			return fmt.Errorf("rebase-continue failed: %w", err)
		}

		printRebaseResult(result)
		if result.Status == "conflicts" {
			os.Exit(1)
		}
		if result.StashConflict {
			os.Exit(2)
		}
		return nil
	},
}

var vcsRebaseAbortCmd = &cobra.Command{
	Use:   "rebase-abort",
	Short: "Abort an in-progress rebase",
	Long:  "Aborts the rebase and restores the stash if one was created.",
	RunE: func(cmd *cobra.Command, args []string) error {
		worktree, err := detectWorktree()
		if err != nil {
			return err
		}

		var result struct {
			Status  string `json:"status"`
			Message string `json:"message"`
		}
		err = agentRequestJSON("POST", fmt.Sprintf("/worktrees/%s/rebase-abort", worktree), nil, &result)
		if err != nil {
			return fmt.Errorf("rebase-abort failed: %w", err)
		}

		fmt.Println(result.Message)
		return nil
	},
}

// resolveConflictsInFile reads a file with git conflict markers and resolves
// them by keeping one side. keepWorktree=true keeps the worktree's changes
// (section 2 in conflict markers), false keeps the default branch's (section 1).
func resolveConflictsInFile(path string, keepWorktree bool) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	var out []string
	scanner := bufio.NewScanner(f)
	// Track which section of a conflict block we're in:
	// 0 = outside conflict, 1 = ours (HEAD), 2 = theirs (incoming)
	section := 0

	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, "<<<<<<<"):
			section = 1
		case strings.HasPrefix(line, "=======") && section == 1:
			section = 2
		case strings.HasPrefix(line, ">>>>>>>"):
			section = 0
		default:
			if section == 0 {
				out = append(out, line)
			} else if section == 1 && !keepWorktree {
				out = append(out, line)
			} else if section == 2 && keepWorktree {
				out = append(out, line)
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}

	return os.WriteFile(path, []byte(strings.Join(out, "\n")+"\n"), 0644)
}

var syncStrategy string

var vcsSyncCmd = &cobra.Command{
	Use:   "sync",
	Short: "Update worktree branch with latest changes from the default branch",
	Long: `Rebases the worktree's feature branch onto the current default branch,
pulling in any new commits from main/master. The default branch itself is
not modified.

If conflicts arise during the rebase, they are automatically resolved.
By default, the worktree's (feature branch) version wins. Use --strategy=theirs
to keep the default branch version instead.

Strategies:
  ours   — keep the worktree's changes (default)
  theirs — keep the default branch's changes`,
	RunE: func(cmd *cobra.Command, args []string) error {
		keepWorktree := syncStrategy != "theirs"

		worktree, err := detectWorktree()
		if err != nil {
			return err
		}
		worktreePath := filepath.Join("/workspace/worktrees", worktree)

		var result rebaseResult
		err = agentRequestJSON("POST", fmt.Sprintf("/worktrees/%s/sync", worktree), nil, &result)
		if err != nil {
			return fmt.Errorf("sync failed: %w", err)
		}

		// Loop: resolve conflicts and continue until done
		for result.Status == "conflicts" {
			fmt.Printf("Auto-resolving %d conflicted file(s)...\n", len(result.ConflictedFiles))
			for _, f := range result.ConflictedFiles {
				absPath := filepath.Join(worktreePath, f)
				if err := resolveConflictsInFile(absPath, keepWorktree); err != nil {
					return fmt.Errorf("failed to resolve %s: %w", f, err)
				}
				fmt.Printf("  resolved: %s\n", f)
			}

			result = rebaseResult{}
			err = agentRequestJSON("POST", fmt.Sprintf("/worktrees/%s/sync-continue", worktree), nil, &result)
			if err != nil {
				return fmt.Errorf("rebase-continue failed: %w", err)
			}
		}

		if result.Status == "success" {
			fmt.Printf("Worktree synced (tip: %s)\n", result.Tip)
			if result.StashConflict {
				fmt.Fprintf(os.Stderr, "\nWarning: stash pop had conflicts. Previously uncommitted changes are still stashed.\n%s\n", result.StashMessage)
				os.Exit(2)
			}
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
	vcsCmd.AddCommand(vcsRebaseMergeCmd)
	vcsCmd.AddCommand(vcsRebaseContinueCmd)
	vcsCmd.AddCommand(vcsRebaseAbortCmd)
	vcsSyncCmd.Flags().StringVar(&syncStrategy, "strategy", "ours", `Conflict resolution strategy: "ours" (keep worktree changes) or "theirs" (keep default branch changes)`)
	vcsCmd.AddCommand(vcsSyncCmd)
}

package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "bitswan-coding-agent",
	Short: "BitSwan Coding Agent CLI",
	Long: `CLI tool for BitSwan coding agents to interact with the workspace environment.

You are working inside a BitSwan workspace worktree. Your working directory
contains a checkout of a specific feature branch, isolated from the main
development branch. git is NOT installed — use only bitswan-coding-agent commands.

COMMANDS
  requirements  — Manage testable requirements for a business process
  vcs           — Version control (commit, sync, merge, diff, log)
  deployments   — Manage live-dev deployments (list, start, exec, logs)

Run any subcommand with --help for full usage details.

TYPICAL WORKFLOW

  1. Read the business process README.md and testable-requirements.toml in
     your working directory to understand the project context.

  2. Check requirements:  bitswan-coding-agent requirements list

  3. For any human-written requirement (REQ-xxx) that has no sub-requirements,
     propose sub-requirements that break it down into testable pieces:
       bitswan-coding-agent requirements add --text "..." --parent REQ-001 --status proposed
     These get AI-xxx IDs. Do NOT propose sub-requirements for AI-xxx
     requirements (to avoid infinite recursion). The user will review your
     proposals and either accept them (change to pending) or delete them.

  4. Work on a single requirement at a time. Get the next one:
       bitswan-coding-agent requirements next

  5. Check deployments and their public URLs:
       bitswan-coding-agent deployments list

  6. Test changes using the selenium testing container:
       bitswan-coding-agent deployments exec TESTING_DEPLOYMENT_ID -- pytest /app/tests/ -v

  7. Update requirement statuses as you verify them:
       bitswan-coding-agent requirements update --id REQ-ID --status pass

     Statuses:
       pending   — needs work
       pass      — automated test passes
       fail      — automated test fails
       retest    — passed but manual testing found it lacking; write a new,
                   harder/different test
       proposed  — AI-suggested requirement awaiting human review

  8. Commit when ready:
       bitswan-coding-agent vcs commit -m "implement feature X"

DIRECTORY STRUCTURE

  Each automation directory contains:
    automation.toml  — Configuration (image, port, expose, secrets)
    image/           — Custom Dockerfile for the automation
  Live-dev deployments auto-reload when source files change.

MERGING (only when the user explicitly asks)

  1. bitswan-coding-agent vcs commit -m "final changes"
  2. bitswan-coding-agent vcs rebase-and-merge
  3. If conflicts: resolve the files, then: bitswan-coding-agent vcs rebase-continue
     To abort: bitswan-coding-agent vcs rebase-abort

  Exit codes: 0 = success, 1 = conflicts (resolve and continue), 2 = stash error

SECRETS

  List env vars:  bitswan-coding-agent deployments inspect-env DEPLOYMENT_ID
  If a secret is missing, ask the user to add it in the secrets manager and
  redeploy. Secret groups are configured in automation.toml:
    [secrets]
    dev = ["group1", "group2"]
    staging = ["group1"]
    production = ["group1"]

CODING GUIDELINES

  - Do not use fallbacks. If tests fail, improve the design or error out.
  - Write DRY code. Refactor duplicate logic into shared functions.
  - Do NOT use git directly — it is not installed.`,
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func init() {
	rootCmd.AddCommand(requirementsCmd)
	rootCmd.AddCommand(vcsCmd)
	rootCmd.AddCommand(deploymentsCmd)
}

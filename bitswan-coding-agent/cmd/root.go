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

You are working inside a BitSwan workspace COPY — your own independent clone of
the project repo, checked out on a feature branch and isolated from other
copies. git is installed and ` + "`origin`" + ` is already configured to the workspace
git server.

COMMANDS
  requirements  — Manage & run testable requirements (list, add, test, update)
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

  6. Write a deterministic test for each requirement and run it. Name the test
     after the requirement's ID with hyphens turned into underscores, so a test
     for REQ-003 matches the token REQ_003 (e.g. def test_REQ_003_...). Then:
       bitswan-coding-agent requirements test --id REQ-003
     This execs the test INSIDE the BP's live-dev container and records pass or
     fail back into testable-requirements.toml for you — no manual update needed.
     Omit --id to run every requirement. The default runner is pytest
     (pytest -k REQ_003 -v); for other frameworks pass a template with {id}, e.g.
       bitswan-coding-agent requirements test --runner "go test -run {id} ./..."

  7. For anything that genuinely cannot be tested mechanically, set the status by
     hand instead:
       bitswan-coding-agent requirements update --id REQ-ID --status pass

     Statuses:
       pending   — needs work
       pass      — automated test passes
       fail      — automated test fails
       retest    — passed but manual testing found it lacking; write a new,
                   harder/different test
       proposed  — AI-suggested requirement awaiting human review

  8. Commit when ready:
       git add -A && git commit -m "implement feature X"

DIRECTORY STRUCTURE

  Each automation directory contains:
    automation.toml  — Configuration (image, port, expose, secrets)
    image/           — Custom Dockerfile for the automation
  Live-dev deployments auto-reload when source files change.

VERSION CONTROL (use normal git)

  Commit your work:
    git add -A && git commit -m "implement feature X"

  Integrate the latest main:
    git pull --rebase origin main
    (resolve any conflicts, then: git rebase --continue)

  Publish your branch:
    git push origin <your-branch>

  IMPORTANT: history on the server is fast-forward-only. NEVER use
  ` + "`git push --force`" + ` / ` + "`-f`" + ` and never rewrite commits you have already
  pushed. If a push is rejected as non-fast-forward, run
  ` + "`git pull --rebase`" + ` and push again.

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
  - Use normal git, but NEVER force-push or rewrite already-published history.`,
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func init() {
	rootCmd.AddCommand(requirementsCmd)
	rootCmd.AddCommand(deploymentsCmd)
}

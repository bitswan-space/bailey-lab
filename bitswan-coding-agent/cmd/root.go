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

You are working inside a BitSwan workspace COPY — your own working environment,
isolated from other copies. Every business-process directory under the copy
(/workspace/copies/<copy>/<bp>/) is its OWN independent git clone on branch
<copy>; the copy root itself is NOT a git repository. Run all git commands from
inside a business-process directory. git is installed and ` + "`origin`" + ` is already
configured in each clone to that business process's repo on the workspace git
server.

COMMANDS
  requirements  — The testable-requirements contract; verdicts come from runs
  deployments   — Manage live-dev deployments (list, start, exec, logs)
  browser       — Open a live-dev app in a real browser as a test user you invent

Run any subcommand with --help for full usage details.

TYPICAL WORKFLOW

  1. Read the business process README.md and testable-requirements.toml in
     your working directory to understand the project context.

  2. Check requirements:  bitswan-coding-agent requirements list

  3. For any human-written requirement (REQ-xxxx) that has no sub-requirements,
     propose sub-requirements that break it down into testable pieces:
       bitswan-coding-agent requirements add --text "..." --parent REQ-7QX4 --proposed
     These get AI-xxxx IDs and wait for the user to accept them. Do NOT propose
     sub-requirements for AI-xxxx requirements (to avoid infinite recursion).

  4. Work on a single requirement at a time. Get the next one:
       bitswan-coding-agent requirements next

  5. Check deployments and their public URLs:
       bitswan-coding-agent deployments list

  6. If the requirement is about something a person SEES, look at it. You have a
     browser and can sign in as a test user with any groups you choose:
       bitswan-coding-agent browser --help
     Reading the code is not the same as loading the page, and an app that
     renders one thing for a plain member and another for an admin can only be
     checked by being both.

  7. Write a deterministic test for each requirement. Name the test after the
     requirement's ID with hyphens turned into underscores, so REQ-7QX4 is
     tested by a test whose name contains REQ_7QX4:
       def test_REQ_7QX4_totals_include_vat():        # pytest
       func TestREQ_7QX4_TotalsIncludeVAT(t *testing.T)  # go

     Where the test file must live: INSIDE the automation directory (the one
     with automation.toml). Only that directory is mounted into the container
     the test runs in — a test elsewhere in the business process cannot be
     found. That mount is READ-ONLY, so a test must not write next to itself;
     write to /tmp.

     If the business process has MORE THAN ONE automation, say which one runs
     the tests, and which framework, in the BP's process.toml:
       [testing]
       automation = "backend"     # required when there is more than one
       framework  = "go"          # or "pytest"

     If it MIXES LANGUAGES, give each automation its own section — the BP-wide
     framework applies to all of them otherwise, and a pytest suite parsed as
     go test output reports "no test" for tests that ran and passed:
       [testing.new-worker]
       framework  = "pytest"

     A single requirement can override automation, framework or runner with its
     own key in testable-requirements.toml. Naming the framework is enough; the
     built-in runner for it is then correct.

     The test tooling must be installed in that automation's own image (e.g.
     pytest in its image/requirements.txt), then rebuilt with
     "bitswan-coding-agent deployments build-and-restart <deployment-id>".

  8. Commit. THE TESTS RUN THEMSELVES — every commit starts a run, the way CI
     does; you do not have to trigger one:
       git add -A && git commit -m "implement REQ-7QX4"
     Then read the verdicts:
       bitswan-coding-agent requirements list
     and fix whatever did not pass. To force a re-run without committing
     (a flaky test, a container that was down):
       bitswan-coding-agent requirements test --failed

     YOU CANNOT SET A VERDICT. There is no "requirements update --status": a
     verdict is produced by running the test and by nothing else, and it comes
     from the test report rather than an exit code — a runner that matched no
     test reports "no test", never a pass. If a requirement genuinely cannot be
     tested mechanically, say so to the user and leave it untested rather than
     writing a test that always passes.

     Verdicts:
       pass     — a test carrying this ID ran and passed
       fail     — it ran and failed (or the suite did not build)
       blocked  — a parent requirement is failing, so this was not run. Fix the
                  parent first: a parent is a precondition for its children.
       no_test  — no test carries this ID yet
       queued / running — the current run has not reached it

     A requirement's verdict belongs to the code that was on disk when it ran.
     Change the code and it goes stale until the next run.

DIRECTORY STRUCTURE

  Each automation directory contains:
    automation.toml  — Configuration (image, port, expose, secrets)
    image/           — Custom Dockerfile for the automation
  Live-dev deployments auto-reload when source files change.

VERSION CONTROL (use normal git, always from inside a business-process dir)

  Commit your work:
    git add -A && git commit -m "implement feature X"

  Integrate the latest main:
    git pull --rebase origin main
    (resolve any conflicts, then: git rebase --continue)

  Publish your branch:
    git push origin <your-branch>

  Each business process is a SEPARATE repository: committing/pushing in one
  never publishes another business process's changes. Never run git from the
  copy root, and never run git in a business-process directory other than the
  one you are working on.

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

MEMORY

  Declare each automation's memory budget in automation.toml so the platform can
  reserve capacity and never let one process starve another.
    [deployment]
    memory-reservation = 256                 # MB budgeted for this container
    memory_reservation_policy = "on-demand"  # "on-demand" (default) | "always-on"

  memory-reservation (MB): set it just above the container's real peak. Declare it
  before promoting to staging/production (undeclared defaults to 50 MB and warns).

  memory_reservation_policy:
    on-demand (default) — may be shut down under memory pressure and is woken
      automatically the next time it is accessed. Use for request-serving
      frontends/backends and anything idle-tolerant. On-demand services share a
      bounded pool, so you can keep many rarely-used processes at no standing cost.
    always-on — never auto-shut-down. Use ONLY for a backend that must keep
      running with no inbound request to wake it: background schedulers, queue/
      stream consumers, cron-like loops. It holds its full reservation permanently
      and counts against the always-on budget, so keep these few and tight.

  A container whose real usage exceeds its reservation raises a SIEM alert and is
  flagged red on the dashboard Containers tab. Inspect a deployment's effective
  values with:  bitswan-coding-agent deployments inspect DEPLOYMENT_ID
  (see the gitops.mem_reservation_mb / gitops.mem_policy labels).

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

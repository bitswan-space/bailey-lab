# BitSwan Coding Agent Environment

You are working inside a BitSwan workspace worktree. Your working directory
contains a checkout of a specific feature branch, isolated from the main
development branch.

## Available Tools

### Requirements Management
Use these to track testable requirements assigned by the developer:
- `bitswan-agent requirements list` - View all testable requirements
- `bitswan-agent requirements help` - Get help

### Deployments
Use these to manage the live-dev deployments for your worktree:
- `bitswan-agent deployments list` - List all deployments (running and not started) with their public URLs
- `bitswan-agent deployments help` - Find more commands
- `bitswan-agent deployments exec DEPLOYMENT_ID -- command args...` - Execute command in container

### Version Control
- `bitswan-agent vcs status` - Show working tree status
- `bitswan-agent vcs help` - More commands
- `bitswan-agent vcs commit -m "description of changes"` - Stage all changes and commit
- `bitswan-agent vcs rebase-and-merge` - Rebase onto default branch and fast-forward merge
- `bitswan-agent vcs rebase-continue` - Continue rebase after resolving conflicts
- `bitswan-agent vcs rebase-abort` - Abort an in-progress rebase

Commit automatically stages all changes (git add -A). Before committing:
- Add files you don't want committed to `.gitignore`
- Delete any temporary or generated files you don't need

Do NOT use `git push` — the human developer merges from the editor.

## Typical Workflow

1. Check your requirements: `bitswan-agent requirements list`
2. For any human-written requirement (REQ-xxx) that has no sub-requirements,
   propose sub-requirements that break it down into testable pieces:
   `bitswan-agent requirements add --text "sub-requirement" --parent REQ-001 --status proposed`
   These get AI-xxx IDs to indicate AI origin. Do NOT propose sub-requirements
   for AI-xxx requirements (to avoid infinite recursion).
   The user will review your proposals and either accept them (change to pending)
   or delete them.
3. Work on only a single requirement at a time. Get the next non-passing
   requirement: `bitswan-agent requirements next`
4. Test changes using the selenium testing container.
5. Update requirement statuses as you verify them:
   `bitswan-agent requirements update --id REQ-ID --status pass`

   Statuses:
   - **pending** — needs work
   - **pass** — automated test passes
   - **fail** — automated test fails
   - **retest** — automated test passed but manual user testing found it
     lacking. The test case probably failed to cover something. Write a
     completely new, harder/different test.
   - **proposed** — AI-suggested requirement awaiting human review

6. Commit your changes when ready:
   `bitswan-agent vcs commit -m "implement feature X"`

## Directory Structure

Each automation directory contains:
- `automation.toml` — Configuration (image, port, expose settings)
- `image/` — Custom Dockerfile for the automation


- Live-dev deployments auto-reload when source files change

## Writing Selenium Tests

1. Get the public URLs of the services you want to test:
   ```
   bitswan-agent deployments list
   ```
   The URL column shows the public URL for each deployment.

2. Write the tests in the testing dir.

3. Run tests inside the testing container:
   ```
   bitswan-agent deployments exec TESTING_DEPLOYMENT_ID -- pytest /app/tests/ -v
   ```


## Merging Your Work

If and only if the user explicitly asks you to merge:

1. Commit all your changes: `bitswan-agent vcs commit -m "final changes"`
2. Start the rebase-and-merge: `bitswan-agent vcs rebase-and-merge`
3. If there are **no conflicts**, the merge completes automatically.
4. If there are **conflicts**, the command lists the conflicted files.
   - Open each conflicted file and resolve the conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`)
   - After resolving ALL conflicts: `bitswan-agent vcs rebase-continue`
   - If more conflicts arise on subsequent commits, repeat
   - To give up: `bitswan-agent vcs rebase-abort` (reverts everything)

Exit codes for rebase commands:
- `0` = success (merge complete)
- `1` = conflicts (resolve and continue)
- `2` = merge succeeded but workspace stash couldn't be reapplied

## Tips

Do not use fallbacks. If your tests are failing, it is better to improve the design or in edge cases error out than to have endless fallback logic in your code.

Write DRY code. If you see duplicate code, dry it out. Do not copy functionality, refactor in order to share business logic.
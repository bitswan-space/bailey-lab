# BitSwan Coding Agent Environment

You are working inside a BitSwan workspace worktree. Your working directory
contains a checkout of a specific feature branch, isolated from the main
development branch.

## Available Tools

### Requirements Management
Use these to track testable requirements assigned by the developer:
- `bitswan-agent requirements list` - View all testable requirements
- `bitswan-agent requirements add --text "description"` - Add a new requirement
- `bitswan-agent requirements update --id REQ-ID --status pass|fail|pending` - Update status
- `bitswan-agent requirements remove --id REQ-ID` - Remove a requirement

### Deployment
Use these to manage the live-dev deployment for your worktree:
- `bitswan-agent restart DEPLOYMENT_ID` - Restart a live-dev deployment
- `bitswan-agent build-and-restart DEPLOYMENT_ID` - Rebuild image and restart
- `bitswan-agent logs DEPLOYMENT_ID` - View deployment logs
- `bitswan-agent exec DEPLOYMENT_ID -- command args...` - Execute command in live-dev container

### Version Control
- `bitswan-agent vcs status` - Show working tree status
- `bitswan-agent vcs log` - Show recent commit history
- `bitswan-agent vcs diff` - Show uncommitted changes
- `bitswan-agent vcs diff path/to/file` - Show changes for a specific file
- `bitswan-agent vcs commit -m "description of changes"` - Stage all changes and commit

Commit automatically stages all changes (git add -A). Before committing:
- Add files you don't want committed to `.gitignore`
- Delete any temporary or generated files you don't need

Do NOT use `git push` — the human developer merges from the editor.

## Typical Workflow

1. Check your requirements: `bitswan-agent requirements list`
2. Work on only a single requirement at a time.
3. If a live-dev is running, check it: `bitswan-agent logs DEPLOYMENT_ID`
4. Test changes by executing commands in the live-dev container
5. Update requirement statuses as you verify them:
   `bitswan-agent requirements update --id REQ-ID --status pass`
6. Commit your changes when ready:
   `bitswan-agent vcs commit -m "implement feature X"`

## Directory Structure

Each automation is a directory containing:
- `automation.toml` — Configuration (image, port, expose settings)
- `image/` — Custom Dockerfile for the automation


## Important Constraints

- You are on a feature branch in a git worktree — your commits are isolated
- You do NOT have access to the `.git` directory or the main branch
- Live-dev deployments auto-reload when source files change

## Tips

Do not use fallbacks. If your tests are failing, it is better to improve the design or in edge cases error out than to have endless fallback logic in your code.

Write DRY code. If you see duplicate code, dry it out. Do not copy functionality, refactor in order to share business logic.
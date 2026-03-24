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

Commit automatically stages all changes (git add -A). Before committing:
- Add files you don't want committed to `.gitignore`
- Delete any temporary or generated files you don't need

Do NOT use `git push` — the human developer merges from the editor.

## Typical Workflow

1. Check your requirements: `bitswan-agent requirements list`
2. Work on only a single requirement at a time. Get the next requirement that you should fulfill using `bitswan-agent requirements next`.
3. Test changes using the selenium testing container.
4. Update requirement statuses as you verify them:
   `bitswan-agent requirements update --id REQ-ID --status pass`
5. Commit your changes when ready:
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


## Tips

Do not use fallbacks. If your tests are failing, it is better to improve the design or in edge cases error out than to have endless fallback logic in your code.

Write DRY code. If you see duplicate code, dry it out. Do not copy functionality, refactor in order to share business logic.
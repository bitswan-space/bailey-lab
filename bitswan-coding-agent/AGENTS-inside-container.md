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
- `bitswan-agent deployments list` - List all deployments (running and not started) with their public URLs
- `bitswan-agent deployments start DEPLOYMENT_ID` - Start a live-dev deployment
- `bitswan-agent deployments exec DEPLOYMENT_ID -- command args...` - Execute command in live-dev container
- `bitswan-agent restart DEPLOYMENT_ID` - Restart a live-dev deployment
- `bitswan-agent build-and-restart DEPLOYMENT_ID` - Rebuild image and restart
- `bitswan-agent logs DEPLOYMENT_ID` - View deployment logs

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

## Writing Selenium Tests

To write end-to-end browser tests against your deployed services:

1. Create a testing automation with `external-testing-network = true` in its `automation.toml`:
   ```toml
   [deployment]
   expose = false
   external-testing-network = true
   ```
   This puts the container on an isolated network with outbound internet access,
   so it can reach public URLs like a real external client.

2. Get the public URLs of the services you want to test:
   ```
   bitswan-agent deployments list
   ```
   The URL column shows the public URL for each deployment.

3. Write pytest tests using Selenium with headless Chrome:
   ```python
   from selenium import webdriver
   from selenium.webdriver.chrome.options import Options

   opts = Options()
   opts.add_argument("--headless=new")
   opts.add_argument("--no-sandbox")
   driver = webdriver.Chrome(options=opts)
   driver.get("https://your-deployment-url.example.com")
   assert "Expected Title" in driver.title
   driver.quit()
   ```

4. Run tests inside the testing container:
   ```
   bitswan-agent deployments exec TESTING_DEPLOYMENT_ID -- pytest /app/tests/ -v
   ```

5. Pass the target URL as an environment variable:
   ```
   bitswan-agent deployments exec TESTING_DEPLOYMENT_ID -- env TARGET_URL=https://... pytest /app/tests/
   ```

## Tips

Do not use fallbacks. If your tests are failing, it is better to improve the design or in edge cases error out than to have endless fallback logic in your code.

Write DRY code. If you see duplicate code, dry it out. Do not copy functionality, refactor in order to share business logic.
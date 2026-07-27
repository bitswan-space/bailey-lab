# Working in this copy

You are Claude Code running inside a Bitswan coding-agent container, working
on one copy of a business process. The copy's source is this directory; it
deploys through the workspace's gitops pipeline.

## Seeing the frontend like a browser does

A Playwright browser MCP server is registered for this copy (`.mcp.json`).
Use its `browser_*` tools to diagnose frontend issues yourself — navigate,
read console messages, inspect failed network requests, snapshot the page,
take screenshots — instead of asking the user to relay what they see. The
browser is headless Chromium, already configured with the sandbox flags this
container requires.

### Reaching a deployed frontend — the recipe

1. List this copy's deployments (the copy name is this directory's parent
   under `/workspace/copies/`):

   ```
   curl -s -H "Authorization: Bearer $BITSWAN_GITOPS_AGENT_SECRET" \
     "$BITSWAN_GITOPS_URL/agent/deployments?copy=<copy-name>"
   ```

2. Each record's `url` field is the public HTTPS address. Its **first DNS
   label** is the container's hostname on the workspace dev network, which
   this container is attached to. Deployed services listen on **port 8080**:
   `https://demo-app-frontend-ab12-live-dev.example.com` →
   `http://demo-app-frontend-ab12-live-dev:8080/`.

3. Point the `browser_navigate` tool at that internal URL. No login gate
   applies on the direct path.

The direct path is currently the **only** path available from this
container: the public `https://…` URL sits behind the workspace login
(Keycloak), and no agent credentials exist yet — there is no account the
headless browser could log in with, and this container deliberately has no
network route to the public hostname anyway. A per-workspace agent account
that logs in through the real gate is planned (bailey-lab#232); until it
lands, be clear about what the direct path can and cannot tell you:

- **Trustworthy:** the frontend as the dev server serves it — markup,
  console errors, failed asset/API requests, rendering. The login gate does
  not rewrite app content, so these match what a logged-in user's browser
  receives.
- **Out of reach:** anything identity- or gate-dependent. Requests on the
  direct path carry no user identity and no session cookie, so
  identity-aware backend behavior, login redirects, and the gate's own
  quirks (e.g. its WebSocket handling) are not reproduced here. If an issue
  only makes sense "after login," say plainly that this environment cannot
  reproduce it — do not guess.

Do not spoof or reuse the public hostname to satisfy Host checks — a Host
header that lies about where the browser is actually pointed produces
conclusions that don't transfer to real users. If the direct internal URL
fails, fix the cause instead:

- **Vite 403 "Blocked request. This host … is not allowed"** (live-dev
  copies): the dev server vets the Host header via `allowedHosts`. Current
  templates accept the internal hostname through the
  `BITSWAN_INTERNAL_HOSTNAME` env var; a copy created before that existed
  needs its `frontend/vite.config.mjs` `allowedHosts` extended with the
  internal hostname. Mind the live-dev serving model: the deployment runs
  from the **gitops server's checkout of your branch, not this working
  tree** — an uncommitted edit here changes nothing. Commit and push the
  config fix, then restart the deployment (Vite does not reliably reload a
  config swapped in underneath it):

  ```
  git add frontend/vite.config.mjs && git commit -m "..." && git push
  bitswan-coding-agent deployments restart <frontend-deployment-id>
  ```

  The deployment's `state` stays `running` through all of this — don't
  poll it for a change. `bitswan-coding-agent deployments` also offers
  `exec`, `logs`, and `inspect-env` for checking what the running
  container actually sees.
- **Hostname does not resolve**: the deployment is not on the dev stage.
  Staging and production are on networks this container deliberately cannot
  reach — test on dev.
- **401 from backend routes** (`/internal/*` in AOC mode): those require a
  Bearer token over the direct path. Expected, not a bug you introduced.

### Scripted automation

For automation beyond the MCP tools (load loops, custom probes), the same
Playwright install is scriptable: `require('playwright')` from a CommonJS
script (`.cjs`; ESM ignores the module path) and launch with
`chromium.launch({ channel: 'chromium', args: ['--no-sandbox'] })` — the
`channel` targets the installed chrome-for-testing build; a bare `launch()`
looks for a headless-shell binary that isn't installed.

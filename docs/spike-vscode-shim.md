# Spike: a partial `vscode` API inside the dashboard

Status: **experiment**, branch `spike/vscode-sidebar-agent`. Nothing is wired into
the dashboard UI or a release path yet.

Goal: run the Claude Code VS Code extension's sidebar inside the dashboard by
implementing enough of the `vscode` API ourselves — no code-server, no embedded
IDE.

## It works, and the surface is small

`activate()` **resolves in ~320ms** against a hand-written shim of roughly 350
lines. It registers **25 commands** and **all three webview views**, and shows no
error to the user:

```
activate() RESOLVED in 322ms
registered commands         : 25
webview view ids            : ["claudeVSCodeSidebar","claudeVSCodeSidebarSecondary","claudeVSCodeSessionsList"]
messages shown to the user  : []
```

All three views then **resolve to real HTML**:

```
view claudeVSCodeSidebar: html 2766 bytes
  options : {"enableScripts":true,"localResourceRoots":[.../webview, .../resources]}
  refs    : [".../webview/index.css", ".../webview/index.js"]
```

So the sidebar is a self-contained web bundle behind a `postMessage` channel. To
render it the dashboard needs to serve that HTML, serve two files
(`webview/index.js` ~5 MB, `webview/index.css` ~0.4 MB), and bridge messages both
ways. `asWebviewUri` rewriting already works — the refs above came back on the
dashboard's own base URL.

## Size and memory

The extension unpacks to 216 MB, but **215 MB of that is one file**:
`resources/native-binary/claude`. The actual code is ~9 MB
(`extension.js` 3.2 MB + `webview/index.js` 5.1 MB).

Removing that binary does **not** work — see bug 3 below; the extension resolves
its own copy by platform and the UI errors out without it. So disk cost is ~216 MB
per extension version until someone establishes whether it can be pointed at the
CLI already in the container.

Memory is one Node process plus ~9 MB of JS, against a code-server instance
per user.

## The measured API surface

Static analysis of `extension.js` (32 esbuild-aliased `require("vscode")` sites)
gives the whole surface, which is what makes this bounded:

| namespace | uses | distinct members |
|---|---|---|
| `window` | 89 | 26 |
| `workspace` | 87 | 19 |
| `commands` | 72 | 2 (`executeCommand` 45, `registerCommand` 27) |
| `Uri` | 38 | 4 |
| `env` | 21 | 8 |
| everything else | ~90 | 30 value/enum types |

Activation itself only touches **24 paths**, of which 19 are implemented and 5
are harmless stubs (`NotebookCellOutputItem`, `registerWebviewPanelSerializer`,
`createStatusBarItem`, `registerUriHandler`).

## Two interop traps worth knowing

Both cost real debugging time and will bite anyone who touches this:

1. **Do not expose `__esModule`.** The bundle does
   `__toESM(require("vscode"))`; a truthy `__esModule` makes esbuild treat the
   shim as already-ESM and read `.default`, which fails with
   `Cannot read properties of undefined`. The real `vscode` is CJS.
2. **The shim module must be enumerable.** `__toESM` *copies own keys* off the
   module object, so a catch-all `get` proxy at the module level is bypassed
   forever after the copy. Top-level names must therefore exist up front (hence
   the static analysis), and fallthrough recording has to live on each namespace
   object instead.

The extension also wants a `LogOutputChannel` — `createOutputChannel` must return
`trace/debug/info/warn/error`, not just `append`.

## How to iterate

`recorder.ts` + `stub.ts` make the extension report its own requirements: every
unimplemented path is recorded and stubbed rather than thrown, so activation runs
to completion and prints an ordered list of what is missing. Implement, re-run,
repeat.

```
CLAUDE_EXTENSION_PATH=<unpacked extension/> \
PROBE_WORKSPACE=<a BP dir> \
node --import tsx src/vscode-host/probe.ts
```

### The two loops

Local, no gate — the shim host plus a mock Anthropic API, started by the config
itself:

```
cd e2e && npx playwright test -c playwright.vscode-host.config.ts
```

Against the real deployment, through the real gate. `tests/spike/gated.ts` signs
in with OIDC and then approves *this browser's own* pairing code with the
operator CLI, which is what makes the loop runnable without a human:

```
cd e2e && GATED_PASSWORD=… npx playwright test -c playwright.gated.config.ts
```

That runs every `gated-*.spec.ts`: the panel renders and the terminal is gone,
a pasted and a dropped image reach the agent, an oversized file downloads, and
the description saves without a failure toast. The default config ignores
`spike/**`, so none of this runs in CI.

## The sidebar actually renders, and is tested

`e2e/tests/vscode-host.spec.ts` + `e2e/playwright.vscode-host.config.ts` drive the
whole thing in a real Chromium, starting the shim host themselves:

```
CLAUDE_EXTENSION_PATH=<unpacked extension/> PROBE_WORKSPACE=<a BP dir> \
npx playwright test -c playwright.vscode-host.config.ts
```

Passing, with the real UI on screen — prompt box, model picker reading
"Opus 5 (1M) High", Auto permission mode, session history:

```
dom nodes            : 131
bridge log           : ["open","toExt","fromExt","fromExt","toExt", ...]
messages to extension: 12
console errors       : []
page errors          : []
failed requests      : []
```

The webview↔extension protocol is live in both directions. The first twelve
messages are `init`, `get_claude_state`, `get_current_selection`,
`get_asset_uris`, `list_sessions_request` — so `dev-server.ts` is a working
reference for what the dashboard has to bridge.

The extension also starts its own IDE integration server on activation
(`Created lock file at ~/.claude/ide/<port>.lock`, `CLAUDE_CODE_SSE_PORT`), which
is how the CLI attaches to an IDE. That works unmodified under the shim.

### Three bugs the browser found that static analysis could not

1. **`asWebviewUri` produced `file:///asset/...`** for a relative resource base —
   `ShimUri.parse` fell through to `ShimUri.file` on a relative URL, and every
   asset 404'd. It now returns a path-only URI when the base has no scheme.
2. **CSP: `style-src 'unsafe-inline' 'nonce-…'` silently blocks inline styles** —
   a nonce in the list makes `'unsafe-inline'` ignored, so the UI rendered
   unstyled. `font-src` also needs `data:` for the bundled base64 fonts.
3. **The bundled binary is not optional.** Omitting
   `resources/native-binary/claude` gives
   `Unsupported platform: linux-x64. No compatible Claude Code binary found.`
   thrown repeatedly from the webview. So the earlier "215 MB of the 216 MB is
   just the binary, and the container already has a CLI" note does **not** mean
   we can drop it — the extension resolves its own copy by platform. Whether it
   can be pointed at an existing CLI is still open, and it is the single biggest
   lever on install size.

## Interaction: what works, and what auth actually requires

`tests/spike/vscode-host-interaction.spec.ts` drives the composer against a mock
Anthropic API (`mock-anthropic.ts`, started by the dev host on a random port with
`ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` pointed at it).

**Image paste works.** Synthesising a real `ClipboardEvent` with a PNG `File`:

- the app calls `preventDefault()` and handles it itself (the composer is
  `contenteditable="plaintext-only"`, so it must)
- an attachment chip renders reading **`pasted.png 24x24`**, with a thumbnail —
  the webview decodes the PNG and reads its dimensions
- **no bridge traffic at paste time**: the image is held entirely in the webview
  until the turn is submitted

On submit (in the run that had working credentials) the CLI sent
`POST /v1/messages` with block types `["text","image","text","text"]` — **one
`image` block** — and the mock's reply streamed back and rendered in the
transcript. So the whole path works: paste -> chip -> CLI -> API image block.

**Auth is the blocker, and it is narrower than "does the mock work".** Measured:

| Surface | `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL` |
|---|---|
| the bundled `claude` CLI (`-p "..."`) | **sufficient** — hits the mock, streams a reply |
| the extension's sidebar | **not sufficient** — falls back to "How do you want to log in?" |

The extension has its own login gate on top of the CLI's credential resolution.
Getting past it needs either a seeded credential store or the OAuth flow; env vars
alone do not do it.

### Two false alarms, recorded so nobody re-chases them

Both were **my** bugs, not the product's:

1. **The "config leak".** An early run had the mock echoing text from the
   *hosting* Claude Code session, which looked like `CLAUDE_CONFIG_DIR`
   defaulting to a shared `~/.claude`. It was not. The request carries a
   `role: "system"` message *after* the user turn (a mid-conversation system
   message), and the mock was reading `messages[messages.length - 1]`. It now
   picks the last `role === "user"` message and strips `<system-reminder>`
   blocks. There was no leak.
2. **"The API-key path works, no sign-in needed."** That reading came from a run
   where `CLAUDE_CONFIG_DIR` was unset and the extension reused the ambient
   developer's *already authenticated* `~/.claude`. With an isolated config dir
   the sidebar asks for login. The dev host now always sets an isolated
   `CLAUDE_CONFIG_DIR` so this cannot flatter a result again.


## Requirement: one Claude account per user, not per workspace

Joe signs in as Joe, Sally as Sally, in the same workspace. Today the hosted
sidebar does not do this, and the reason is not a path — it is process shape.

The extension reads `CLAUDE_CONFIG_DIR` from the environment at activation, and
the `claude` process it spawns inherits it. The dashboard activates the
extension **in its own Node process**, and `process.env` is global to that
process: setting it per request cannot work, because the CLI is spawned later
and would pick up whichever value was written last. Two people in one workspace
would share — or clobber — one identity, and the credential store is the thing
being shared.

So the fix is a **child extension host per user**: spawn
`node vscode-host/<worker>.js` per (user, copy, bp) with `CLAUDE_CONFIG_DIR` set
in that child's env, and bridge its messages to the websocket instead of calling
`activateExtension` in-process. That is also how VS Code is arranged — the
extension host is a separate process — so it is the shape to grow into rather
than a workaround.

The per-user directory name should come from the same place the terminal path
already takes it: `agent-session-wrapper` sanitises the gate-verified email
(lowercase, non-alphanumerics to `_`, truncated, plus 8 hex of its sha256) so
that an RFC-valid local part containing `/` or `..` cannot escape. Reuse that
derivation rather than inventing a second one, and key the host cache on it.

Until then this spike is single-identity per workspace, and
`CLAUDE_CONFIG_DIR` is set to one mounted directory so at least a container
recreate does not sign the user out.

## Per-user hosts, and the rest of the webview contract

The per-user extension host is now built: `vscode-host/worker.ts` is forked per
(user, copy, bp) with `CLAUDE_CONFIG_DIR=<config root>/<email slug>`, and the
parent (`services/vscode-sidebar.ts`) speaks a small IPC protocol to it —
`open` / `toExt` / `close` in, `ready` / `opened` / `toWebview` / `openExternal`
out. Verified in the deployed workspace: the forked worker and the `claude` it
spawns both carry the slug directory, and the directory is created on the host
mount. Idle hosts with no attached webview are reaped after 30 minutes, so an
abandoned tab does not hold a Node process and a CLI forever.

Hosting the panel also needs three parts of the webview contract that are easy
to miss because the panel renders without them:

- **The theme-kind class.** VS Code puts `vscode-light` / `vscode-dark` on the
  webview `body` and the bundle reads it (`isDark = !body.classList.contains
  ('vscode-light')`), so with no class the panel silently chooses dark: dark
  welcome art on our light background, and every `.vscode-light`-scoped rule
  (including the button borders) inert. We stamp the class plus
  `data-vscode-theme-kind`.
- **Asset URIs, and the race behind them.** The panel asks the extension for
  `get_asset_uris` only after `init` resolves, and it renders the login view in
  that same turn — so over a websocket + IPC hop the answer lands ~60ms after
  the `<img>` has already mounted with `src=""`, and nothing re-renders it
  (that context's signals do not drive this view). The panel therefore has to
  have the map *before* it asks: the worker pre-fetches it at open time, the
  page inlines it as `window.__bitswanAssetUris`, the injected bridge answers
  the request locally, and the inlined bundle's `assetUris` signal is seeded
  with it. The seed is a regex over the bundle text and fails open — a bundle
  that no longer matches loses the welcome art, nothing else.
- **`env.openExternal`.** Swallowing it makes every external link and the whole
  OAuth hand-off dead. It is relayed out of the host, but the reliable open is
  the one the bridge does synchronously when it sees the panel's own `open_url`
  request, because that is still inside the click's user activation. The iframe
  carries `allow-popups-to-escape-sandbox` so the opened tab is not itself
  sandboxed, and a blocked popup falls back to a clickable link in the panel.

`ExtensionContext.globalState` / `workspaceState` are now files under the user's
config directory instead of an in-memory map, so onboarding flags and experiment
gates survive a restart — and `showTerminalBanner` defaults to false, since this
deployment has no terminal to fall back to.

## One deployment gotcha

Rebuild the client while the dashboard container runs, and the app stops
booting: every module script comes back as `index.html`, the browser refuses
`text/html` as a module, and you get an empty frame inside a perfectly
healthy-looking gate. Two gated tests "failed" that way before the cause was
obvious.

The reason is `@fastify/static`'s `wildcard: false`, which enumerates the
bundle once at registration: a file written afterwards has no route and falls
through to the SPA fallback. (The giveaway is that a stylesheet often still
works — its content hash tends not to change between builds, so its route is
still the one registered at startup.) The server now uses the wildcard route
when it is serving a mounted source tree, so a dev rebuild is served without a
restart; a baked image keeps the enumerated routes.

## What is not done

- **Rendering isolation is an open question.** VS Code runs webview HTML in a
  sandboxed frame for a reason: this is extension-authored HTML with
  `enableScripts: true`, and putting it straight into the dashboard's DOM would
  give it the dashboard's origin, cookies and gate. It needs *some* isolation
  boundary — that does not have to be an embedded IDE, but it cannot be nothing.
- **Auth.** Now measured, not unknown: the CLI accepts env-var credentials, the
  sidebar does not. Seeding a credential store, or hosting the OAuth redirect, is
  the next real piece of work and still the biggest risk.
- **Where the host process runs.** The coding-agent container is deliberately
  network-isolated from the dashboard and holds the working tree, which argues
  for running the host there and speaking to it over the existing SSH channel.
- **The 5 stubs.** All benign for activation; `createStatusBarItem` and
  `registerUriHandler` may matter once sign-in is attempted.

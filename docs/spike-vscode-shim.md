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

## What is not done

- **No dashboard UI.** The next step is serving `html` + the two assets and
  bridging `postMessage` over the existing websocket.
- **Rendering isolation is an open question.** VS Code runs webview HTML in a
  sandboxed frame for a reason: this is extension-authored HTML with
  `enableScripts: true`, and putting it straight into the dashboard's DOM would
  give it the dashboard's origin, cookies and gate. It needs *some* isolation
  boundary — that does not have to be an embedded IDE, but it cannot be nothing.
- **Auth.** Whether the extension's sign-in works without a real browser
  redirect host is still unknown, and is the biggest risk to the whole idea.
- **Where the host process runs.** The coding-agent container is deliberately
  network-isolated from the dashboard and holds the working tree, which argues
  for running the host there and speaking to it over the existing SSH channel.
- **The 5 stubs.** All benign for activation; `createStatusBarItem` and
  `registerUriHandler` may matter once sign-in is attempted.

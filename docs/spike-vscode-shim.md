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

## Why this is cheap

The extension unpacks to 216 MB, but **215 MB of that is one file**:
`resources/native-binary/claude`. The actual code is ~9 MB
(`extension.js` 3.2 MB + `webview/index.js` 5.1 MB). The container already has a
`claude` CLI, so whether we ship the bundled binary at all is a separate,
testable question — and the answer decides almost the entire disk cost.

Memory is one Node process plus that JS, against a code-server instance per user.

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

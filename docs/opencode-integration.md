# OpenCode in the Coding Agent tab

The Coding Agent tab offers two agents: Claude Code and OpenCode. Both run only
inside the workspace's coding-agent container; the dashboard never runs an agent
itself. This note covers how the OpenCode half works, what it depends on, and
how to upgrade it. Forgejo issue #270 is the origin of the feature.

## What the person sees

- On the first visit to the Coding Agent tab the chat pane asks: Claude Code or
  OpenCode. The choice is saved to the person's profile (`PUT /api/me/preferences`,
  a file in their per-user directory) and follows them across browsers.
- Settings has a "Coding agent" card for every role that changes it. Switching
  drops the other agent's panels; each agent keeps its own conversations.
- Buttons that hand the agent a task ("Build automation", "Write tests", a sync
  or merge conflict) behave per agent: Claude Code's composer is prefilled and
  the person presses send, because the extension offers no way to send for
  them; OpenCode's API can create a conversation and send the prompt but cannot
  prefill its UI, so the task is sent and the panel opens the new conversation.

## Shape

```
browser — dashboard iframe, same origin as the dashboard
  /server/<b64 origin>/session/<id>   /_assets/*   /icons/*   /api/session…   WS /api/pty/<id>/connect
        │
        ▼  dashboard (Fastify)                         identity = X-Forwarded-Email from the gate
        │    routes/opencode.ts: encapsulated plugin, raw-body /api/* routes + terminal WS bridge
        │    server.ts setNotFoundHandler → forwardShell(): the UI's pages and static files
        │    @fastify/reply-from → http://127.0.0.1:<local port>, Basic credentials added
        ▼
        ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remote>   one per user, via <ws>-gitops:2222
        ▼
  coding-agent container: opencode serve --hostname 127.0.0.1 --port <free>   one per user
        XDG_* = /claude-config/<email slug>/opencode/{config,data,cache,state}
        OPENCODE_CONFIG = /etc/bitswan/opencode.json
        $XDG_CONFIG_HOME/opencode/AGENTS.md → /workspace/AGENTS.md
```

**Why the dashboard's own origin.** OpenCode's web UI cannot be mounted under a
path prefix (absolute assets, a router that owns `/`, API base = page origin),
and the Bailey gate stamps every inner-host HTML response with
`frame-ancestors 'self' https://<outer>`, so a nested iframe works only when it
shares the dashboard's origin. The dashboard therefore answers for OpenCode's
paths: everything under `/api/*` that no dashboard route claims, the UI's static
files, and its page routes. Dashboard routes always win (static routes beat the
wildcard in Fastify's router), and today no `/api/<segment>` collides
(`services/opencode-server.ts` warns at start-up if an upgrade changes that).

**Why one server per user.** OpenCode keeps provider credentials, sessions and
settings in its XDG directories; one shared process would hand every user the
first user's account. `bitswan-opencode-server` (in the coding-agent image)
starts one per user from `CLAUDE_CONFIG_DIR`, which the sshd ForceCommand
wrapper sets from the gate-verified email. It picks a free loopback port,
generates a Basic-auth password, and writes `server.json` (mode 600) into that
directory — a volume the dashboard also mounts.

**Why an ssh port-forward.** The agent sits on the isolated `<ws>-agent` network
that the dashboard is deliberately not on. The forward-only connection
(`-N -L`) through the gitops TCP proxy is the same transport the terminal and
the Claude extension use; sshd's ForceCommand never runs for it.

## Requests, headers, bodies

- Only the gate-verified user reaches their server: the tunnel and credentials
  are looked up by `X-Forwarded-Email`, never by anything the client sends.
- A user whose choice is Claude Code gets a plain 404 for OpenCode paths.
- Outbound headers are an allowlist (`services/opencode-paths.ts`). The gate
  re-applies `X-Forwarded-Email/-Groups/-Access-Token` to every request and
  browsers add cookies and `Authorization`; none of it crosses into the
  coding-agent container, where model-chosen code runs.
- `?directory=` (and `location[directory]`) must point inside
  `/workspace/copies/`. Sessions the dashboard creates are scoped to the BP
  clone; the UI's own project picker can open other directories, and the
  agent can `cd` anywhere its uid allows, as with Claude Code — this is not a
  sandbox.
- The `/api/*` forwarder is an encapsulated Fastify plugin with a catch-all
  content-type parser that hands the raw stream through. Without it the parent's
  JSON parser would buffer and size-limit (1 MiB) a prompt carrying an image,
  reject unknown content types with 415, and leave multipart bodies to a plugin
  that only flags them.
- reply-from runs with undici `bodyTimeout: 0`: OpenCode's event stream
  (`/api/event`) stays open for as long as the panel does. Only idempotent
  methods are ever retried, so a prompt is never sent twice.
- The terminal's WebSockets (`/api/pty/{id}/connect`,
  `/api/experimental/persistent-pty/{id}/connect`) are bridged with the `ws`
  client; `@fastify/websocket` upgrades only registered routes, so these are
  spelled out.
- Non-GET requests whose `Sec-Fetch-Site` is `cross-site` are refused (403):
  cheap defence in depth for a cookie-authenticated API.

## Lifecycle

- `GET /api/coding-agent/opencode/status?copy&bp` ensures the server and tunnel
  (starting the server if needed — the call waits for it) and returns the
  conversation to open: the BP's most recent one, or an empty one it creates.
  The panel opens `/server/<base64url of the page origin>/session/<id>`: the UI's
  router (2.0.16) knows only `/`, `/settings`, `/connect`, `/new-session` and
  that session page, and a session carries its own directory — so the BP is
  chosen by which session is opened, never by the URL.
- Every forwarded request touches the connection; a reaper stops servers idle
  for `OPENCODE_IDLE_TIMEOUT_MS` (default 30 min) that report no active
  session (`GET /api/session/active`), so a run that outlived its browser tab
  is not killed. Each server is a Bun process of a few hundred MB and the agent
  compose has no memory limit; the reaper is the only bound.
- A 502 from the forwarder (nobody listening) forgets the connection; the next
  request re-asks the script, which reports a still-running server or starts a
  new one. `server.json` persists across container recreation but pids do not,
  so the script trusts a pid only if `/proc/<pid>/cmdline` is opencode and the
  server answers with its password.

## Configuration

`/etc/bitswan/opencode.json` (`OPENCODE_CONFIG`) holds the image-level defaults:
every permission allowed (`permissions: [{action:"*", resource:"*", effect:"allow"}]`,
parity with Claude Code's bypass mode), the Playwright MCP server, `share:
"disabled"`, `update: "disable"`. A user's global `opencode.json` and a BP's own
`opencode.json` merge on top (OpenCode discovers project config from the
working directory up to the filesystem root). `update` ignores project-level
values, so a repo cannot re-enable self-updates.

**Guidance files.** Claude Code reads `CLAUDE.md` from every ancestor of the BP
clone, so the image's `/workspace/CLAUDE.md` reaches every session. OpenCode
2.x reads `AGENTS.md` only, with no `CLAUDE.md` fallback, and for a workspace
outside `$HOME` walks up no further than the project's git root — every BP
clone is its own git root, so `/workspace/AGENTS.md` would never be seen. The
one file OpenCode always loads is the user's global instruction file, so
`bitswan-opencode-server` links `$XDG_CONFIG_HOME/opencode/AGENTS.md` to
`/workspace/AGENTS.md` (the same text as `CLAUDE.md`, copied by the Dockerfile).
BP-level `CLAUDE.md` files are Claude-only; a BP can add its own `AGENTS.md`.
The `instructions` config key is accepted by 2.x but not loaded.

**Providers.** People connect their own provider in the OpenCode UI (API key or
account). Provider flows that need a callback to `localhost` cannot complete
through the dashboard; paste-a-code flows and API keys work. OpenCode's own
"add server" setting is not usable here — the UI is served through the
dashboard only.

**The built-in `opencode` provider needs no credentials.** Observed on
2.0.16 in this workspace: with nothing connected, `GET /api/provider` lists
only `opencode` (OpenCode's hosted models), and a prompt sent to a fresh
session was answered by it — code and prompt left the workspace for a
third-party service without anyone configuring anything. Whether that default
is acceptable is a workspace policy question. The switch is one statement in
`opencode.default.json`:

```json
"experimental": { "policies": [{ "action": "provider.use", "resource": "opencode", "effect": "deny" }] }
```

A denied provider disappears from the catalog and model selection even with
valid credentials. The same mechanism (`provider.use` deny `*`, then allow a
list) restricts a workspace to approved providers; not wired up yet.

## Known limits

- Everything in the coding-agent container runs as one uid, so a malicious run
  could read another user's `server.json` and drive that server — exactly as it
  could read another user's Claude credentials today. Env or stdin transport
  would not help (`/proc/<pid>/environ` is readable too). Per-user uids or a
  dedicated origin would be the hardening.
- The OpenCode UI shares the dashboard's origin, like the Claude webview does
  (its sandbox allows same-origin).
- The gate's CSP (`img-src 'self' https://*.<domain>`) blocks OpenCode's
  external provider icons. Cosmetic.
- OpenCode's home route is `/`, which on this origin is the dashboard. The
  dashboard refuses to mount when it finds itself framed by its own origin and
  tells the parent (`bitswan-nested-dashboard`); the panel then points the frame
  back at the conversation. Same-origin is the test, not "framed at all": AOC
  embeds the dashboard from another origin on purpose.

## Upgrading OpenCode

The pin is `ARG OPENCODE_VERSION` plus the per-architecture `OPENCODE_SHA512_*`
in `bitswan-coding-agent/Dockerfile`. The binary is the npm registry tarball
`@opencode/cli-linux-<x64|arm64>` (the vendor's own `opencode.ai/v2/install`
downloads the same file); its integrity string is in the package metadata
(`https://registry.npmjs.org/@opencode/cli-linux-x64/<version>` → `dist.integrity`).
Not the official `ghcr.io/anomalyco/opencode` image: it is Alpine with a
musl-linked binary and cannot run on this glibc base. Not GitHub releases:
they stopped at 1.x.

What the dashboard depends on for a given version, all in one place each:

- `server/src/services/opencode-api.ts` — the endpoints it calls itself:
  `GET /api/info` (health), `GET /api/session?directory=` (filter), `POST /api/session`
  with `location.directory` in the body (the query is ignored on creation),
  `POST /api/session/{id}/prompt`, `GET /api/session/active`.
- `server/src/services/opencode-paths.ts` and `client/src/lib/opencodePaths.ts`
  — the UI's static prefixes (`/_assets/`, `/icons/`, `/site.webmanifest`,
  `/openapi.json`), its page routes, and the terminal WebSocket routes. The
  routes were read out of the build's own router (`Unrecognised route!` is what
  it throws for anything else); check them again after a bump.
- `bitswan-coding-agent/bitswan-opencode-server` — `GET /api/info` as the health
  probe, and the v2 config keys in `opencode.default.json`.

After a bump: run the pinned binary with `serve`, fetch `/openapi.json`, and
diff the path list against the above; then walk the verification list in the
plan (chooser → panel → prompt with an image → terminal → hand-off → switch
back to Claude Code). The start-up drift check logs any `/api/<segment>` that
collides with a dashboard route.

If 2.x ever proves unworkable, 1.18.32 (`opencode-ai` on npm, GitHub releases)
differs in: API v1 at the root (`/session`, `/event`, `/global/*`, …) plus v2
under `/api/*`, assets under `/assets/*`, OpenAPI at `/doc`, health at
`/global/health`, config keys `autoupdate` and `permission: {"*": "allow"}`.

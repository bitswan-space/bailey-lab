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
- `?directory=` (and `location[directory]`) must name the copies tree: its
  root, `/workspace/copies` (the server's working directory, which the UI
  names as its default location on every load, sometimes as an empty value),
  or a path inside it. Sessions the dashboard creates are scoped to the BP
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

## Per-panel tabs

OpenCode keeps its open-tab strip in "window-scoped" storage. The desktop app
gives every window its own id; the web build uses the fixed id `browser`, so
every frame on one origin shares one tab list under the localStorage prefix
`opencode.window.browser.dat:`. With one panel per BP on the dashboard's
origin, each panel showed the tabs the others had opened.

So the dashboard serves OpenCode's page routes itself (`serveDocument` in
`routes/opencode.ts`) and injects a small shim ahead of OpenCode's scripts
(`services/opencode-shim.ts`). The shim reads the panel's scope from
`window.name` — the iframe's `name`, `bitswan-opencode:<copy>/<bp>` — and
shadows `window.localStorage` with a wrapper that rewrites only the
window-scoped keys to `opencode.window.<scope>.dat:`. Each panel is then its
own "window"; theme, settings, the server list and the last-used project keep
their keys and stay shared. OpenCode's own CSP allows its inline theme script
by hash, so the shim's hash is added to `script-src` the same way (the gate
replaces that header on inner hosts anyway).

## Light mode by default

OpenCode follows the OS colour scheme unless the person has picked one; the
dashboard around the panel has no dark mode yet. The same injected script
seeds the unprefixed `opencode-color-scheme` key to `light` when it is absent
— the key both OpenCode's inline theme script and its app read, and the one
the app writes when the person picks a scheme in OpenCode's settings, so the
seed only ever applies to a first visit and a chosen scheme is kept.

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
third-party service without anyone configuring anything. The server-wide
provider below, with its restrict toggle on, is the switch: a denied provider
disappears from the catalogue and model selection even with valid credentials,
the built-in one included.

## Server-wide default provider

An admin can give every workspace's OpenCode one LLM API key in the Bailey
console (Admin → Coding agents), so nobody has to bring a key and the
organisation decides where prompts go. The pieces, in the order a key travels:

- **The setting** — one JSON blob in the daemon's `server_settings` table
  (`opencode_default_provider`: enabled, provider id, model id, key, restrict,
  updated by/at), read and written through `GET`/`POST
  /bailey/api/admin/opencode-provider`, admin only
  (`internal/daemon/opencode_provider.go`). The response never carries the key,
  only that one is stored and its last four characters. A blank key on save
  keeps the stored one; `enabled: false` keeps everything and removes the
  files; `clear: true` forgets it all. The provider list is OpenCode's own
  catalogue, read live from models.dev by the daemon
  (`internal/daemon/opencode_catalog.go`) exactly as OpenCode reads it at
  start-up: fetched, served for an hour, kept on disk next to bailey.db as the
  copy to serve when models.dev is unreachable, and an error when there is
  neither — nothing is checked in and there is no built-in fallback, as there
  is none in OpenCode. It offers what `/connect` offers minus the sign-in-only
  providers (GitHub Copilot's device flow; a server cannot complete one). A
  provider's fields are the environment variables the catalogue says it
  reads, classified by name: keys, tokens and secrets are write-only, names
  ending in a resource name, id, region, host or endpoint are plain settings
  shown back for editing, and Google's application credentials are a document
  the admin pastes. When every variable is a secret they are alternative
  names for one key (Google's three) and one field is shown; otherwise each
  plain setting is required and at least one secret must be given (Azure's
  resource name plus key; Bedrock's region plus a bearer token or an access
  key pair). Models come from the same catalogue, per provider on demand
  (`GET /bailey/api/admin/opencode-provider/models?provider=`), and a saved
  model must be one the catalogue lists. Servers of your own — Ollama, LM
  Studio, vLLM — are OpenCode's built-in providers, not catalogue entries:
  the console offers them whether or not models.dev answers, they take the
  server's URL (`BITSWAN_OPENCODE_SELF_HOSTED='true'` plus the base URL; the
  launcher writes `providers.<id>.settings.baseURL` and, when a key was given,
  `settings.apiKey: "{env:BITSWAN_OPENCODE_API_KEY}"`), a key is optional, and
  OpenCode reads the models from the server itself, so the model is whatever
  the server calls it. The catalogue's own key-based `lmstudio` gives way to
  the self-hosted one. A custom endpoint's key is optional too, as OpenCode
  says it is: with no key, `BITSWAN_OPENCODE_PROVIDER_ENV` is empty, the
  launcher checks nothing and writes no `env` entry. Two ways past the catalogue: an
  endpoint URL on a catalogue provider (its `settings.baseURL`, for a proxy
  or gateway with the provider's own models and API), and a custom provider —
  an id of its own, a display name, the API it speaks (one of OpenCode's
  runtime packages: OpenAI-compatible, Anthropic-compatible, OpenAI,
  Anthropic, Google), an endpoint, and either the models it serves or a
  catalogue provider whose models it inherits (`canonical`).
- **The file** — `<ws>/coding-agent-home/.bitswan/opencode-provider.env`,
  which the agent sees as `/home/agent/.bitswan/opencode-provider.env`. One
  `NAME='value'` line per setting, POSIX single-quoted because the launcher
  sources it with bash: `BITSWAN_OPENCODE_PROVIDER`,
  `BITSWAN_OPENCODE_PROVIDER_ENV`, `BITSWAN_OPENCODE_MODEL`,
  `BITSWAN_OPENCODE_RESTRICT`, an optional `BITSWAN_OPENCODE_BASE_URL`, for a
  custom provider `BITSWAN_OPENCODE_CUSTOM='true'` with `_NAME`, `_PACKAGE`,
  optionally `_CANONICAL`, and `_MODELS` (a JSON list of `{id, name}` inside
  the quotes), then every variable the provider reads that has a value —
  `ANTHROPIC_API_KEY='…'`, or `AZURE_RESOURCE_NAME='…'` and `AZURE_API_KEY='…'`,
  or `BITSWAN_OPENCODE_API_KEY` for a custom provider — the only place the
  credentials appear; `BITSWAN_OPENCODE_PROVIDER_ENV` names the first secret
  among them, the one the launcher checks. A document-valued variable
  (Google's `GOOGLE_APPLICATION_CREDENTIALS`) is written to
  `.bitswan/<VAR>.credential.json` next to the env file and the variable
  points at that path inside the container; documents of a provider that is
  no longer the one are pruned. The daemon
  writes it on save, when the agent is enabled in a workspace, and on every
  reconcile tick (60 s); only on a change, mode 600, owned by the agent user
  (the container's own chown runs only at its start), through a temp file and
  a rename. It removes the file when the setting is off. Workspaces in the
  trash or under recovery are left alone, and a missing agent home is never
  created. The file is excluded from workspace backups: the setting is the
  source of truth and the sync regenerates it after a recovery.
- **The launcher** — `bitswan-opencode-server start` sources the file when it
  is there and complete, exports the provider's env var for `opencode serve`,
  and writes `$CLAUDE_CONFIG_DIR/opencode/opencode.generated.json`: the
  document `OPENCODE_CONFIG` names (the image config) plus
  `model: "<provider>/<model>"` and, when restricted, `experimental.policies`
  with `provider.use` deny `*` then allow the provider — the last matching
  statement wins. An endpoint URL becomes `providers.<id>.settings.baseURL`;
  a custom provider's entry also carries `name`, `package`
  (`@opencode/ai/providers/<style>`), `env: ["BITSWAN_OPENCODE_API_KEY"]`, and
  `models` or `canonical`. `OPENCODE_CONFIG` then points at the generated file. No
  file: the image config, as before. The key is never written anywhere — not
  server.json, not the generated config, not the script's output — because
  `GET /api/config` is reachable from the browser through the forwarder.
  `BITSWAN_OPENCODE_PROVIDER_FILE` overrides the file's path for running the
  script outside the container.

Checked on 2.0.16 with the script and the pinned binary: the server's
environment carries the key byte for byte (a quote, `$`, a backslash and
backticks included); `GET /api/provider` lists the provider next to the
built-in `opencode` one, or alone when restricted; `GET /api/model/default`
is the configured model for a location without a config of its own. A BP's
own `opencode.json` merges on top and can set another `model` — for that BP,
and only among the providers the policy allows. A custom OpenAI-compatible
provider appears in `/api/provider` under its display name, is the default
model's provider, and is the only provider left when restricted; an override
on `anthropic` lands in its `settings.baseURL` with the provider still
listed. A location's catalogue loads
a few seconds after the location is first touched: the first `/api/provider`
answer for a new directory is empty, then a `provider.updated` event follows.

**Default agent.** The card's "Make OpenCode the default coding agent" toggle
(on for a fresh configuration) makes the daemon also write
`<ws>/claude-configs/dashboard-defaults.json` — `{"codingAgent": "opencode"}`,
world-readable, at the root the dashboard mounts as `/claude-config` — for
every workspace with the agent enabled, and only while the provider is enabled
and complete. The dashboard's `readPreferences` merges that file under a
person's own `dashboard-preferences.json`, so the Coding Agent tab opens
OpenCode without asking anyone who has not chosen, while a choice already made
(or made later in Settings) stays theirs. `/api/me` returns the effective
`preferences` and the `defaults` on their own. The file goes with the toggle,
and with the provider.

What it does not do: a running server keeps the environment it started with.
The dashboard stops idle servers after `OPENCODE_IDLE_TIMEOUT_MS` (30 minutes)
and a server with active sessions runs until it goes idle, so a new or rotated
key reaches each person's server on its next start, not at once; the console
says so. The exposure is that of any credential in the agent container:
everything there runs as the agent user, so every coding-agent run in every
workspace can read the key. Claude Code is not affected — it has a sign-in of
its own.

## Known limits

- Everything in the coding-agent container runs as one uid, so a malicious run
  could read another user's `server.json` and drive that server, or read the
  server-wide provider key — exactly as it could read another user's Claude
  credentials today. Env or stdin transport
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
  probe, the v2 config keys in `opencode.default.json`, and for the
  server-wide provider: `model: "provider/model"`, the policy statement shape
  (`{action: "provider.use", resource, effect}` under `experimental`, so
  re-check it first), the `providers.<id>` entry shape (`name`, `env`,
  `package`, `canonical`, `settings.baseURL`, `models`), the package names
  under `@opencode/ai/providers/` (`openCodePackages` in
  `internal/daemon/opencode_provider.go`; the binary's strings list them), and
  the catalogue's shape (`internal/daemon/opencode_catalog.go` reads
  `name`, `env` and `models` per provider from models.dev, and names the
  sign-in-only providers to leave out).

After a bump: run the pinned binary with `serve`, fetch `/openapi.json`, and
diff the path list against the above; then walk the verification list in the
plan (chooser → panel → prompt with an image → terminal → hand-off → switch
back to Claude Code). The start-up drift check logs any `/api/<segment>` that
collides with a dashboard route.

If 2.x ever proves unworkable, 1.18.32 (`opencode-ai` on npm, GitHub releases)
differs in: API v1 at the root (`/session`, `/event`, `/global/*`, …) plus v2
under `/api/*`, assets under `/assets/*`, OpenAPI at `/doc`, health at
`/global/health`, config keys `autoupdate` and `permission: {"*": "allow"}`.

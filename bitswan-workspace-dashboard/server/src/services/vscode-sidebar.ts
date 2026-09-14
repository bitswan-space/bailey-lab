import { fork, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../vscode-host/worker.js');
const READY_TIMEOUT_MS = 90_000;
const PROMPT_TIMEOUT_MS = 15_000;
const IDLE_EVICT_MS = 30 * 60_000;
const REAP_INTERVAL_MS = 5 * 60_000;

export function extensionPath(): string | undefined {
  return process.env.CLAUDE_EXTENSION_PATH || undefined;
}

/**
 * Whether the sidebar can actually be served.
 *
 * The env var alone is not enough: the daemon sets CLAUDE_EXTENSION_PATH
 * unconditionally, and the extension is downloaded into that directory by the
 * container's entrypoint. Between "the daemon wired it up" and "the download
 * finished" the path names a directory that is empty or absent, and reporting
 * `available: true` there is how the Coding Agent tab came to render a bare
 * `{"error":"sidebar not available"}` — the status endpoint promised a panel
 * the /view route then refused.
 *
 * Stat the tree instead. extension.js is the file the host actually requires
 * (see vscode-host/host.ts), so its presence is the honest signal.
 */
export function sidebarEnabled(): boolean {
  const dir = extensionPath();
  if (!dir) return false;
  try {
    return fs.statSync(path.join(dir, 'extension.js')).isFile();
  } catch {
    return false;
  }
}

function configRoot(): string {
  return process.env.SIDEBAR_CONFIG_ROOT || '/claude-config';
}

export function configDirNameFor(email: string): string {
  const clean = email.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 40);
  const hash = crypto.createHash('sha256').update(email).digest('hex').slice(0, 8);
  return `${clean}_${hash}`;
}

/**
 * localStorage key the page's webview state is kept under.
 *
 * Scoped exactly as the extension scopes its view state — one user, one BP
 * clone — so switching BPs restores that BP's conversation rather than the
 * last one looked at, and two people sharing a browser profile do not inherit
 * each other's panel.
 */
export function webviewStateKey(opts: { email: string; copy: string; bp: string }): string {
  return `bitswan-sidebar-state:${configDirNameFor(opts.email)}:${opts.copy}/${opts.bp}`;
}

export const ASSET_BASE_PLACEHOLDER = 'https://__bitswan_sidebar_asset_base__';


const THEME_LIGHT: Record<string, string> = {
  foreground: '#1f2328',
  background: '#ffffff',
  border: '#d8dbdf',
  accent: '#c1440e',
  muted: '#6b7280',
  subtle: '#f4f5f7',
  selection: '#cfe3ff',
  error: '#b42318',
  warning: '#b25e09',
  success: '#116329',
};

function themeValueFor(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('font-family')) {
    return "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
  }
  if (n.includes('editor-font-family') || n.includes('monospace')) {
    return "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
  }
  if (n.includes('font-size')) return '13px';
  if (n.includes('font-weight')) return '400';
  if (n.includes('sash-size')) return '4px';
  if (n.includes('size')) return '13px';
  if (n.includes('cursor')) return THEME_LIGHT.foreground!;
  if (n.includes('errorforeground') || n.includes('error-foreground')) return THEME_LIGHT.error!;
  if (n.includes('error')) return THEME_LIGHT.error!;
  if (n.includes('warning')) return THEME_LIGHT.warning!;
  if (n.includes('success') || n.includes('added')) return THEME_LIGHT.success!;
  if (n.includes('link')) return '#0969da';
  if (n.includes('selection') || n.includes('highlight')) return THEME_LIGHT.selection!;
  if (n.includes('border') || n.includes('focusborder') || n.includes('contrast')) return THEME_LIGHT.border!;
  if (n.includes('description') || n.includes('placeholder') || n.includes('disabled')) return THEME_LIGHT.muted!;
  if (n.includes('hoverbackground') || n.includes('widget-background')) return THEME_LIGHT.subtle!;
  if (n.includes('background')) return THEME_LIGHT.background!;
  if (n.includes('foreground')) return THEME_LIGHT.foreground!;
  return THEME_LIGHT.foreground!;
}

let themeBlockCache: string | undefined;

/**
 * VS Code injects a large set of `--vscode-*` CSS variables into every webview,
 * and the extension's stylesheet reads 247 of them. Without any of them the
 * panel renders but details break in ways that look like our bug rather than a
 * missing contract — most visibly `caret-color: var(--vscode-editorCursor-
 * foreground)`, which leaves the text cursor invisible while typing.
 *
 * The names are read out of the bundle's own stylesheet so this stays in step
 * with whatever the extension ships, and values are derived from a small light
 * palette by keyword.
 */
const MONO_STACK =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

const WORKBENCH_TOKENS: Record<string, string> = {
  '--monaco-monospace-font': MONO_STACK,
  '--separator-border': THEME_LIGHT.border!,
  '--text-link-decoration': 'none',
  '--app-link-color': '#0969da',
  '--app-link-foreground': '#0969da',
  '--app-text-secondary': THEME_LIGHT.muted!,
  '--app-secondary-text': THEME_LIGHT.muted!,
  '--app-placeholder-color': THEME_LIGHT.muted!,
  '--app-font-family-mono': MONO_STACK,
  '--app-code-background': THEME_LIGHT.subtle!,
  '--app-focusBorder': THEME_LIGHT.accent!,
  '--app-button-hoverBackground': THEME_LIGHT.subtle!,
  '--app-secondary-button-hover-background': THEME_LIGHT.subtle!,
};

function themeBlock(extDir: string): string {
  if (themeBlockCache !== undefined) return themeBlockCache;
  let names: string[] = [];
  try {
    const css = fs.readFileSync(path.join(extDir, 'webview', 'index.css'), 'utf8');
    names = [...new Set(css.match(/--vscode-[A-Za-z0-9-]+/g) ?? [])];
  } catch {
    names = [];
  }
  const decls = [
    ...names.map((n) => `${n}: ${themeValueFor(n)};`),
    ...Object.entries(WORKBENCH_TOKENS).map(([n, v]) => `${n}: ${v};`),
  ].join('\n  ');
  themeBlockCache = `<style id="bitswan-vscode-theme">\n:root, body {\n  ${decls}\n  color-scheme: light;\n}\nhtml, body { background: ${THEME_LIGHT.background}; color: ${THEME_LIGHT.foreground}; }\n</style>`;
  return themeBlockCache;
}

function injectBridge(html: string, assetUris?: unknown, stateKey?: string): string {
  const inlinedAssets = assetUris
    ? `<script>window.__bitswanAssetUris = ${JSON.stringify(assetUris).split('<').join('\\u003c')};</script>`
    : '';
  const seedStateKey = stateKey
    ? `<script>window.__bitswanSidebarStateKey = ${JSON.stringify(stateKey).split('<').join('\\u003c')};</script>`
    : '';
  const bridge = `<script>
(function () {
  // VS Code persists a webview's setState() across reloads and hands it back
  // through getState(), which is how the panel comes back showing the
  // conversation you left rather than a blank one. Nothing here survives a
  // page load on its own, so localStorage stands in — per scope, because the
  // extension keys its view state to one workspace folder. A browser that
  // refuses storage (private window, blocked site data) just gets the old
  // cold-start behaviour instead of an exception.
  var KEY = window.__bitswanSidebarStateKey;
  var state = undefined;
  try {
    var saved = KEY ? window.localStorage.getItem(KEY) : null;
    if (saved) state = JSON.parse(saved);
  } catch (e) {
    state = undefined;
  }
  var HOST = '__bitswanHost';
  var FRAME = '__bitswanSidebar';
  var opened = {};
  function openExternal(url) {
    var now = Date.now();
    if (opened[url] && now - opened[url] < 5000) return;
    opened[url] = now;
    var win = null;
    try { win = window.open(url, '_blank'); } catch (e) { win = null; }
    if (!win) { offerLink(url); return; }
    detachOpener(win);
  }
  function detachOpener(win) {
    try { win.opener = null; } catch (e) { return; }
  }
  function offerLink(url) {
    var box = document.getElementById('bitswan-blocked-link');
    if (!box) {
      box = document.createElement('div');
      box.id = 'bitswan-blocked-link';
      box.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:2147483647;padding:8px 10px;'
        + 'border:1px solid rgba(0,0,0,.15);border-radius:6px;background:#fff;color:#1f2328;'
        + 'font:13px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.15)';
      document.body.appendChild(box);
    }
    box.textContent = 'Your browser blocked this link: ';
    var a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'open it';
    a.style.color = '#0969da';
    a.addEventListener('click', function () { box.remove(); });
    box.appendChild(a);
  }
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d[HOST] !== true) return;
    var payload = d.payload;
    if (payload && payload.type === 'bitswan-open-external' && payload.url) {
      openExternal(payload.url);
      return;
    }
    window.dispatchEvent(new MessageEvent('message', { data: payload }));
  });
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (message) {
        var request = message && message.request;
        if (request && request.type === 'open_url' && request.url) openExternal(request.url);
        if (request && request.type === 'get_asset_uris' && window.__bitswanAssetUris) {
          var reply = {
            type: 'from-extension',
            message: {
              type: 'response',
              requestId: message.requestId,
              response: { type: 'asset_uris_response', assetUris: window.__bitswanAssetUris },
            },
          };
          Promise.resolve().then(function () {
            window.dispatchEvent(new MessageEvent('message', { data: reply }));
          });
          return;
        }
        var envelope = {};
        envelope[FRAME] = true;
        envelope.payload = message;
        parent.postMessage(envelope, '*');
      },
      getState: function () { return state; },
      setState: function (next) {
        state = next;
        try {
          if (KEY) {
            if (next === undefined) window.localStorage.removeItem(KEY);
            else window.localStorage.setItem(KEY, JSON.stringify(next));
          }
        } catch (e) { /* storage unavailable or full — keep the in-memory copy */ }
        return next;
      },
    };
  };
})();
</script>`;

  const relaxed = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/i, (tag) =>
    tag.replace(
      /content="[^"]*"/i,
      "content=\"default-src 'none'; img-src * data: blob:; media-src * data: blob:; style-src 'unsafe-inline' *; script-src 'unsafe-inline' 'unsafe-eval' data: blob: *; font-src * data:; connect-src * ws: wss: data:; worker-src * blob:;\"",
    ),
  );
  const head = inlinedAssets + seedStateKey + bridge;
  return relaxed.includes('</head>')
    ? relaxed.replace('</head>', `${head}\n</head>`)
    : head + relaxed;
}


export interface SidebarOpen {
  id: string;
  html: string;
  assetUris?: unknown;
  onToWebview: (listener: (payload: unknown) => void) => () => void;
  sendToExtension: (payload: unknown) => void;
  close: () => void;
}

interface Host {
  child: ChildProcess;
  ready: Promise<void>;
  listeners: Map<string, Set<(payload: unknown) => void>>;
  lastUsedAt: number;
  /** A task prompt waiting for a page to show it in. See sendPrompt. */
  pendingPrompt?: string;
}

const hosts = new Map<string, Host>();

function hostKey(opts: { email: string; copy: string; bp: string }): string {
  return `${opts.email} ${opts.copy} ${opts.bp}`;
}

const WRAPPER = '/usr/local/bin/claude-process-wrapper';

/**
 * The bundled CLI the extension would launch if it ever stopped honouring
 * claudeProcessWrapper. It must never be runnable in this container — see
 * assertBundledClaudeDisarmed.
 */
function bundledClaudePath(ext: string): string {
  return path.join(ext, 'resources', 'native-binary', 'claude');
}

/**
 * Refuse to start a host while the extension's own `claude` is executable here.
 *
 * The agent runs in the coding-agent container, always. Not as a default — as
 * an invariant. This container reaches the whole workspace: it holds
 * BITSWAN_DEPLOY_SECRET, the workspace SSH key, every user's Claude credentials
 * under /claude-config, and its own server bundle. The agent executes
 * model-chosen shell commands, so running it here would put all of that one
 * tool call away, and would undo the isolation the product is built on —
 * routes/coding-agent.ts keeps the dashboard off the agent's network precisely
 * because the agent runs untrusted code.
 *
 * The entrypoint takes the execute bit off at startup. This is the second half
 * of that: if anything re-armed it, fail the panel rather than risk the
 * extension spawning it. Failing closed is the point — a broken Coding Agent
 * tab is a visible, fixable problem; an agent quietly running next to the
 * deploy secret is not.
 */
export function assertBundledClaudeDisarmed(ext: string): void {
  const binary = bundledClaudePath(ext);
  let mode: number;
  try {
    mode = fs.statSync(binary).mode;
  } catch {
    // Absent is the safest state of all.
    return;
  }
  if (mode & 0o111) {
    throw new Error(
      `refusing to start the agent: ${binary} is executable in the dashboard container. ` +
        'Claude Code must only ever run in the coding-agent container. ' +
        'Restart the dashboard to let its entrypoint remove the execute bit.',
    );
  }
}

/**
 * Scope handed to claude-process-wrapper, which runs `claude` in the
 * coding-agent container: identity (it keys the per-user Claude config dir and
 * attributes commits) and which BP clone to land in.
 */
function agentExecEnv(opts: { email: string; copy: string; bp: string }): Record<string, string> {
  const ws = process.env.BITSWAN_WORKSPACE_NAME ?? 'default';
  return {
    SIDEBAR_CLAUDE_WRAPPER: WRAPPER,
    // Same target the terminal path used: the agent's sshd is reached through
    // the raw TCP proxy gitops runs on :2222, because the dashboard is not on
    // the agent's network. CODING_AGENT_HOST overrides both, for dev composes
    // where the agent is directly reachable.
    SIDEBAR_AGENT_SSH_HOST: process.env.CODING_AGENT_HOST ?? `${ws}-gitops`,
    SIDEBAR_AGENT_SSH_PORT: process.env.CODING_AGENT_HOST
      ? (process.env.CODING_AGENT_SSH_PORT ?? '22')
      : '2222',
    SIDEBAR_USER_EMAIL: opts.email,
    SIDEBAR_COPY: opts.copy,
    SIDEBAR_BP: opts.bp,
  };
}

/**
 * The BP clone as the extension host must see it: at the path the agent's own
 * container uses, not the one the dashboard's file routes use.
 *
 * Claude Code names a conversation's transcript directory after the cwd it ran
 * in — /workspace/copies/<copy>/<bp> becomes
 * projects/-workspace-copies-<copy>-<bp>. The CLI runs in the coding-agent
 * container, so that is the name on disk; if the extension host looked in
 * `${WORKSPACE_ROOT}/copies/...` (/workspace/workspace/copies/...) it would
 * compute a different name, find nothing, and show an empty history for a BP
 * with a dozen conversations in it.
 *
 * SIDEBAR_COPIES_ROOT is that path, and the daemon mounts the same copies tree
 * there as well so the directory genuinely exists here (services/dashboard.go).
 * Falling back to workspaceRoot keeps standalone runs and the dev server
 * working; there the two containers are one, so the paths already agree.
 */
export function sidebarWorkspaceFolder(opts: {
  copy: string;
  bp: string;
  workspaceRoot: string;
}): string {
  const copies = process.env.SIDEBAR_COPIES_ROOT || path.join(opts.workspaceRoot, 'copies');
  return path.join(copies, opts.copy, opts.bp);
}

function spawnHost(opts: {
  email: string;
  copy: string;
  bp: string;
  workspaceRoot: string;
}): Host {
  const ext = extensionPath();
  if (!ext) throw new Error('CLAUDE_EXTENSION_PATH is not set');
  assertBundledClaudeDisarmed(ext);

  const configDir = path.join(configRoot(), configDirNameFor(opts.email));
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });

  const child = fork(WORKER, [], {
    execArgv: process.execArgv,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      CLAUDE_EXTENSION_PATH: ext,
      CLAUDE_CONFIG_DIR: configDir,
      SIDEBAR_WORKSPACE_FOLDER: sidebarWorkspaceFolder(opts),
      // The extension passes its own env straight through to whatever it
      // launches, so these reach claude-process-wrapper as its environment.
      // They are the scope the far side needs: identity (which keys the
      // per-user Claude config dir and attributes commits) and which BP clone
      // to land in.
      ...agentExecEnv(opts),
    },
  });

  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const host: Host = {
    child,
    listeners,
    lastUsedAt: Date.now(),
    ready: new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('extension host did not become ready')),
        READY_TIMEOUT_MS,
      );
      const onMessage = (m: { t?: string; message?: string }) => {
        if (m?.t === 'ready') {
          clearTimeout(timer);
          child.off('message', onMessage);
          resolve();
        } else if (m?.t === 'fatal') {
          clearTimeout(timer);
          child.off('message', onMessage);
          reject(new Error(m.message ?? 'extension host failed to activate'));
        }
      };
      child.on('message', onMessage);
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('extension host exited during activation'));
      });
    }),
  };

  child.on('message', (m: { t?: string; id?: string; url?: string; payload?: unknown }) => {
    if (m?.t === 'openExternal' && typeof m.url === 'string') {
      const payload = { type: 'bitswan-open-external', url: m.url };
      for (const set of listeners.values()) for (const l of set) l(payload);
      return;
    }
    if (m?.t !== 'toWebview' || !m.id) return;
    host.lastUsedAt = Date.now();
    for (const l of listeners.get(m.id) ?? []) l(m.payload);
  });

  const key = hostKey(opts);
  child.once('exit', () => {
    if (hosts.get(key) === host) hosts.delete(key);
  });
  return host;
}

function hostFor(opts: {
  email: string;
  copy: string;
  bp: string;
  workspaceRoot: string;
}): Host {
  const key = hostKey(opts);
  const existing = hosts.get(key);
  if (existing && existing.child.exitCode === null && !existing.child.killed) {
    existing.lastUsedAt = Date.now();
    return existing;
  }
  const host = spawnHost(opts);
  hosts.set(key, host);
  return host;
}

export async function openSidebar(opts: {
  email: string;
  copy: string;
  bp: string;
  workspaceRoot: string;
}): Promise<SidebarOpen> {
  const host = hostFor(opts);
  await host.ready;
  const id = crypto.randomUUID();

  const opened = await new Promise<{ html: string; assetUris?: unknown }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sidebar open timed out')), READY_TIMEOUT_MS);
    const onMessage = (m: {
      t?: string;
      id?: string;
      html?: string;
      assetUris?: unknown;
      message?: string;
    }) => {
      if (m?.id !== id) return;
      clearTimeout(timer);
      host.child.off('message', onMessage);
      if (m.t === 'opened') resolve({ html: m.html ?? '', assetUris: m.assetUris });
      else if (m.t === 'error') reject(new Error(m.message ?? 'sidebar open failed'));
    };
    host.child.on('message', onMessage);
    host.child.send({ t: 'open', id, resourceBase: ASSET_BASE_PLACEHOLDER });
  });

  host.listeners.set(id, new Set());
  return {
    id,
    html: opened.html,
    assetUris: opened.assetUris,
    onToWebview: (listener) => {
      host.listeners.get(id)?.add(listener);
      // A page is now listening, so a prompt parked before one was can be
      // delivered. This is the flush half of sendPrompt.
      flushPendingPrompt(host);
      return () => {
        host.listeners.get(id)?.delete(listener);
      };
    },
    sendToExtension: (payload) => {
      host.lastUsedAt = Date.now();
      if (host.child.connected) host.child.send({ t: 'toExt', id, payload });
    },
    close: () => {
      host.listeners.delete(id);
      if (host.child.connected) host.child.send({ t: 'close', id });
    },
  };
}

/**
 * Whether any page is currently listening to this host.
 *
 * Not the same as "a page has opened": /view registers an id, the websocket
 * that carries messages to it arrives a moment later. A prompt delivered in
 * between would be posted by the extension to a webview nothing is reading,
 * and silently lost.
 */
function hasListeningPage(host: Host): boolean {
  for (const set of host.listeners.values()) if (set.size > 0) return true;
  return false;
}

function deliverPrompt(host: Host, text: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!host.child.connected) {
      reject(new Error('the extension host is gone'));
      return;
    }
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      host.child.off('message', onMessage);
      reject(new Error('the extension did not answer the prompt hand-off'));
    }, PROMPT_TIMEOUT_MS);
    const onMessage = (m: { t?: string; id?: string; message?: string }) => {
      if (m?.id !== id) return;
      clearTimeout(timer);
      host.child.off('message', onMessage);
      if (m.t === 'prompted') resolve();
      else if (m.t === 'promptFailed') reject(new Error(m.message ?? 'prompt hand-off failed'));
    };
    host.child.on('message', onMessage);
    host.lastUsedAt = Date.now();
    host.child.send({ t: 'prompt', id, text });
  });
}

function flushPendingPrompt(host: Host): void {
  const text = host.pendingPrompt;
  if (text === undefined) return;
  host.pendingPrompt = undefined;
  // Nothing upstream is waiting on this any more — the request that queued it
  // returned as soon as the prompt was accepted. Log rather than throw into a
  // listener registration.
  deliverPrompt(host, text).catch((err: unknown) => {
    console.warn('[sidebar] could not hand the queued task prompt to the panel', err);
  });
}

/**
 * Put a task prompt in the panel's composer.
 *
 * The dashboard has buttons that give the agent a job — Sync, Build
 * automation, Write tests — and handing one over used to mean typing it into
 * the terminal session. The hosted panel has no terminal, so this uses the
 * extension's own hand-off instead: `claude-vscode.editor.open`, a contributed
 * command, which opens a new conversation with the text already in the input.
 * It prefills rather than sends, which is the extension's own behaviour for
 * this everywhere; the user presses enter.
 *
 * Queued when no page is listening yet, because the click that starts a task
 * usually happens on a different tab and the panel is a navigation away. The
 * extension parks such a hand-off too, but drops it after 15 seconds — far
 * less than a cold host's first activation — so the wait is held here instead,
 * where it can be flushed the moment a page attaches. An unclaimed prompt dies
 * with the host, which idles out after half an hour.
 */
export async function sendPrompt(opts: {
  email: string;
  copy: string;
  bp: string;
  workspaceRoot: string;
  text: string;
}): Promise<{ delivered: boolean }> {
  const host = hostFor(opts);
  await host.ready;
  if (!hasListeningPage(host)) {
    host.pendingPrompt = opts.text;
    return { delivered: false };
  }
  await deliverPrompt(host, opts.text);
  return { delivered: true };
}

export function evictIdleSidebarHosts(now = Date.now()): number {
  let evicted = 0;
  for (const [key, host] of hosts) {
    if (host.listeners.size === 0 && now - host.lastUsedAt > IDLE_EVICT_MS) {
      host.child.kill('SIGTERM');
      hosts.delete(key);
      evicted += 1;
    }
  }
  return evicted;
}

function seedAssetUris(js: string, assetUris: unknown): string {
  if (!assetUris) return js;
  return js.replace(
    /assetUris\s*=\s*([A-Za-z0-9_$]+)\(void 0\)/,
    (whole, signal: string) => `assetUris=${signal}(window.__bitswanAssetUris)`,
  );
}

function inlineBundles(html: string, extDir: string, assetUris?: unknown): string {
  return html.replace(
    /<(script|link)\b[^>]*?(?:src|href)="([^"]*?)"[^>]*>(?:<\/script>)?/gi,
    (tag, kind: string, url: string) => {
      if (!url.startsWith(ASSET_BASE_PLACEHOLDER)) return tag;
      const rel = url.slice(ASSET_BASE_PLACEHOLDER.length).replace(/^\//, '').split('?')[0] ?? '';
      const abs = path.resolve(extDir, rel);
      if (!abs.startsWith(path.resolve(extDir))) return tag;
      let body: string;
      try {
        body = fs.readFileSync(abs, 'utf8');
      } catch {
        return tag;
      }
      if (kind.toLowerCase() === 'link') return `<style>\n${body}\n</style>`;
      const isModule = /type\s*=\s*"module"/i.test(tag);
      const safe = seedAssetUris(body, assetUris).split('</script').join('<\\/script');
      return `<script${isModule ? ' type="module"' : ''}>\n${safe}\n</script>`;
    },
  );
}

function markThemeKind(html: string): string {
  return html.replace(/<body([^>]*)>/i, (whole, attrs: string) => {
    if (/vscode-light/.test(attrs)) return whole;
    const withClass = /class="/i.test(attrs)
      ? attrs.replace(/class="/i, 'class="vscode-light ')
      : `${attrs} class="vscode-light"`;
    return `<body${withClass} data-vscode-theme-kind="vscode-light" data-vscode-theme-name="Bitswan Light" data-vscode-theme-id="vs">`;
  });
}

export function pageFor(
  html: string,
  opts: { assetBase: string; extensionDir: string; assetUris?: unknown; stateKey?: string },
): string {
  const withBridge = injectBridge(markThemeKind(html), opts.assetUris, opts.stateKey);
  const themed = withBridge.includes('</head>')
    ? withBridge.replace('</head>', `${themeBlock(opts.extensionDir)}\n</head>`)
    : themeBlock(opts.extensionDir) + withBridge;
  const inlined = inlineBundles(themed, opts.extensionDir, opts.assetUris);
  return inlined.split(ASSET_BASE_PLACEHOLDER).join(opts.assetBase);
}

export function startSidebarHostReaper(app: {
  log: { info: (o: unknown, m: string) => void };
  addHook: (name: 'onClose', fn: () => Promise<void>) => void;
}): void {
  const timer = setInterval(() => {
    const evicted = evictIdleSidebarHosts();
    if (evicted > 0) app.log.info({ evicted }, 'sidebar extension hosts evicted while idle');
  }, REAP_INTERVAL_MS);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}

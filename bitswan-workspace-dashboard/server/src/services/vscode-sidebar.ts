import { fork, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../vscode-host/worker.js');
const READY_TIMEOUT_MS = 90_000;
const IDLE_EVICT_MS = 30 * 60_000;
const REAP_INTERVAL_MS = 5 * 60_000;

export function extensionPath(): string | undefined {
  return process.env.CLAUDE_EXTENSION_PATH || undefined;
}

export function sidebarEnabled(): boolean {
  return Boolean(extensionPath());
}

function configRoot(): string {
  return process.env.SIDEBAR_CONFIG_ROOT || '/claude-config';
}

export function configDirNameFor(email: string): string {
  const clean = email.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 40);
  const hash = crypto.createHash('sha256').update(email).digest('hex').slice(0, 8);
  return `${clean}_${hash}`;
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

function injectBridge(html: string, assetUris?: unknown): string {
  const inlinedAssets = assetUris
    ? `<script>window.__bitswanAssetUris = ${JSON.stringify(assetUris).split('<').join('\\u003c')};</script>`
    : '';
  const bridge = `<script>
(function () {
  var state = undefined;
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
      setState: function (next) { state = next; return next; },
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
  const head = inlinedAssets + bridge;
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
}

const hosts = new Map<string, Host>();

function hostKey(opts: { email: string; workspaceFolder: string }): string {
  return `${opts.email} ${opts.workspaceFolder}`;
}

function spawnHost(opts: { email: string; workspaceFolder: string }): Host {
  const ext = extensionPath();
  if (!ext) throw new Error('CLAUDE_EXTENSION_PATH is not set');

  const configDir = path.join(configRoot(), configDirNameFor(opts.email));
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });

  const child = fork(WORKER, [], {
    execArgv: process.execArgv,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      CLAUDE_EXTENSION_PATH: ext,
      CLAUDE_CONFIG_DIR: configDir,
      SIDEBAR_WORKSPACE_FOLDER: opts.workspaceFolder,
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

function hostFor(opts: { email: string; workspaceFolder: string }): Host {
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
  workspaceFolder: string;
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

const MAX_SEEDED_PROMPT_CHARS = 8 * 1024;

/**
 * The webview reads `#root`'s `data-initial-prompt` when it boots and types it
 * into the composer (it does not send it — the person still decides). That
 * attribute is the extension's own hand-off for "open Claude on this", and it
 * is the only one: there is no command for typing into a session that is
 * already running.
 */
export function seedInitialPrompt(html: string, prompt: string | undefined): string {
  const text = (prompt ?? '').trim().slice(0, MAX_SEEDED_PROMPT_CHARS);
  if (!text) return html;
  const attr = text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return html.replace(/<div id="root"/i, `<div id="root" data-initial-prompt="${attr}"`);
}

export function pageFor(
  html: string,
  opts: { assetBase: string; extensionDir: string; assetUris?: unknown; initialPrompt?: string },
): string {
  const withBridge = injectBridge(markThemeKind(seedInitialPrompt(html, opts.initialPrompt)), opts.assetUris);
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

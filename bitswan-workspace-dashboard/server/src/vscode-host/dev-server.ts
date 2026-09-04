import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { activateExtension } from './host.js';
import { resolveWebviewView, type ResolvedWebview } from './api.js';
import { startMockAnthropic } from './mock-anthropic.js';

const extensionPath = process.env.CLAUDE_EXTENSION_PATH;
const workspaceFolder = process.env.PROBE_WORKSPACE ?? process.cwd();
const port = Number(process.env.PROBE_PORT ?? 8760);
const viewIndex = Number(process.env.PROBE_VIEW_INDEX ?? 0);

if (!extensionPath) {
  console.error('set CLAUDE_EXTENSION_PATH to the unpacked extension/ directory');
  process.exit(2);
}

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function nonceFrom(html: string): string {
  return html.match(/nonce="([^"]+)"/)?.[1] ?? '';
}

function injectHostBridge(html: string): string {
  const nonce = nonceFrom(html);
  const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
  const bridge = `<script${nonceAttr}>
(function () {
  var queue = [];
  var state = undefined;
  var socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/bridge');
  window.__bridgeLog = [];
  socket.addEventListener('open', function () {
    window.__bridgeLog.push('open');
    queue.splice(0).forEach(function (m) { socket.send(m); });
  });
  socket.addEventListener('message', function (ev) {
    window.__bridgeLog.push('fromExt');
    var parsed;
    try { parsed = JSON.parse(ev.data); } catch (e) { return; }
    window.dispatchEvent(new MessageEvent('message', { data: parsed }));
  });
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (message) {
        var payload = JSON.stringify(message);
        window.__bridgeLog.push('toExt');
        if (socket.readyState === 1) socket.send(payload); else queue.push(payload);
      },
      getState: function () { return state; },
      setState: function (next) { state = next; return next; },
    };
  };
})();
</script>`;

  const relaxed = html.replace(
    /<meta http-equiv="Content-Security-Policy"[^>]*>/i,
    (tag) => tag.replace(/content="[^"]*"/i, `content="default-src 'none'; img-src * data: blob:; media-src * data: blob:; style-src 'unsafe-inline' *; script-src 'nonce-${nonce}' 'unsafe-eval' *; font-src * data:; connect-src * ws: wss: data:; worker-src * blob:;"`),
  );
  if (relaxed.includes('</head>')) return relaxed.replace('</head>', `${bridge}\n</head>`);
  return bridge + relaxed;
}

const configDir =
  process.env.PROBE_CLAUDE_CONFIG_DIR ??
  fs.mkdtempSync(path.join(os.tmpdir(), 'bitswan-vscode-host-claude-'));
process.env.CLAUDE_CONFIG_DIR = configDir;

const mock = process.env.PROBE_NO_MOCK === '1' ? undefined : await startMockAnthropic();
if (mock) {
  process.env.ANTHROPIC_BASE_URL = mock.baseUrl;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-mock-0000000000000000000000000000000000000000';
  process.env.CLAUDE_CODE_USE_BEDROCK = '0';
  process.env.CLAUDE_CODE_USE_VERTEX = '0';
  process.env.DISABLE_TELEMETRY = '1';
  process.env.DISABLE_AUTOUPDATER = '1';
  process.env.DISABLE_ERROR_REPORTING = '1';
}

const host = await activateExtension({ extensionPath, workspaceFolder });
const registrations = host.state.webviewViewProviders;
if (registrations.length === 0) {
  console.error('extension registered no webview views');
  process.exit(1);
}
const registration = registrations[Math.min(viewIndex, registrations.length - 1)]!;
const view: ResolvedWebview = await resolveWebviewView(registration, {
  extensionPath,
  resourceBase: `http://127.0.0.1:${port}/asset`,
});

const pageHtml = injectHostBridge(view.html);
const toWebviewSockets = new Set<WebSocket>();
const extensionInbox: unknown[] = [];

view.onWebviewMessage((message) => {
  const payload = JSON.stringify(message);
  for (const s of toWebviewSockets) {
    if (s.readyState === 1) s.send(payload);
  }
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(pageHtml);
    return;
  }
  if (url.pathname === '/__mock') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        baseUrl: mock?.baseUrl ?? null,
        count: mock?.requests.length ?? 0,
        requests: (mock?.requests ?? []).slice(-40).map((r) => {
          const messages = (r.body as { messages?: unknown[] } | undefined)?.messages ?? [];
          const blocks = messages.flatMap((m) => {
            const c = (m as { content?: unknown }).content;
            return Array.isArray(c) ? (c as { type?: string }[]) : [];
          });
          return {
            method: r.method,
            path: r.path,
            blockTypes: blocks.map((b) => b.type ?? '?'),
            imageBlocks: blocks.filter((b) => b.type === 'image').length,
          };
        }),
      }),
    );
    return;
  }
  if (url.pathname === '/__inbox') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ count: extensionInbox.length, messages: extensionInbox.slice(-80) }));
    return;
  }
  if (url.pathname.startsWith('/asset/')) {
    const rel = decodeURIComponent(url.pathname.slice('/asset/'.length));
    const abs = path.resolve(extensionPath, rel);
    if (!abs.startsWith(path.resolve(extensionPath))) {
      res.writeHead(403).end('outside the extension');
      return;
    }
    fs.readFile(abs, (err, buf) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(abs)] ?? 'application/octet-stream' });
      res.end(buf);
    });
    return;
  }
  res.writeHead(404).end('not found');
});

const wss = new WebSocketServer({ server, path: '/bridge' });
wss.on('connection', (socket) => {
  toWebviewSockets.add(socket);
  socket.on('message', (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return;
    }
    extensionInbox.push(parsed);
    view.sendFromWebview(parsed);
  });
  socket.on('close', () => toWebviewSockets.delete(socket));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`vscode-host dev server on http://127.0.0.1:${port}/`);
  console.log(`view=${view.viewId} html=${view.html.length}B nonce=${nonceFrom(view.html) ? 'yes' : 'no'}`);
  if (mock) console.log(`mock anthropic api on ${mock.baseUrl}`);
  console.log(`CLAUDE_CONFIG_DIR=${configDir}`);
});

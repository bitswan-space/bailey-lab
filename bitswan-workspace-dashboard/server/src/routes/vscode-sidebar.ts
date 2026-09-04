import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { emailFromRequest } from '../lib/user.js';
import { isValidBpId, isValidCopyName } from '../services/workspace.js';
import {
  ASSET_BASE_PLACEHOLDER,
  extensionPath,
  openSidebar,
  pageFor,
  sidebarEnabled,
  startSidebarHostReaper,
  type SidebarOpen,
} from '../services/vscode-sidebar.js';

const pendingOpens = new Map<string, SidebarOpen>();

const PREFIX = '/api/coding-agent/sidebar';

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

export interface VscodeSidebarRoutesOptions {
  workspaceRoot: string;
}

function scope(q: { copy?: string; bp?: string }): { copy: string; bp: string } | undefined {
  const copy = (q.copy ?? '').trim();
  const bp = (q.bp ?? '').trim();
  if (!copy || !bp || !isValidCopyName(copy) || !isValidBpId(bp)) return undefined;
  return { copy, bp };
}

export function registerVscodeSidebarRoutes(
  app: FastifyInstance,
  { workspaceRoot }: VscodeSidebarRoutesOptions,
): void {
  startSidebarHostReaper(app);

  app.get(`${PREFIX}/status`, async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { available: sidebarEnabled() };
  });

  app.get<{ Querystring: { copy?: string; bp?: string } }>(
    `${PREFIX}/view`,
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!sidebarEnabled()) return reply.code(503).send({ error: 'sidebar not available' });
      const s = scope(req.query);
      if (!s) return reply.code(400).send({ error: 'copy and bp are required' });
      const email = await emailFromRequest(req, app.log);
      if (!email) return reply.code(403).send({ error: 'no verified identity' });

      try {
        const opened = await openSidebar({ email, ...s, workspaceRoot });
        pendingOpens.set(`${email} ${s.copy} ${s.bp}`, opened);
        const html = pageFor(opened.html, {
          assetBase: `${PREFIX}/asset`,
          extensionDir: extensionPath()!,
          assetUris: opened.assetUris,
        });
        reply.header('Content-Type', 'text/html; charset=utf-8');
        return reply.send(html);
      } catch (err) {
        app.log.warn({ err, ...s }, 'sidebar activate failed');
        return reply.code(500).send({ error: String(err) });
      }
    },
  );

  app.options(`${PREFIX}/asset/*`, async (_req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Headers', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    return reply.code(204).send();
  });

  app.get(`${PREFIX}/asset/*`, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const ext = extensionPath();
    if (!ext) return reply.code(503).send({ error: 'sidebar not available' });
    const rel = decodeURIComponent((req.params as { '*': string })['*'] ?? '');
    const abs = path.resolve(ext, rel);
    if (!abs.startsWith(path.resolve(ext))) {
      return reply.code(403).send({ error: 'outside the extension' });
    }
    try {
      const buf = await fs.promises.readFile(abs);
      reply.header('Content-Type', MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream');
      reply.header('Access-Control-Allow-Origin', '*');
      return reply.send(buf);
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
  });

  app.get<{ Querystring: { copy?: string; bp?: string } }>(
    '/ws/coding-agent-sidebar',
    { websocket: true },
    async (socket, req) => {
      const s = scope(req.query);
      const email = await emailFromRequest(req, app.log);
      if (!s || !email || !sidebarEnabled()) {
        socket.close(1008, 'unavailable');
        return;
      }
      const key = `${email} ${s.copy} ${s.bp}`;
      let opened = pendingOpens.get(key);
      if (!opened) {
        try {
          opened = await openSidebar({ email, ...s, workspaceRoot });
          pendingOpens.set(key, opened);
        } catch (err) {
          app.log.warn({ err, ...s }, 'sidebar bridge open failed');
          socket.close(1011, 'open failed');
          return;
        }
      }
      const attached = opened;

      const assetBase = `${req.protocol}://${req.headers.host}${PREFIX}/asset`;
      const off = attached.onToWebview((message) => {
        if (socket.readyState !== 1) return;
        const text = JSON.stringify(message).split(ASSET_BASE_PLACEHOLDER).join(assetBase);
        if (process.env.SIDEBAR_TRACE === '1') {
          const m = message as { type?: string; response?: { type?: string } };
          app.log.info(
            { kind: m?.response?.type ?? m?.type ?? '?', bytes: text.length, head: text.slice(0, 300) },
            'sidebar->webview',
          );
        }
        socket.send(text);
      });
      socket.on('message', (raw: Buffer | string) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (process.env.SIDEBAR_TRACE === '1') {
          const text = String(raw);
          const m = parsed as { type?: string; request?: { type?: string } };
          app.log.info(
            {
              kind: m?.request?.type ?? m?.type ?? '?',
              bytes: text.length,
              imageish: /image|attachment|base64|data:/i.test(text.slice(0, 4000)),
            },
            'sidebar<-webview',
          );
        }
        attached.sendToExtension(parsed);
      });
      socket.on('close', () => {
        off();
        attached.close();
        if (pendingOpens.get(key) === attached) pendingOpens.delete(key);
      });
    },
  );
}

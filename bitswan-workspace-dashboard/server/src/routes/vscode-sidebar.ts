import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { emailFromRequest } from '../lib/user.js';
import { isValidBpId, isValidCopyName } from '../services/workspace.js';
import { extensionPath, latestSidebar, openSidebar, pageFor, sidebarEnabled } from '../services/vscode-sidebar.js';

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
        const instance = await openSidebar({ email, ...s, workspaceRoot });
        const qs = `copy=${encodeURIComponent(s.copy)}&bp=${encodeURIComponent(s.bp)}`;
        const html = pageFor(instance, {
          assetBase: `${PREFIX}/asset`,
          bridgeUrl: `/ws/coding-agent-sidebar?${qs}`,
          extensionDir: extensionPath()!,
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
      // The sidebar runs in a sandboxed frame with no `allow-same-origin`, so it
      // has an opaque origin and every asset fetch is cross-origin. These are
      // static files from the extension bundle, not user data, so serving them
      // to an opaque origin is what the isolation costs.
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
      let instance;
      try {
        instance = await latestSidebar({ email, ...s, workspaceRoot });
      } catch (err) {
        app.log.warn({ err, ...s }, 'sidebar bridge activate failed');
        socket.close(1011, 'activate failed');
        return;
      }

      const off = instance.view.onWebviewMessage((message) => {
        if (socket.readyState === 1) socket.send(JSON.stringify(message));
      });
      socket.on('message', (raw: Buffer | string) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          return;
        }
        instance.view.sendFromWebview(parsed);
      });
      socket.on('close', () => off.dispose());
    },
  );
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { handleTerminalConnection } from './ws.js';
import { discoverBusinessProcesses } from './bps.js';
import type { GitopsClient } from './gitops.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOGIN_DONE_HTML = /*html*/ `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Signed in</title>
    <style>
      html, body { margin: 0; height: 100%; }
      body {
        font-family: ui-sans-serif, system-ui, sans-serif;
        background: #1e1e1e;
        color: #d4d4d4;
        display: grid;
        place-items: center;
        text-align: center;
        padding: 16px;
      }
    </style>
  </head>
  <body>
    <div>
      <p>Signed in successfully.</p>
      <p style="opacity: 0.6">You can close this window.</p>
    </div>
    <script>
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage('login-done', window.location.origin);
        }
      } catch (e) {}
      setTimeout(function () { window.close(); }, 50);
    </script>
  </body>
</html>`;

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? '/workspace/workspace';

export interface BuildServerOptions {
  gitops: GitopsClient | null;
}

export async function buildServer(opts: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  const { gitops } = opts;

  const frameAncestors = process.env.DASHBOARD_FRAME_ANCESTORS;
  if (frameAncestors) {
    app.addHook('onSend', async (_req, reply) => {
      // Don't override CSP on the SSE endpoint — it sets its own headers.
      if (!reply.sent && !reply.getHeader('Content-Security-Policy')) {
        reply.header('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);
      }
    });
  }

  await app.register(fastifyWebsocket);

  app.get('/ws/terminal', { websocket: true }, (socket) => {
    handleTerminalConnection(socket);
  });

  app.get('/_login_done', async (_req, reply) => {
    reply.type('text/html').send(LOGIN_DONE_HTML);
  });

  // ─── /api routes ──────────────────────────────────────────────────────────

  app.get('/api/business-processes', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const bps = await discoverBusinessProcesses(WORKSPACE_ROOT);
    return bps;
  });

  app.get('/api/worktrees', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) return [];
    try {
      return await gitops.getWorktrees();
    } catch (err) {
      app.log.warn({ err }, 'failed to fetch worktrees from gitops');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });

  app.get('/api/automations', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return gitops ? gitops.getSnapshot() : [];
  });

  app.get('/api/events', async (req, reply) => {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-store');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering
    reply.raw.flushHeaders?.();

    let closed = false;
    const safeWrite = (chunk: string) => {
      if (closed) return;
      if (!reply.raw.write(chunk)) {
        reply.raw.once('drain', () => {
          // resume on drain — nothing to do; subsequent writes will work
        });
      }
    };

    // Initial snapshot so the UI can paint before the next upstream tick.
    const snapshot = gitops ? gitops.getSnapshot() : [];
    safeWrite(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);

    const unsubscribe = gitops
      ? gitops.subscribe((ev) => {
          safeWrite(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
        })
      : () => {};

    // Keepalive ping defeats idle-connection killers in the proxy chain.
    const keepalive = setInterval(() => safeWrite(`:keepalive\n\n`), 20_000);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(keepalive);
      unsubscribe();
      try {
        reply.raw.end();
      } catch {
        // ignore
      }
    };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
  });

  // ─── Static SPA + fallback ────────────────────────────────────────────────

  const clientDist = path.resolve(__dirname, '../../client/dist');
  await app.register(fastifyStatic, {
    root: clientDist,
    wildcard: false,
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.method !== 'GET' || req.url.startsWith('/ws') || req.url.startsWith('/api')) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    reply.sendFile('index.html');
  });

  return app;
}

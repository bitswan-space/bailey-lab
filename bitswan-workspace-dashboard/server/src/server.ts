import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { handleTerminalConnection } from './ws.js';

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

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  const frameAncestors = process.env.DASHBOARD_FRAME_ANCESTORS;
  if (frameAncestors) {
    app.addHook('onSend', async (_req, reply) => {
      reply.header(
        'Content-Security-Policy',
        `frame-ancestors ${frameAncestors}`,
      );
    });
  }

  await app.register(fastifyWebsocket);

  app.get('/ws/terminal', { websocket: true }, (socket) => {
    handleTerminalConnection(socket);
  });

  app.get('/_login_done', async (_req, reply) => {
    reply.type('text/html').send(LOGIN_DONE_HTML);
  });

  const clientDist = path.resolve(__dirname, '../../client/dist');
  await app.register(fastifyStatic, {
    root: clientDist,
    wildcard: false,
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.method !== 'GET' || req.url.startsWith('/ws')) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    reply.sendFile('index.html');
  });

  return app;
}

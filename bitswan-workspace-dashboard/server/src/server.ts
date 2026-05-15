import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { GitopsClient } from './services/gitops.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAutomationRoutes } from './routes/automations.js';
import { registerBusinessProcessRoutes } from './routes/business-processes.js';
import { registerEventRoutes } from './routes/events.js';
import { registerTemplateRoutes } from './routes/templates.js';
import { registerCodingAgentRoutes } from './routes/coding-agent.js';
import { registerWorktreeRoutes } from './routes/worktrees.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? '/workspace/workspace';

export interface BuildServerOptions {
  gitops: GitopsClient | null;
}

/**
 * Build the Fastify app: registers websocket support, all API/auth/terminal
 * routes, and the static SPA fallback. The `gitops` client may be `null` in
 * environments where the upstream env vars aren't set — routes that depend
 * on it then degrade to empty results or 503s.
 */
export async function buildServer({ gitops }: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  // CSP frame-ancestors header for iframe embedding. Skip on responses that
  // already set their own CSP (SSE endpoints set headers via reply.raw).
  const frameAncestors = process.env.DASHBOARD_FRAME_ANCESTORS;
  if (frameAncestors) {
    app.addHook('onSend', async (_req, reply) => {
      if (!reply.sent && !reply.getHeader('Content-Security-Policy')) {
        reply.header('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);
      }
    });
  }

  await app.register(fastifyWebsocket);

  registerAuthRoutes(app);
  registerCodingAgentRoutes(app, { gitops });
  registerBusinessProcessRoutes(app, { workspaceRoot: WORKSPACE_ROOT, gitops });
  registerWorktreeRoutes(app, { gitops });
  registerTemplateRoutes(app, { gitops });
  registerAutomationRoutes(app, { gitops });
  registerEventRoutes(app, { gitops });

  // Static SPA + SPA-fallback. Registered last so /api and /ws routes
  // resolve before the catch-all.
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

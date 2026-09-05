import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { GitopsClient } from './services/gitops.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAuditRoutes } from './routes/audits.js';
import { registerAutomationRoutes } from './routes/automations.js';
import { registerBusinessProcessRoutes } from './routes/business-processes.js';
import { registerEventRoutes } from './routes/events.js';
import { registerPublicEndpointRoutes } from './routes/public-endpoints.js';
import { registerTemplateRoutes } from './routes/templates.js';
import { registerCodingAgentRoutes } from './routes/coding-agent.js';
import { registerSnapshotRoutes } from './routes/snapshots.js';
import { registerDataExplorerRoutes } from './routes/data-explorer.js';
import { registerCopyRoutes } from './routes/copies.js';
import { registerCopyFilesRoutes } from './routes/copy-files.js';
import { registerVscodeSidebarRoutes } from './routes/vscode-sidebar.js';
import { registerMeRoutes } from './routes/me.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { startAgentUploadsSweeper } from './services/agent-uploads.js';
import { requestContext } from './lib/requestContext.js';

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

  // Capture the gate-verified user email per request into AsyncLocalStorage so
  // the gitops client can forward it as X-Forwarded-Email on every upstream
  // call — gitops then attributes each git task-queue entry to that user.
  app.addHook('onRequest', (req, _reply, done) => {
    const raw = req.headers['x-forwarded-email'] ?? req.headers['x-auth-request-email'];
    const email = (Array.isArray(raw) ? raw[0] : raw)?.trim() || null;
    requestContext.run({ email }, done);
  });

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
  // Multipart for the file-upload endpoint in routes/copy-files.ts.
  // Limit per-file size to 5 MiB and total per-request to 16 files; users
  // doing larger drops should be using the editor or shell anyway.
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 5 * 1024 * 1024,
      files: 16,
    },
  });

  registerAuthRoutes(app);
  registerMeRoutes(app, { gitops });
  registerCodingAgentRoutes(app, { gitops });
  registerBusinessProcessRoutes(app, { workspaceRoot: WORKSPACE_ROOT, gitops });
  registerCopyRoutes(app, { gitops });
  registerCopyFilesRoutes(app, { workspaceRoot: WORKSPACE_ROOT, gitops });
  registerTemplateRoutes(app, { gitops });
  registerAutomationRoutes(app, { gitops });
  registerAuditRoutes(app, { gitops });
  registerSnapshotRoutes(app, { gitops });
  registerDataExplorerRoutes(app, { gitops });
  registerTaskRoutes(app, { gitops });
  registerEventRoutes(app, { gitops });
  registerPublicEndpointRoutes(app);
  registerVscodeSidebarRoutes(app, { workspaceRoot: WORKSPACE_ROOT });

  // Hourly reaper for pasted terminal images (see services/agent-uploads.ts).
  startAgentUploadsSweeper(app, { workspaceRoot: WORKSPACE_ROOT });

  // Static SPA + SPA-fallback. Registered last so /api and /ws routes
  // resolve before the catch-all.
  const clientDist = path.resolve(__dirname, '../../client/dist');
  // `wildcard: false` makes @fastify/static enumerate the bundle ONCE, at
  // registration. That is right for a baked image, where the bundle predates
  // the process — and wrong for dev mode, where the source tree is mounted and
  // `npm run build` writes new content-hashed names into it while the server
  // runs. Those files then have no route: the SPA fallback answers with
  // index.html, the browser refuses it as a module script ("Expected a
  // JavaScript-or-Wasm module script but the server responded with a MIME type
  // of text/html"), and the whole app fails to boot until someone restarts the
  // container. A rebuilt bundle should just be served.
  const servingAMountedSourceTree =
    process.env.BITSWAN_DEV_MODE === 'true' || Boolean(process.env.BITSWAN_DASHBOARD_DEV_DIR);
  await app.register(fastifyStatic, {
    root: clientDist,
    wildcard: servingAMountedSourceTree,
    // Cache policy, explicitly — without one the browser applies HEURISTIC
    // caching (a fraction of Last-Modified age) to whatever it likes,
    // including index.html. That pins a browser to the bundle it first saw:
    // the entry point names a content-hashed asset, so a stale index.html
    // keeps loading stale JS and the user runs an old app against a new
    // server (live-seen: a client that predated a required request field,
    // failing with the server's "bp is required").
    //   /assets/* are content-hashed → safe to cache forever.
    //   everything else (index.html above all) → always revalidate.
    setHeaders(res, filePath) {
      res.setHeader(
        'Cache-Control',
        filePath.includes(`${path.sep}assets${path.sep}`)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      );
    },
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.method !== 'GET' || req.url.startsWith('/ws') || req.url.startsWith('/api')) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    // The SPA fallback serves index.html for every app route; it must never
    // be cached (see the policy above).
    reply.header('Cache-Control', 'no-cache');
    reply.sendFile('index.html');
  });

  return app;
}

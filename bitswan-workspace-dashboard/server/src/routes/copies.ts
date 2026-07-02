import type { FastifyInstance } from 'fastify';
import type { GitopsClient } from '../services/gitops.js';
import { emailFromRequest } from '../lib/user.js';

export interface CopyRoutesOptions {
  gitops: GitopsClient | null;
}

/**
 * Copy creation. The listing itself flows over the `/api/events` SSE
 * feed (gitops broadcasts a `copies` event), so this file only carries
 * mutating endpoints. Validation of the branch name is delegated to
 * gitops, which has the canonical regex.
 *
 * There is deliberately NO copy-delete route: a copy is a user's personal
 * working environment, and the dashboard must never let a user delete their
 * own copy (or, worse, anyone else's). Copy lifecycle/cleanup is an operator
 * concern handled out-of-band (the gitops endpoint + daemon), not a
 * user-facing action.
 */
export function registerCopyRoutes(
  app: FastifyInstance,
  { gitops }: CopyRoutesOptions,
): void {
  app.post<{ Params: { name: string }; Body: { bp?: string } }>(
    '/api/copies/:name/sync',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) {
        return reply.code(503).send({ error: 'gitops not configured' });
      }
      const { name } = req.params;
      if (!name) {
        return reply.code(400).send({ error: 'name is required' });
      }
      // Optional: scope the sync to one business process (only its commits go
      // to main). Client-supplied; gitops validates the name.
      const bp =
        typeof req.body?.bp === 'string' && req.body.bp ? req.body.bp : undefined;
      // The deployer recorded on the deploy tag is the validated token email,
      // never a client-supplied value — it can't be spoofed.
      const deployer = await emailFromRequest(req, app.log);
      try {
        const r = await gitops.syncCopy(name, deployer ?? undefined, bp);
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return r.body;
      } catch (err) {
        app.log.warn({ err, name }, 'copy sync failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  app.post<{ Params: { name: string } }>(
    '/api/copies/:name/rebase',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) {
        return reply.code(503).send({ error: 'gitops not configured' });
      }
      const { name } = req.params;
      if (!name) {
        return reply.code(400).send({ error: 'name is required' });
      }
      // The deployer recorded on any follow-up redeploy is the validated token
      // email, never a client-supplied value — it can't be spoofed.
      const deployer = await emailFromRequest(req, app.log);
      try {
        const r = await gitops.rebaseCopy(name, deployer ?? undefined);
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return r.body;
      } catch (err) {
        app.log.warn({ err, name }, 'copy rebase failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  app.get<{ Params: { name: string } }>(
    '/api/copies/:name/history',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) {
        return reply.code(503).send({ error: 'gitops not configured' });
      }
      try {
        const r = await gitops.copyHistory(req.params.name);
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return r.body;
      } catch (err) {
        app.log.warn({ err, name: req.params.name }, 'copy history failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  app.get<{ Params: { name: string } }>(
    '/api/copies/:name/divergence-all',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) {
        return reply.code(503).send({ error: 'gitops not configured' });
      }
      try {
        const r = await gitops.copyDivergenceAll(req.params.name);
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return r.body;
      } catch (err) {
        app.log.warn(
          { err, name: req.params.name },
          'copy divergence-all failed',
        );
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  app.get<{ Params: { name: string }; Querystring: { bp?: string } }>(
    '/api/copies/:name/divergence',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) {
        return reply.code(503).send({ error: 'gitops not configured' });
      }
      if (!req.query.bp) {
        return reply.code(400).send({ error: 'bp is required' });
      }
      try {
        const r = await gitops.copyDivergence(req.params.name, req.query.bp);
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return r.body;
      } catch (err) {
        app.log.warn({ err, name: req.params.name }, 'copy divergence failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  app.post<{
    Body: { branch_name?: string; base_branch?: string };
  }>('/api/copies', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) {
      return reply.code(503).send({ error: 'gitops not configured' });
    }
    const { branch_name, base_branch } = req.body ?? {};
    if (!branch_name || typeof branch_name !== 'string') {
      return reply.code(400).send({ error: 'branch_name is required' });
    }
    try {
      const r = await gitops.createCopy({
        branch_name,
        ...(base_branch ? { base_branch } : {}),
      });
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return r.body;
    } catch (err) {
      app.log.warn({ err, branch_name }, 'copy create failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });
}

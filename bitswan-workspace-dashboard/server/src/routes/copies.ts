import type { FastifyInstance } from 'fastify';
import type { GitopsClient } from '../services/gitops.js';
import { emailFromRequest } from '../lib/user.js';

export interface CopyRoutesOptions {
  gitops: GitopsClient | null;
}

/**
 * Copy creation + deletion. The listing itself flows over the `/api/events`
 * SSE feed (gitops broadcasts a `copies` event), so this file only carries
 * mutating endpoints. Validation of the branch name is delegated to
 * gitops, which has the canonical regex.
 *
 * Copy deletion IS a user-facing action (it used to be operator-only):
 * the client shows a warn+confirm dialog listing unmerged/uncommitted work
 * before calling DELETE, and gitops tears down the whole copy — live-dev
 * deployments, per-copy databases, its branch in every BP repo, and the
 * directory tree. Deleting your own copy is allowed; a fresh one is
 * recreated from main on next use (via /api/me).
 */
export function registerCopyRoutes(
  app: FastifyInstance,
  { gitops }: CopyRoutesOptions,
): void {
  // Delete a whole copy. Gitops answers 202 + a task id and runs the
  // teardown on its queue; the `copies` SSE snapshot dropping the copy is
  // the completion signal. The unmerged-work warning is a CLIENT concern —
  // the server never blocks on divergence.
  app.delete<{ Params: { name: string } }>(
    '/api/copies/:name',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) {
        return reply.code(503).send({ error: 'gitops not configured' });
      }
      const { name } = req.params;
      if (!name) {
        return reply.code(400).send({ error: 'name is required' });
      }
      const deletedBy = await emailFromRequest(req, app.log);
      try {
        const r = await gitops.deleteCopy({
          name,
          ...(deletedBy ? { deleted_by: deletedBy } : {}),
        });
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return reply.code(202).send(r.body);
      } catch (err) {
        app.log.warn({ err, name }, 'copy delete failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

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

  app.post<{ Params: { name: string; bp: string } }>(
    '/api/copies/:name/bp/:bp/ensure',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) {
        return reply.code(503).send({ error: 'gitops not configured' });
      }
      const { name, bp } = req.params;
      if (!name || !bp) {
        return reply.code(400).send({ error: 'name and bp are required' });
      }
      try {
        const r = await gitops.ensureBpInCopy(name, bp);
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return r.body;
      } catch (err) {
        app.log.warn({ err, name, bp }, 'ensure bp in copy failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  app.get<{ Params: { name: string }; Querystring: { bp?: string } }>(
    '/api/copies/:name/history',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) {
        return reply.code(503).send({ error: 'gitops not configured' });
      }
      try {
        const r = await gitops.copyHistory(req.params.name, req.query.bp);
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

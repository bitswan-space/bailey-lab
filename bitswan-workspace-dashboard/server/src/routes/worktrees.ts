import type { FastifyInstance } from 'fastify';
import type { GitopsClient } from '../services/gitops.js';

export interface WorktreeRoutesOptions {
  gitops: GitopsClient | null;
}

/**
 * Worktree creation. The listing itself flows over the `/api/events` SSE
 * feed (gitops broadcasts a `worktrees` event), so this file only carries
 * mutating endpoints. Validation of the branch name is delegated to
 * gitops, which has the canonical regex.
 */
export function registerWorktreeRoutes(
  app: FastifyInstance,
  { gitops }: WorktreeRoutesOptions,
): void {
  app.delete<{ Params: { name: string } }>(
    '/api/worktrees/:name',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) {
        return reply.code(503).send({ error: 'gitops not configured' });
      }
      const { name } = req.params;
      if (!name) {
        return reply.code(400).send({ error: 'name is required' });
      }
      try {
        const r = await gitops.deleteWorktree(name);
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return r.body ?? { ok: true };
      } catch (err) {
        app.log.warn({ err, name }, 'worktree delete failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  app.post<{
    Body: { branch_name?: string; base_branch?: string };
  }>('/api/worktrees', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) {
      return reply.code(503).send({ error: 'gitops not configured' });
    }
    const { branch_name, base_branch } = req.body ?? {};
    if (!branch_name || typeof branch_name !== 'string') {
      return reply.code(400).send({ error: 'branch_name is required' });
    }
    try {
      const r = await gitops.createWorktree({
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
      app.log.warn({ err, branch_name }, 'worktree create failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });
}

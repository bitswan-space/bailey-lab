import type { FastifyInstance } from 'fastify';
import type { GitopsClient } from '../services/gitops.js';

export interface WorktreeRoutesOptions {
  gitops: GitopsClient | null;
}

/** `/api/worktrees` — proxies gitops's `/worktrees/` listing. */
export function registerWorktreeRoutes(
  app: FastifyInstance,
  { gitops }: WorktreeRoutesOptions,
): void {
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
}

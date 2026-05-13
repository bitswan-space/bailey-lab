import type { FastifyInstance } from 'fastify';
import {
  isValidBpId,
  isValidWorktreeName,
  readReadme,
} from '../services/workspace.js';
import type { GitopsClient } from '../services/gitops.js';

export interface BusinessProcessRoutesOptions {
  workspaceRoot: string;
  gitops: GitopsClient | null;
}

/**
 * Per-BP filesystem helpers. The BP listing itself isn't served here —
 * it flows over the `/api/events` SSE feed (cached from gitops's
 * `processes` event), so the only HTTP surface left is the README
 * lookup, which still needs direct filesystem access via the workspace
 * bind-mount.
 *
 * The README endpoint accepts an optional `?worktree=<name>` query so the
 * dashboard can show the worktree's copy of the spec when the user is in
 * a worktree scope (READMEs frequently diverge between main and a
 * worktree mid-development).
 */
export function registerBusinessProcessRoutes(
  app: FastifyInstance,
  { workspaceRoot, gitops }: BusinessProcessRoutesOptions,
): void {
  app.post<{
    Body: { name?: string; worktree?: string };
  }>('/api/business-processes', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) {
      return reply.code(503).send({ error: 'gitops not configured' });
    }
    const { name, worktree } = req.body ?? {};
    if (!name || typeof name !== 'string') {
      return reply.code(400).send({ error: 'name is required' });
    }
    try {
      const r = await gitops.createProcess({
        name,
        ...(worktree ? { worktree } : {}),
      });
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return r.body;
    } catch (err) {
      app.log.warn({ err, name, worktree }, 'BP create failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });

  app.get<{
    Params: { id: string };
    Querystring: { worktree?: string };
  }>('/api/business-processes/:id/readme', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!isValidBpId(req.params.id)) {
      return reply.code(400).send({ error: 'invalid bp id' });
    }
    const worktree = req.query.worktree;
    if (worktree !== undefined && !isValidWorktreeName(worktree)) {
      return reply.code(400).send({ error: 'invalid worktree' });
    }
    const content = await readReadme(req.params.id, workspaceRoot, worktree);
    return { content };
  });
}

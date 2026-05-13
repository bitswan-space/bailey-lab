import type { FastifyInstance } from 'fastify';
import {
  isValidBpId,
  isValidWorktreeName,
  readReadme,
} from '../services/workspace.js';

export interface BusinessProcessRoutesOptions {
  workspaceRoot: string;
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
  { workspaceRoot }: BusinessProcessRoutesOptions,
): void {
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

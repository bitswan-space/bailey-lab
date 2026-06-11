import type { FastifyInstance } from 'fastify';
import {
  isValidBpId,
  isValidWorktreeName,
  readReadme,
} from '../services/workspace.js';
import {
  addRequirement,
  isReqStatus,
  listRequirements,
  removeRequirement,
  updateRequirement,
  type ReqStatus,
} from '../services/requirements.js';
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

  // ---- Testable requirements ------------------------------------------
  //
  // Worktree-only. The TOML file lives at
  //   <workspaceRoot>/worktrees/<worktree>/<bp>/testable-requirements.toml
  // and is shared with `bitswan-coding-agent requirements …` — both write
  // the same schema. See server/src/services/requirements.ts.

  function validateBpWorktree(bp: string, worktree?: string): string | null {
    if (!isValidBpId(bp)) return 'invalid bp id';
    if (!worktree) return 'worktree is required';
    if (!isValidWorktreeName(worktree)) return 'invalid worktree';
    return null;
  }

  app.get<{
    Params: { id: string };
    Querystring: { worktree?: string };
  }>('/api/business-processes/:id/requirements', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const err = validateBpWorktree(req.params.id, req.query.worktree);
    if (err) return reply.code(400).send({ error: err });
    try {
      return await listRequirements({
        workspaceRoot,
        worktree: req.query.worktree!,
        bp: req.params.id,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      app.log.warn({ err: e, id: req.params.id }, 'requirements list failed');
      return reply.code(500).send({ error: msg });
    }
  });

  app.post<{
    Params: { id: string };
    Querystring: { worktree?: string };
    Body: { text?: string; parent?: string; status?: string };
  }>('/api/business-processes/:id/requirements', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const err = validateBpWorktree(req.params.id, req.query.worktree);
    if (err) return reply.code(400).send({ error: err });
    const { text, parent, status } = req.body ?? {};
    if (text !== undefined && typeof text !== 'string') {
      return reply.code(400).send({ error: 'text must be a string' });
    }
    if (status !== undefined && !isReqStatus(status)) {
      return reply.code(400).send({ error: 'invalid status' });
    }
    try {
      return await addRequirement({
        workspaceRoot,
        worktree: req.query.worktree!,
        bp: req.params.id,
        text: text ?? '',
        ...(parent ? { parent } : {}),
        ...(status ? { status: status as ReqStatus } : {}),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      app.log.warn({ err: e, id: req.params.id }, 'requirements add failed');
      return reply.code(400).send({ error: msg });
    }
  });

  app.patch<{
    Params: { id: string; reqId: string };
    Querystring: { worktree?: string };
    Body: { description?: string; status?: string };
  }>('/api/business-processes/:id/requirements/:reqId', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const err = validateBpWorktree(req.params.id, req.query.worktree);
    if (err) return reply.code(400).send({ error: err });
    const { description, status } = req.body ?? {};
    if (status !== undefined && !isReqStatus(status)) {
      return reply.code(400).send({ error: 'invalid status' });
    }
    if (description === undefined && status === undefined) {
      return reply.code(400).send({ error: 'description or status required' });
    }
    try {
      return await updateRequirement({
        workspaceRoot,
        worktree: req.query.worktree!,
        bp: req.params.id,
        id: req.params.reqId,
        patch: {
          ...(description !== undefined ? { description } : {}),
          ...(status !== undefined ? { status: status as ReqStatus } : {}),
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = msg.includes('not found') ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });

  app.delete<{
    Params: { id: string; reqId: string };
    Querystring: { worktree?: string };
  }>('/api/business-processes/:id/requirements/:reqId', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const err = validateBpWorktree(req.params.id, req.query.worktree);
    if (err) return reply.code(400).send({ error: err });
    try {
      await removeRequirement({
        workspaceRoot,
        worktree: req.query.worktree!,
        bp: req.params.id,
        id: req.params.reqId,
      });
      return reply.code(204).send();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = msg.includes('not found') ? 404 : 400;
      return reply.code(code).send({ error: msg });
    }
  });
}

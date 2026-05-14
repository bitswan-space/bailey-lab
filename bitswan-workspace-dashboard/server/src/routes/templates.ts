import type { FastifyInstance } from 'fastify';
import { isValidBpId, isValidWorktreeName } from '../services/workspace.js';
import type { GitopsClient } from '../services/gitops.js';

export interface TemplateRoutesOptions {
  gitops: GitopsClient | null;
}

/**
 * Template discovery + automation creation. Both endpoints proxy to gitops,
 * which owns the bind-mount on `/workspace/examples` and the only write path
 * into `/workspace-repo`. The dashboard server's role here is auth-boundary
 * and request validation.
 */
export function registerTemplateRoutes(
  app: FastifyInstance,
  { gitops }: TemplateRoutesOptions,
): void {
  app.get('/api/templates', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) {
      return reply.code(503).send({ error: 'gitops not configured' });
    }
    try {
      const r = await gitops.getTemplates();
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return r.body;
    } catch (err) {
      app.log.warn({ err }, 'templates fetch failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });

  app.post<{
    Body: {
      template_id?: string;
      group_id?: string;
      name?: string;
      bp?: string;
      worktree?: string;
    };
  }>('/api/automations/from-template', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) {
      return reply.code(503).send({ error: 'gitops not configured' });
    }
    const { template_id, group_id, name, bp, worktree } = req.body ?? {};
    if (!bp || !isValidBpId(bp)) {
      return reply.code(400).send({ error: 'invalid bp' });
    }
    if (worktree !== undefined && !isValidWorktreeName(worktree)) {
      return reply.code(400).send({ error: 'invalid worktree' });
    }
    if (!template_id && !group_id) {
      return reply.code(400).send({ error: 'template_id or group_id required' });
    }
    if (template_id && group_id) {
      return reply
        .code(400)
        .send({ error: 'template_id and group_id are mutually exclusive' });
    }
    try {
      const r = await gitops.createAutomationFromTemplate({
        ...(template_id ? { template_id } : {}),
        ...(group_id ? { group_id } : {}),
        ...(name !== undefined ? { name } : {}),
        bp,
        ...(worktree ? { worktree } : {}),
      });
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return r.body;
    } catch (err) {
      app.log.warn({ err, body: req.body }, 'create-from-template failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });
}

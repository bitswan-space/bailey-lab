import type { FastifyInstance } from 'fastify';
import {
  createAutomationFromTemplate,
  discoverTemplates,
} from '../services/templates.js';
import { isValidBpId, isValidWorktreeName } from '../services/workspace.js';
import type { GitopsClient } from '../services/gitops.js';

export interface TemplateRoutesOptions {
  workspaceRoot: string;
  gitops: GitopsClient | null;
}

/**
 * Template discovery + automation creation. Templates live under
 * `/workspace/examples` (mounted from `bitswan-src/examples` by the
 * compose generation), with optional overrides at
 * `<workspaceRoot>/templates/`. Mirrors the bitswan-editor gallery.
 */
export function registerTemplateRoutes(
  app: FastifyInstance,
  { workspaceRoot, gitops }: TemplateRoutesOptions,
): void {
  app.get('/api/templates', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { templates, groups } = discoverTemplates(workspaceRoot);
    // Strip server-only fields before returning.
    return {
      templates: templates.map(({ sourceDir: _s, ...rest }) => rest),
      groups: groups.map(({ sourceDir: _s, ...rest }) => rest),
    };
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
    const { template_id, group_id, name, bp, worktree } = req.body ?? {};
    if (!bp || !isValidBpId(bp)) {
      return reply.code(400).send({ error: 'invalid bp' });
    }
    if (worktree !== undefined && !isValidWorktreeName(worktree)) {
      return reply.code(400).send({ error: 'invalid worktree' });
    }
    if (!template_id && !group_id) {
      return reply
        .code(400)
        .send({ error: 'template_id or group_id required' });
    }
    if (template_id && group_id) {
      return reply
        .code(400)
        .send({ error: 'template_id and group_id are mutually exclusive' });
    }
    try {
      const result = await createAutomationFromTemplate(
        {
          ...(template_id ? { templateId: template_id } : {}),
          ...(group_id ? { groupId: group_id } : {}),
          ...(name !== undefined ? { name } : {}),
          bp,
          ...(worktree ? { worktree } : {}),
        },
        workspaceRoot,
      );

      // Record the new files in git. Same pattern the editor uses — failure
      // here doesn't block the create, the files are already on disk.
      if (gitops && result.created.length > 0) {
        const summary =
          result.created.length === 1
            ? `Add automation "${result.created[0]!.name}"`
            : `Add automations: ${result.created.map((c) => c.name).join(', ')}`;
        try {
          await gitops.commitWorktree({
            message: summary,
            ...(worktree ? { worktree } : {}),
          });
        } catch (err) {
          app.log.warn(
            { err, created: result.created },
            'auto-commit after template creation failed',
          );
        }
      }
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      app.log.warn({ err, body: req.body }, 'create-from-template failed');
      return reply.code(400).send({ error: msg });
    }
  });
}

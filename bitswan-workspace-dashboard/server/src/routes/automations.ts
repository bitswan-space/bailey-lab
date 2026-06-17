import type { FastifyInstance } from 'fastify';
import { openSse } from '../lib/sse.js';
import { emailFromRequest } from '../lib/user.js';
import type { GitopsClient } from '../services/gitops.js';

export interface AutomationRoutesOptions {
  gitops: GitopsClient | null;
}

/**
 * `/api/automations/*` — snapshot listing, per-deployment lifecycle actions,
 * Docker inspect, and a SSE log stream. All upstream calls are proxied
 * through {@link GitopsClient}; when `gitops` is `null` (env vars missing),
 * routes degrade to empty results or 503s.
 */
export function registerAutomationRoutes(
  app: FastifyInstance,
  { gitops }: AutomationRoutesOptions,
): void {
  // Deploy from the bind-mounted workspace (no asset upload).
  app.post<{
    Body: { relative_path?: string; stage?: string; copy?: string };
  }>('/api/automations/deploy', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
    const { relative_path, stage, copy } = req.body ?? {};
    if (!relative_path || typeof relative_path !== 'string') {
      return reply.code(400).send({ error: 'relative_path is required' });
    }
    if (stage !== 'dev' && stage !== 'live-dev') {
      return reply
        .code(400)
        .send({ error: "stage must be 'dev' or 'live-dev'" });
    }
    try {
      const r = await gitops.startDeploy({
        relative_path,
        stage,
        ...(copy ? { copy } : {}),
      });
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return r.body;
    } catch (err) {
      app.log.warn({ err, relative_path, stage }, 'deploy failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });

  // Deploy a whole business process (all member automations) as one unit.
  app.post<{
    Body: { bp?: string; stage?: string; copy?: string };
  }>('/api/automations/deploy-bp', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
    const { bp, stage, copy } = req.body ?? {};
    if (!bp || typeof bp !== 'string') {
      return reply.code(400).send({ error: 'bp is required' });
    }
    if (stage !== 'dev' && stage !== 'live-dev') {
      return reply
        .code(400)
        .send({ error: "stage must be 'dev' or 'live-dev'" });
    }
    try {
      const r = await gitops.deployBusinessProcess({
        bp,
        stage,
        ...(copy ? { copy } : {}),
      });
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return r.body;
    } catch (err) {
      app.log.warn({ err, bp, stage }, 'deploy-bp failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });

  // Promote a whole business process (all member automations) one stage up.
  app.post<{
    Body: { bp?: string; stage?: string };
  }>('/api/automations/promote-bp', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
    const { bp, stage } = req.body ?? {};
    if (!bp || typeof bp !== 'string') {
      return reply.code(400).send({ error: 'bp is required' });
    }
    if (stage !== 'staging' && stage !== 'production') {
      return reply
        .code(400)
        .send({ error: "stage must be 'staging' or 'production'" });
    }
    try {
      const r = await gitops.promoteBusinessProcess({ bp, stage });
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return r.body;
    } catch (err) {
      app.log.warn({ err, bp, stage }, 'promote-bp failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });

  // Per-stage deployment history for a business process (newest-first).
  app.get<{ Params: { bp: string }; Querystring: { stage?: string } }>(
    '/api/automations/business-processes/:bp/history',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
      try {
        const r = await gitops.bpHistory(req.params.bp, req.query.stage || 'dev');
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return r.body;
      } catch (err) {
        app.log.warn({ err, bp: req.params.bp }, 'bp history failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  // Roll a whole BP stage back to a prior deployment (all members together).
  app.post<{
    Params: { bp: string };
    Body: { stage?: string; git_commit?: string };
  }>('/api/automations/business-processes/:bp/rollback', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
    const { stage, git_commit } = req.body ?? {};
    if (!stage || !git_commit) {
      return reply.code(400).send({ error: 'stage and git_commit are required' });
    }
    // Deployer attribution comes from the validated token, never the client.
    const deployer = await emailFromRequest(req, app.log);
    try {
      const r = await gitops.bpRollback({
        bp: req.params.bp,
        stage,
        git_commit,
        ...(deployer ? { deployed_by: deployer } : {}),
      });
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return r.body;
    } catch (err) {
      app.log.warn({ err, bp: req.params.bp }, 'bp rollback failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });

  // Deploy-task status snapshot (poll fallback for SSE drops).
  app.get<{ Params: { taskId: string } }>(
    '/api/automations/deploy-status/:taskId',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
      try {
        const r = await gitops.getDeployStatus(req.params.taskId);
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return r.body;
      } catch (err) {
        app.log.warn({ err, taskId: req.params.taskId }, 'deploy-status failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  // Promote an already-deployed automation from one stage to the next.
  // Mirrors bitswan-editor's promote flow: re-deploys at the source stage's
  // checksum into `staging` or `production`. The target deployment_id is
  // derived from `automation_name` + `context` (BP name) + `stage` using
  // the same algorithm as the editor's `promoteStageCommand`.
  app.post<{
    Body: {
      automation_name?: string;
      context?: string;
      stage?: string;
      checksum?: string;
      relative_path?: string;
      deployed_by?: string;
    };
  }>('/api/automations/promote', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
    const { automation_name, context, stage, checksum, relative_path, deployed_by } =
      req.body ?? {};
    if (!automation_name || typeof automation_name !== 'string') {
      return reply.code(400).send({ error: 'automation_name is required' });
    }
    if (!checksum || typeof checksum !== 'string') {
      return reply.code(400).send({ error: 'checksum is required' });
    }
    if (stage !== 'staging' && stage !== 'production') {
      return reply
        .code(400)
        .send({ error: "stage must be 'staging' or 'production'" });
    }

    const sanitize = (s: string): string =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '')
        .replace(/^[,.-]+/g, '');

    // `automation_name` may arrive as a path (e.g. "bp/leaf") if it was
    // stored that way upstream; take the leaf, matching the editor's
    // `sourcePathParts.pop()` step.
    const leaf = automation_name.split('/').pop() ?? automation_name;
    const src = sanitize(leaf);
    const bp = context ? sanitize(context) : '';
    const bpPrefix = bp ? `${bp}-` : '';
    const targetDeploymentId =
      stage === 'production'
        ? `${src}-${bp || 'production'}`
        : `${src}-${bpPrefix}${stage}`;

    try {
      const r = await gitops.promoteDeploy(targetDeploymentId, {
        checksum,
        stage,
        automation_name: src,
        ...(bp ? { context: bp } : {}),
        ...(relative_path ? { relative_path } : {}),
        ...(deployed_by ? { deployed_by } : {}),
      });
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return r.body;
    } catch (err) {
      app.log.warn({ err, automation_name, stage }, 'promote failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });

  // Remove a deployment (stops container, removes from bitswan.yaml).
  app.delete<{ Params: { id: string } }>(
    '/api/automations/:id',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops)
        return reply.code(503).send({ error: 'gitops not configured' });
      try {
        const r = await gitops.removeAutomation(req.params.id);
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status });
        }
        return { ok: true };
      } catch (err) {
        app.log.warn({ err, id: req.params.id }, 'remove failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  // Per-deployment lifecycle actions.
  for (const action of ['start', 'stop', 'restart'] as const) {
    app.post<{ Params: { id: string } }>(
      `/api/automations/:id/${action}`,
      async (req, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
        try {
          const r = await gitops.actionAutomation(req.params.id, action);
          if (!r.ok) {
            return reply.code(502).send({ error: 'gitops error', status: r.status });
          }
          return { ok: true };
        } catch (err) {
          app.log.warn({ err, action, id: req.params.id }, 'automation action failed');
          return reply.code(502).send({ error: 'gitops unreachable' });
        }
      },
    );
  }

  // Container metadata (`docker inspect`) per deployment.
  app.get<{ Params: { id: string } }>('/api/automations/:id/inspect', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) return [];
    try {
      return await gitops.inspectAutomation(req.params.id);
    } catch (err) {
      app.log.warn({ err, id: req.params.id }, 'inspect failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });

  // Live log stream. Pipes the upstream gitops SSE body verbatim.
  app.get<{ Params: { id: string } }>('/api/automations/:id/logs', async (req, reply) => {
    if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });

    const ch = openSse(req, reply);
    try {
      const body = await gitops.streamLogs(req.params.id, ch.signal);
      const reader = body.getReader();
      const decoder = new TextDecoder();
      while (!ch.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        ch.write(decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      if (!ch.signal.aborted) {
        app.log.warn({ err, id: req.params.id }, 'logs stream error');
        ch.write(`event: error\ndata: ${JSON.stringify(String(err))}\n\n`);
      }
    } finally {
      ch.end();
    }
  });
}

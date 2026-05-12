import type { FastifyInstance } from 'fastify';
import { openSse } from '../lib/sse.js';
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
  // Snapshot of the latest automations seen on the upstream SSE feed.
  app.get('/api/automations', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return gitops ? gitops.getSnapshot() : [];
  });

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

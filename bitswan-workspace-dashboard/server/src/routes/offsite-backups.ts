import type { FastifyInstance, FastifyReply } from 'fastify';
import type { GitopsClient } from '../services/gitops.js';

export interface OffsiteBackupRoutesOptions {
  gitops: GitopsClient | null;
}

/**
 * `/api/offsite-backups/*` — workspace-level off-site (restic) backup proxy.
 * Thin pass-through to gitops's `/backups` router: config/status, manual
 * runs (202; outcome lands in `last_run` on config), the restic snapshot
 * list, and encryption-key management. When `gitops` is `null` the routes
 * degrade to 503s, mirroring the snapshot routes.
 */
export function registerOffsiteBackupRoutes(
  app: FastifyInstance,
  { gitops }: OffsiteBackupRoutesOptions,
): void {
  type Result = { ok: boolean; status: number; body: unknown };

  // Forward an upstream result, preserving 4xx detail (409 already-running,
  // 400 not configured) and mapping 5xx to 502.
  const forward = async (reply: FastifyReply, work: Promise<Result>) => {
    const r = await work;
    if (!r.ok) {
      return reply
        .code(r.status >= 400 && r.status < 500 ? r.status : 502)
        .send({ error: 'gitops error', status: r.status, body: r.body });
    }
    return r.body;
  };

  const proxy = (
    method: 'get' | 'post' | 'delete',
    path: string,
    work: (req: { body?: unknown; query?: unknown }) => Promise<Result>,
    label: string,
  ) => {
    app[method](path, async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
      try {
        return await forward(reply, work(req));
      } catch (err) {
        app.log.warn({ err }, `${label} failed`);
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    });
  };

  proxy('get', '/api/offsite-backups/config', () => gitops!.offsiteConfig(), 'offsite config');

  app.post<{
    Body: { enabled?: boolean; retention_daily?: number; retention_monthly?: number };
  }>('/api/offsite-backups/config', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
    const { enabled, retention_daily, retention_monthly } = req.body ?? {};
    if (typeof enabled !== 'boolean') {
      return reply.code(400).send({ error: 'enabled (boolean) is required' });
    }
    for (const [name, value] of [
      ['retention_daily', retention_daily],
      ['retention_monthly', retention_monthly],
    ] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
        return reply.code(400).send({ error: `${name} must be a non-negative integer` });
      }
    }
    try {
      return await forward(
        reply,
        gitops.saveOffsiteConfig({
          enabled,
          ...(retention_daily !== undefined ? { retention_daily } : {}),
          ...(retention_monthly !== undefined ? { retention_monthly } : {}),
        }),
      );
    } catch (err) {
      app.log.warn({ err }, 'offsite config save failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });

  proxy('post', '/api/offsite-backups/run', () => gitops!.runOffsiteBackup(), 'offsite run');

  app.get<{ Querystring: { tag?: string } }>(
    '/api/offsite-backups/snapshots',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
      try {
        return await forward(reply, gitops.offsiteSnapshots(req.query?.tag));
      } catch (err) {
        app.log.warn({ err }, 'offsite snapshots failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  proxy('get', '/api/offsite-backups/key', () => gitops!.offsiteKey(), 'offsite key download');
  proxy(
    'get',
    '/api/offsite-backups/key/status',
    () => gitops!.offsiteKeyStatus(),
    'offsite key status',
  );
  proxy(
    'post',
    '/api/offsite-backups/key/mirror',
    () => gitops!.mirrorOffsiteKey(),
    'offsite key mirror',
  );
  proxy(
    'delete',
    '/api/offsite-backups/key/mirror',
    () => gitops!.deleteOffsiteKeyMirror(),
    'offsite key mirror delete',
  );
}

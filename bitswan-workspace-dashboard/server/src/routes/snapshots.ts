import type { FastifyInstance, FastifyReply } from 'fastify';
import type { GitopsClient } from '../services/gitops.js';
import { emailFromRequest } from '../lib/user.js';

export interface SnapshotRoutesOptions {
  gitops: GitopsClient | null;
}

const STAGES = new Set(['dev', 'staging', 'production']);
// Where a restore/clone may LAND: never live Production. 'dr' is the safe
// recovery sink (gitops maps it to the production standby slot); dev/staging
// are in-place. The server mirrors the gitops-side guard.
const RESTORE_TARGETS = new Set(['dev', 'staging', 'dr']);

/**
 * `/api/snapshots/*` — per-BP stage-snapshot proxy. Thin pass-through to
 * gitops's `/snapshots` router: list/eligibility, provision opt-in, the
 * async create/restore/clone operations (202 + task_id, polled via the
 * task endpoint), and snapshot deletion. When `gitops` is `null` the
 * routes degrade to 503s, mirroring the automation routes.
 */
export function registerSnapshotRoutes(
  app: FastifyInstance,
  { gitops }: SnapshotRoutesOptions,
): void {
  type Result = { ok: boolean; status: number; body: unknown };

  // Forward an upstream result, preserving 4xx detail (409 busy, 404
  // missing snapshot, 400 validation) and mapping 5xx to 502.
  const forward = async (reply: FastifyReply, work: Promise<Result>) => {
    const r = await work;
    if (!r.ok) {
      return reply
        .code(r.status >= 400 && r.status < 500 ? r.status : 502)
        .send({ error: 'gitops error', status: r.status, body: r.body });
    }
    return r.body;
  };

  // Task poll endpoint (registered before /:bp so "tasks" isn't a BP).
  app.get<{ Params: { taskId: string } }>(
    '/api/snapshots/tasks/:taskId',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
      try {
        return await forward(reply, gitops.snapshotTaskStatus(req.params.taskId));
      } catch (err) {
        app.log.warn({ err, taskId: req.params.taskId }, 'snapshot task poll failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  app.get<{ Params: { bp: string } }>(
    '/api/snapshots/:bp',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
      try {
        return await forward(reply, gitops.listSnapshots(req.params.bp));
      } catch (err) {
        app.log.warn({ err, bp: req.params.bp }, 'snapshot list failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  app.get<{ Params: { bp: string } }>(
    '/api/snapshots/:bp/eligibility',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
      try {
        return await forward(reply, gitops.snapshotEligibility(req.params.bp));
      } catch (err) {
        app.log.warn({ err, bp: req.params.bp }, 'snapshot eligibility failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  app.post<{ Params: { bp: string }; Body: { stage?: string; bp_name?: string } }>(
    '/api/snapshots/:bp/provision',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
      const { stage, bp_name } = req.body ?? {};
      if (!stage || !STAGES.has(stage)) {
        return reply
          .code(400)
          .send({ error: "stage must be 'dev', 'staging' or 'production'" });
      }
      try {
        return await forward(
          reply,
          gitops.provisionBp(req.params.bp, {
            stage,
            ...(bp_name ? { bp_name } : {}),
          }),
        );
      } catch (err) {
        app.log.warn({ err, bp: req.params.bp, stage }, 'snapshot provision failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  app.post<{
    Params: { bp: string };
    Body: { snapshot_id?: string; source_stage?: string; target_stage?: string };
  }>('/api/snapshots/:bp/restore', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
    const { snapshot_id, source_stage, target_stage } = req.body ?? {};
    if (!snapshot_id || typeof snapshot_id !== 'string') {
      return reply.code(400).send({ error: 'snapshot_id is required' });
    }
    if (!source_stage || !STAGES.has(source_stage)) {
      return reply
        .code(400)
        .send({ error: "source_stage must be 'dev', 'staging' or 'production'" });
    }
    if (!target_stage || !RESTORE_TARGETS.has(target_stage)) {
      return reply.code(400).send({
        error:
          "target_stage must be 'dev', 'staging' or 'dr' — restoring onto live Production is not allowed",
      });
    }
    // Attribute a DR restore to the signed-in user so the "in DR now" pointer
    // records who loaded it (the client doesn't send `by`).
    const by = (await emailFromRequest(req, app.log)) || undefined;
    try {
      return await forward(
        reply,
        gitops.restoreSnapshot(req.params.bp, {
          snapshot_id,
          source_stage,
          target_stage,
          ...(by ? { by } : {}),
        }),
      );
    } catch (err) {
      app.log.warn({ err, bp: req.params.bp, snapshot_id }, 'snapshot restore failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });

  app.post<{
    Params: { bp: string };
    Body: { source_stage?: string; target_stage?: string };
  }>('/api/snapshots/:bp/clone', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
    const { source_stage, target_stage } = req.body ?? {};
    if (!source_stage || !STAGES.has(source_stage)) {
      return reply
        .code(400)
        .send({ error: "source_stage must be 'dev', 'staging' or 'production'" });
    }
    // Clone may seed dev/staging but never overwrite live Production.
    if (!target_stage || target_stage === 'production' || !STAGES.has(target_stage)) {
      return reply
        .code(400)
        .send({ error: "target_stage must be 'dev' or 'staging' — not live Production" });
    }
    try {
      return await forward(
        reply,
        gitops.cloneStage(req.params.bp, { source_stage, target_stage }),
      );
    } catch (err) {
      app.log.warn({ err, bp: req.params.bp }, 'snapshot clone failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });

  // Create a snapshot at one stage. Fastify's router prefers static
  // segments (/provision, /restore, /clone) over `:stage` regardless of
  // registration order; the stage whitelist above is the real guard.
  app.post<{ Params: { bp: string; stage: string }; Body: { label?: string } }>(
    '/api/snapshots/:bp/:stage',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
      const { stage } = req.params;
      if (!STAGES.has(stage)) {
        return reply
          .code(400)
          .send({ error: "stage must be 'dev', 'staging' or 'production'" });
      }
      try {
        return await forward(
          reply,
          gitops.createSnapshot(req.params.bp, stage, {
            label: req.body?.label ?? '',
          }),
        );
      } catch (err) {
        app.log.warn({ err, bp: req.params.bp, stage }, 'snapshot create failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  app.delete<{ Params: { bp: string; stage: string; snapshotId: string } }>(
    '/api/snapshots/:bp/:stage/:snapshotId',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
      try {
        return await forward(
          reply,
          gitops.deleteSnapshot(
            req.params.bp,
            req.params.stage,
            req.params.snapshotId,
          ),
        );
      } catch (err) {
        app.log.warn(
          { err, bp: req.params.bp, snapshotId: req.params.snapshotId },
          'snapshot delete failed',
        );
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );
}

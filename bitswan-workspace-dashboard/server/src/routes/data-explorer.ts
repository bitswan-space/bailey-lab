import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { GitopsClient } from '../services/gitops.js';

export interface DataExplorerRoutesOptions {
  gitops: GitopsClient | null;
}

const STAGES = new Set(['dev', 'staging', 'production']);
const ORDERS = new Set(['asc', 'desc']);

type CommonQuery = { copy?: string; db?: string };

/**
 * `/api/data-explorer/*` — read-only Object Storage / SQL explorer proxy,
 * mirroring gitops's `/data-explorer` router 1:1. Query params are rebuilt
 * from a whitelist (never passed through raw). Access: anyone who can see
 * the BP — the surface is read-only by construction upstream (SELECT-only
 * ro_ role; list/stat/preview/download only), so no extra role gating.
 */
export function registerDataExplorerRoutes(
  app: FastifyInstance,
  { gitops }: DataExplorerRoutesOptions,
): void {
  type Result = { ok: boolean; status: number; body: unknown };

  const forward = async (reply: FastifyReply, work: Promise<Result>) => {
    const r = await work;
    if (!r.ok) {
      return reply
        .code(r.status >= 400 && r.status < 500 ? r.status : 502)
        .send({ error: 'gitops error', status: r.status, body: r.body });
    }
    return r.body;
  };

  /** Validate the shared (bp, stage) + (copy, db) scope; null = replied 4xx. */
  const scopeQs = (
    reply: FastifyReply,
    stage: string,
    q: CommonQuery,
  ): URLSearchParams | null => {
    if (!STAGES.has(stage)) {
      reply.code(400).send({ error: `invalid stage: ${stage}` });
      return null;
    }
    const qs = new URLSearchParams();
    if (q.copy) qs.set('copy', q.copy);
    if (q.db !== undefined && q.db !== '') {
      const db = Number(q.db);
      if (db !== 1 && db !== 2) {
        reply.code(400).send({ error: 'db must be 1 or 2' });
        return null;
      }
      qs.set('db', String(db));
    }
    return qs;
  };

  const jsonRoute = (
    routePath: string,
    subpath: (qs: URLSearchParams, q: Record<string, string | undefined>) => string | null,
  ) => {
    app.get<{
      Params: { bp: string; stage: string };
      Querystring: CommonQuery & Record<string, string | undefined>;
    }>(routePath, async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
      const qs = scopeQs(reply, req.params.stage, req.query);
      if (!qs) return reply;
      const sub = subpath(qs, req.query);
      if (sub === null) {
        return reply.code(400).send({ error: 'missing required parameter' });
      }
      try {
        return await forward(
          reply,
          gitops.dataExplorer(req.params.bp, req.params.stage, sub, qs.toString()),
        );
      } catch (err) {
        app.log.warn({ err, bp: req.params.bp }, 'data explorer request failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    });
  };

  jsonRoute('/api/data-explorer/:bp/:stage', () => '');

  jsonRoute('/api/data-explorer/:bp/:stage/sql/tables', () => '/sql/tables');

  jsonRoute('/api/data-explorer/:bp/:stage/sql/columns', (qs, q) => {
    if (!q.table) return null;
    qs.set('table', q.table);
    return '/sql/columns';
  });

  jsonRoute('/api/data-explorer/:bp/:stage/sql/rows', (qs, q) => {
    if (!q.table) return null;
    qs.set('table', q.table);
    const limit = Math.max(1, Math.min(Number(q.limit) || 50, 200));
    const offset = Math.max(0, Math.min(Number(q.offset) || 0, 1_000_000));
    qs.set('limit', String(limit));
    qs.set('offset', String(offset));
    if (q.sort) qs.set('sort', q.sort);
    if (q.order && ORDERS.has(q.order)) qs.set('order', q.order);
    return '/sql/rows';
  });

  jsonRoute('/api/data-explorer/:bp/:stage/objects', (qs, q) => {
    if (q.prefix) qs.set('prefix', q.prefix);
    return '/objects';
  });

  jsonRoute('/api/data-explorer/:bp/:stage/objects/stat', (qs, q) => {
    if (!q.key) return null;
    qs.set('key', q.key);
    return '/objects/stat';
  });

  jsonRoute('/api/data-explorer/:bp/:stage/objects/preview', (qs, q) => {
    if (!q.key) return null;
    qs.set('key', q.key);
    if (q.max_bytes) {
      const mb = Number(q.max_bytes);
      if (Number.isFinite(mb) && mb > 0) qs.set('max_bytes', String(Math.floor(mb)));
    }
    return '/objects/preview';
  });

  // Object download: stream the body straight through (bpBundle pattern).
  app.get<{
    Params: { bp: string; stage: string };
    Querystring: CommonQuery & { key?: string };
  }>('/api/data-explorer/:bp/:stage/objects/download', async (req, reply) => {
    if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
    const qs = scopeQs(reply, req.params.stage, req.query);
    if (!qs) return reply;
    if (!req.query.key) {
      return reply.code(400).send({ error: 'key is required' });
    }
    qs.set('key', req.query.key);
    try {
      const r = await gitops.dataExplorerDownload(
        req.params.bp,
        req.params.stage,
        qs.toString(),
      );
      if (!r.ok || !r.body) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'download failed' });
      }
      const basename = req.query.key.split('/').pop() || 'object';
      // Strip anything that could break out of the quoted filename.
      const safeName = basename.replace(/["\r\n\\]/g, '_');
      reply.header('Content-Type', r.headers.get('content-type') ?? 'application/octet-stream');
      reply.header(
        'Content-Disposition',
        r.headers.get('content-disposition') ?? `attachment; filename="${safeName}"`,
      );
      return reply.send(Readable.fromWeb(r.body as never));
    } catch (err) {
      app.log.warn({ err, bp: req.params.bp }, 'object download failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });
}

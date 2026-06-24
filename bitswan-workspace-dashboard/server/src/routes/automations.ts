import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { openSse } from '../lib/sse.js';
import { emailFromRequest, fwRoleFromRequest } from '../lib/user.js';
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
    const deployed_by = (await emailFromRequest(req, app.log)) || undefined;
    try {
      const r = await gitops.deployBusinessProcess({
        bp,
        stage,
        ...(copy ? { copy } : {}),
        ...(deployed_by ? { deployed_by } : {}),
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
    const deployed_by = (await emailFromRequest(req, app.log)) || undefined;
    try {
      const r = await gitops.promoteBusinessProcess({
        bp,
        stage,
        ...(deployed_by ? { deployed_by } : {}),
      });
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

  // Deployments → Secrets: read the BP's shared key names + per-stage values.
  app.get<{ Params: { bp: string } }>(
    '/api/automations/business-processes/:bp/secrets',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
      try {
        const r = await gitops.bpSecrets(req.params.bp);
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return r.body;
      } catch (err) {
        app.log.warn({ err, bp: req.params.bp }, 'bp secrets read failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  // Deployments → Secrets: apply a BP's secrets (encrypted + versioned, one
  // commit). Names are shared across stages; values are per stage, so the body
  // carries every realm's map: { dev, staging, production }.
  app.put<{
    Params: { bp: string };
    Body: { values?: Record<string, Record<string, string>> };
  }>('/api/automations/business-processes/:bp/secrets', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
    const { values } = req.body ?? {};
    if (typeof values !== 'object' || values === null) {
      return reply.code(400).send({ error: 'values{} is required' });
    }
    try {
      const r = await gitops.bpSetSecrets(req.params.bp, values);
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return r.body;
    } catch (err) {
      app.log.warn({ err, bp: req.params.bp }, 'bp secrets write failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });

  // Disaster Recovery → read the BP's recovery-test cadence + manual test log.
  app.get<{ Params: { bp: string } }>(
    '/api/automations/business-processes/:bp/dr',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
      try {
        const r = await gitops.dr(req.params.bp);
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return r.body;
      } catch (err) {
        app.log.warn({ err, bp: req.params.bp }, 'bp dr read failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  // Disaster Recovery → set the recovery-test cadence policy.
  app.put<{
    Params: { bp: string };
    Body: { policy?: string };
  }>('/api/automations/business-processes/:bp/dr/policy', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
    const { policy } = req.body ?? {};
    if (!policy || typeof policy !== 'string') {
      return reply.code(400).send({ error: 'policy is required' });
    }
    // The recovery-test cadence is a compliance control — only admins/auditors
    // may change it. Resolve the role from the validated token (never trust the
    // client) and reject everyone else.
    const role = await fwRoleFromRequest(req, gitops, app.log);
    if (role !== 'admin' && role !== 'auditor') {
      return reply
        .code(403)
        .send({ error: 'Changing the recovery-test cadence requires an admin or auditor role.' });
    }
    try {
      const r = await gitops.setDrPolicy(req.params.bp, policy);
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return r.body;
    } catch (err) {
      app.log.warn({ err, bp: req.params.bp }, 'bp dr policy write failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });

  // Disaster Recovery → record a hand-performed recovery test (versioned).
  app.post<{
    Params: { bp: string };
    Body: { by?: string; note?: string; snapshot?: string };
  }>('/api/automations/business-processes/:bp/dr/tests', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
    const { by, note, snapshot } = req.body ?? {};
    // Attribute the test to the signed-in user (the client doesn't send `by`).
    const author = by || (await emailFromRequest(req, app.log)) || undefined;
    try {
      const r = await gitops.recordDrTest(req.params.bp, {
        ...(author ? { by: author } : {}),
        ...(note ? { note } : {}),
        ...(snapshot ? { snapshot } : {}),
      });
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return r.body;
    } catch (err) {
      app.log.warn({ err, bp: req.params.bp }, 'bp dr test record failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });

  // Backups → blue-green slot state (live vs standby/DR), retention, audit log.
  app.get<{ Params: { bp: string } }>(
    '/api/automations/business-processes/:bp/backups',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
      try {
        const r = await gitops.backups(req.params.bp);
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return r.body;
      } catch (err) {
        app.log.warn({ err, bp: req.params.bp }, 'bp backups read failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  // Backups → set the production retention policy / run the DR go-live swap.
  // Both attribute to the signed-in user (the client doesn't send `by`).
  const backupWrite = (suffix: string, method: 'PUT' | 'POST') =>
    app.route<{ Params: { bp: string }; Body: Record<string, unknown> }>({
      method,
      url: `/api/automations/business-processes/:bp/backups${suffix}`,
      handler: async (req, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
        const by = (await emailFromRequest(req, app.log)) || undefined;
        try {
          const r = await gitops.backupWrite(req.params.bp, suffix, method, {
            ...(req.body ?? {}),
            ...(by ? { by } : {}),
          });
          if (!r.ok) {
            return reply
              .code(r.status >= 400 && r.status < 500 ? r.status : 502)
              .send({ error: 'gitops error', status: r.status, body: r.body });
          }
          return r.body;
        } catch (err) {
          app.log.warn({ err, bp: req.params.bp }, 'bp backups write failed');
          return reply.code(502).send({ error: 'gitops unreachable' });
        }
      },
    });
  backupWrite('/retention', 'PUT');
  backupWrite('/swap', 'POST');
  backupWrite('/promote', 'POST');

  // Supply chain → SBOM packages + CVEs (syft/grype) for the deployed image(s)
  // at a stage, plus the out-of-scope waiver log.
  app.get<{ Params: { bp: string }; Querystring: { stage?: string } }>(
    '/api/automations/business-processes/:bp/supply-chain',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
      try {
        const r = await gitops.supplyChain(req.params.bp, req.query.stage || 'dev');
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return r.body;
      } catch (err) {
        app.log.warn({ err, bp: req.params.bp }, 'supply-chain read failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  // Supply chain preview → SBOM + CVEs for the image a deploy of this BP would
  // build from the current source (Sync & Deploy → Checks). Builds + scans.
  app.get<{ Params: { bp: string }; Querystring: { copy?: string } }>(
    '/api/automations/business-processes/:bp/supply-chain/preview',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
      try {
        const r = await gitops.supplyChainPreview(req.params.bp, req.query.copy ?? null);
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return r.body;
      } catch (err) {
        app.log.warn({ err, bp: req.params.bp }, 'supply-chain preview failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  // Supply chain → mark a CVE out of scope (POST) / restore it (DELETE),
  // attributed to the signed-in user and versioned in bitswan.yaml.
  for (const method of ['POST', 'DELETE'] as const) {
    app.route<{
      Params: { bp: string };
      Body: { copy?: string | null; package?: string; cve?: string; comment?: string };
    }>({
      method,
      url: '/api/automations/business-processes/:bp/supply-chain/waivers',
      handler: async (req, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
        const { copy, package: pkg, cve, comment } = req.body ?? {};
        if (!pkg || !cve) {
          return reply.code(400).send({ error: 'package and cve are required' });
        }
        const by = (await emailFromRequest(req, app.log)) || undefined;
        try {
          const r = await gitops.supplyChainWaiver(req.params.bp, method, {
            copy: copy ?? null,
            package: pkg,
            cve,
            ...(comment ? { comment } : {}),
            ...(by ? { by } : {}),
          });
          if (!r.ok) {
            return reply
              .code(r.status >= 400 && r.status < 500 ? r.status : 502)
              .send({ error: 'gitops error', status: r.status, body: r.body });
          }
          return r.body;
        } catch (err) {
          app.log.warn({ err, bp: req.params.bp }, 'supply-chain waiver failed');
          return reply.code(502).send({ error: 'gitops unreachable' });
        }
      },
    });
  }

  // Firewall → egress allow-list rules + blocked/observed attempts.
  app.get<{ Params: { bp: string }; Querystring: { stage?: string } }>(
    '/api/automations/business-processes/:bp/firewall',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
      try {
        const r = await gitops.firewall(req.params.bp, req.query.stage || 'dev');
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return r.body;
      } catch (err) {
        app.log.warn({ err, bp: req.params.bp }, 'firewall read failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  // Firewall → set/delete a rule, or pull rules forward. The actor email + the
  // resolved role are injected server-side; gitops enforces prod RBAC.
  const fwWrite = (
    suffix: string,
    method: 'PUT' | 'DELETE' | 'POST',
  ) =>
    app.route<{ Params: { bp: string }; Body: Record<string, unknown> }>({
      method,
      url: `/api/automations/business-processes/:bp/firewall${suffix}`,
      handler: async (req, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
        const by = (await emailFromRequest(req, app.log)) || undefined;
        const role = await fwRoleFromRequest(req, gitops, app.log);
        try {
          const r = await gitops.firewallWrite(req.params.bp, suffix, method, {
            ...(req.body ?? {}),
            ...(by ? { by } : {}),
            role,
          });
          if (!r.ok) {
            return reply
              .code(r.status >= 400 && r.status < 500 ? r.status : 502)
              .send({ error: 'gitops error', status: r.status, body: r.body });
          }
          return r.body;
        } catch (err) {
          app.log.warn({ err, bp: req.params.bp }, 'firewall write failed');
          return reply.code(502).send({ error: 'gitops unreachable' });
        }
      },
    });
  fwWrite('/rules', 'PUT');
  fwWrite('/rules', 'DELETE');
  fwWrite('/promote', 'POST');

  // Upload a host's GDPR data-processing-agreement PDF (multipart). The file is
  // stored + versioned in the gitops repo; production is RBAC-gated server-side.
  app.post<{ Params: { bp: string } }>(
    '/api/automations/business-processes/:bp/firewall/dpa',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
      if (!req.isMultipart()) {
        return reply.code(400).send({ error: 'expected multipart/form-data' });
      }
      let stage = '';
      let host = '';
      let filename = '';
      let content: Buffer | null = null;
      let contentType = 'application/pdf';
      try {
        for await (const part of req.parts()) {
          if (part.type === 'file' && part.fieldname === 'file') {
            filename = (part.filename ?? 'dpa.pdf').split('/').pop() || 'dpa.pdf';
            contentType = part.mimetype || contentType;
            content = await part.toBuffer();
          } else if (part.type === 'field') {
            if (part.fieldname === 'stage') stage = String(part.value);
            else if (part.fieldname === 'host') host = String(part.value);
          }
        }
      } catch (err) {
        app.log.warn({ err, bp: req.params.bp }, 'firewall dpa parse failed');
        return reply.code(400).send({ error: 'could not read upload' });
      }
      if (!stage || !host || !content) {
        return reply.code(400).send({ error: 'stage, host and file are required' });
      }
      // Attribution + role come from the validated token, never the client.
      const by = (await emailFromRequest(req, app.log)) || undefined;
      const role = await fwRoleFromRequest(req, gitops, app.log);
      try {
        const r = await gitops.firewallDpaUpload(req.params.bp, {
          stage,
          host,
          filename,
          content,
          contentType,
          ...(by ? { by } : {}),
          ...(role ? { role } : {}),
        });
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return r.body;
      } catch (err) {
        app.log.warn({ err, bp: req.params.bp }, 'firewall dpa upload failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  // Download a host's stored DPA PDF (streamed through from gitops).
  app.get<{ Params: { bp: string }; Querystring: { host?: string } }>(
    '/api/automations/business-processes/:bp/firewall/dpa',
    async (req, reply) => {
      if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
      const { host } = req.query;
      if (!host) {
        return reply.code(400).send({ error: 'host is required' });
      }
      try {
        const r = await gitops.firewallDpaDownload(req.params.bp, host);
        if (!r.ok) {
          return reply.code(r.status >= 400 && r.status < 500 ? r.status : 502).send({
            error: 'gitops error',
            status: r.status,
          });
        }
        reply.header('Content-Type', r.contentType);
        reply.header('Cache-Control', 'no-store');
        return reply.send(r.body);
      } catch (err) {
        app.log.warn({ err, bp: req.params.bp }, 'firewall dpa download failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  // Disaster Recovery → the BP's snapshot list (the DR panel's "tested
  // against" snapshot picker). Proxies the gitops snapshots list.
  app.get<{ Params: { bp: string } }>(
    '/api/automations/business-processes/:bp/snapshots',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
      try {
        const r = await gitops.bpSnapshots(req.params.bp);
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return r.body;
      } catch (err) {
        app.log.warn({ err, bp: req.params.bp }, 'bp snapshots failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  // Containers tab → "Stage services": status (incl. admin_ui URL) of an infra
  // service (postgres/minio/couchdb) for a stage. Only enabled+running services
  // are surfaced as links by the client.
  app.get<{ Params: { type: string }; Querystring: { stage?: string } }>(
    '/api/services/:type/status',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
      try {
        const r = await gitops.serviceStatus(req.params.type, req.query.stage || '');
        if (!r.ok) {
          return reply
            .code(r.status >= 400 && r.status < 500 ? r.status : 502)
            .send({ error: 'gitops error', status: r.status, body: r.body });
        }
        return r.body;
      } catch (err) {
        app.log.warn({ err, type: req.params.type }, 'service status failed');
        return reply.code(502).send({ error: 'gitops unreachable' });
      }
    },
  );

  // Inspect → Scale: scale every member container of a BP stage.
  app.post<{
    Params: { bp: string };
    Body: { stage?: string; replicas?: number };
  }>('/api/automations/business-processes/:bp/scale', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
    const { stage, replicas } = req.body ?? {};
    if (!stage || typeof replicas !== 'number') {
      return reply.code(400).send({ error: 'stage and replicas are required' });
    }
    try {
      const r = await gitops.bpScale(req.params.bp, stage, replicas);
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return r.body;
    } catch (err) {
      app.log.warn({ err, bp: req.params.bp }, 'bp scale failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });

  // Inspect → Files: the full source tree of a BP at a commit.
  app.get<{
    Params: { bp: string };
    Querystring: { commit?: string };
  }>('/api/automations/business-processes/:bp/files', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
    if (!req.query.commit) {
      return reply.code(400).send({ error: 'commit is required' });
    }
    try {
      const r = await gitops.bpFileTree(req.params.bp, req.query.commit);
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return r.body;
    } catch (err) {
      app.log.warn({ err, bp: req.params.bp }, 'bp files failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });

  // Inspect → Files: a single file's content at a commit.
  app.get<{
    Params: { bp: string };
    Querystring: { commit?: string; path?: string };
  }>('/api/automations/business-processes/:bp/file-content', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
    if (!req.query.commit || !req.query.path) {
      return reply.code(400).send({ error: 'commit and path are required' });
    }
    try {
      const r = await gitops.bpFileContent(req.params.bp, req.query.commit, req.query.path);
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return r.body;
    } catch (err) {
      app.log.warn({ err, bp: req.params.bp }, 'bp file content failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });

  // Inspect → Download image: stream the (large) deployment bundle through.
  app.get<{
    Params: { bp: string };
    Querystring: { stage?: string; commit?: string };
  }>('/api/automations/business-processes/:bp/bundle', async (req, reply) => {
    if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
    const { stage, commit } = req.query;
    if (!stage || !commit) {
      return reply.code(400).send({ error: 'stage and commit are required' });
    }
    try {
      const r = await gitops.bpBundle(req.params.bp, stage, commit);
      if (!r.ok || !r.body) {
        return reply.code(r.status >= 400 ? r.status : 502).send({ error: 'bundle failed' });
      }
      reply.header('Content-Type', r.headers.get('content-type') ?? 'application/gzip');
      reply.header(
        'Content-Disposition',
        r.headers.get('content-disposition') ??
          `attachment; filename="${req.params.bp}-${stage}.tar.gz"`,
      );
      return reply.send(Readable.fromWeb(r.body as never));
    } catch (err) {
      app.log.warn({ err, bp: req.params.bp }, 'bp bundle failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });

  // Diff a BP's source between two commits (history "diff vs current").
  app.get<{
    Params: { bp: string };
    Querystring: { from?: string; to?: string };
  }>('/api/automations/business-processes/:bp/diff', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
    const { from, to } = req.query;
    if (!from || !to) {
      return reply.code(400).send({ error: 'from and to are required' });
    }
    try {
      const r = await gitops.bpDiff(req.params.bp, from, to);
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return r.body;
    } catch (err) {
      app.log.warn({ err, bp: req.params.bp }, 'bp diff failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });

  // Roll a whole BP stage back to a prior deployment (all members together).
  app.post<{
    Params: { bp: string };
    Body: { stage?: string; git_commit?: string; kind?: 'deploy' | 'firewall' };
  }>('/api/automations/business-processes/:bp/rollback', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
    const { stage, git_commit, kind } = req.body ?? {};
    if (!stage || !git_commit) {
      return reply.code(400).send({ error: 'stage and git_commit are required' });
    }
    // Deployer attribution comes from the validated token, never the client.
    const deployer = await emailFromRequest(req, app.log);
    // Firewall rollbacks are RBAC-gated in production — resolve the role here so
    // the client cannot assert its own role (gitops enforces it again).
    const role = kind === 'firewall' ? await fwRoleFromRequest(req, gitops, app.log) : undefined;
    try {
      const r = await gitops.bpRollback({
        bp: req.params.bp,
        stage,
        git_commit,
        ...(kind ? { kind } : {}),
        ...(role ? { role } : {}),
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

  // Image build-log stream by checksum. Gitops serves the `docker build` output
  // as a plain-text follow-stream; we re-frame it line-by-line as SSE `log`
  // events so the browser can consume it with the same EventSource machinery as
  // container logs (then `end` once the build's final log is fully read).
  app.get<{ Params: { checksum: string } }>(
    '/api/images/builds/:checksum/logs',
    async (req, reply) => {
      if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });

      const ch = openSse(req, reply);
      try {
        const body = await gitops.streamBuildLogs(req.params.checksum, ch.signal);
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (!ch.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // Emit complete lines; keep the trailing partial in the buffer.
          const parts = buf.split('\n');
          buf = parts.pop() ?? '';
          for (const line of parts) {
            ch.write(`event: log\ndata: ${JSON.stringify({ line })}\n\n`);
          }
        }
        if (buf.length > 0) {
          ch.write(`event: log\ndata: ${JSON.stringify({ line: buf })}\n\n`);
        }
        if (!ch.signal.aborted) ch.write(`event: end\ndata: {}\n\n`);
      } catch (err) {
        if (!ch.signal.aborted) {
          app.log.warn({ err, checksum: req.params.checksum }, 'build-log stream error');
          ch.write(`event: error\ndata: ${JSON.stringify(String(err))}\n\n`);
        }
      } finally {
        ch.end();
      }
    },
  );
}

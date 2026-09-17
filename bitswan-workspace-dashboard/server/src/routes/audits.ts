import type { FastifyInstance } from 'fastify';
import { isValidBpId } from '../services/workspace.js';
import type { GitopsClient } from '../services/gitops.js';

export interface AuditRoutesOptions {
  gitops: GitopsClient | null;
}

/**
 * An audit happens in a copy of the version under audit, so the surface here is
 * small: read the audit's state, or open it. Everything the auditor then does —
 * the agent, the files, the diff, Deploy — is what a copy already does.
 *
 * gitops owns the rules (admin/auditor, staging frozen, which commit is under
 * audit) and resolves the auditor from the identity the gate verified, so these
 * routes carry the question across rather than re-deciding it.
 */
export function registerAuditRoutes(
  app: FastifyInstance,
  { gitops }: AuditRoutesOptions,
): void {
  const carry = async (
    bp: string,
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    run: () => Promise<{ ok: boolean; status: number; body: unknown }>,
    what: string,
  ) => {
    if (!gitops) return reply.code(503).send({ error: 'gitops not configured' });
    if (!isValidBpId(bp)) return reply.code(400).send({ error: 'invalid business process' });
    try {
      const r = await run();
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return r.body;
    } catch (err) {
      app.log.warn({ err, bp }, `${what} failed`);
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  };

  app.get<{ Params: { bp: string } }>('/api/audits/:bp/copy', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return carry(req.params.bp, reply, () => gitops!.auditState(req.params.bp), 'audit state read');
  });

  app.post<{ Params: { bp: string } }>('/api/audits/:bp/copy', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return carry(req.params.bp, reply, () => gitops!.openAudit(req.params.bp), 'opening an audit');
  });
}

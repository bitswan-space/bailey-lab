import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { GitopsClient } from '../services/gitops.js';
import { emailFromRequest, fwRoleFromRequest } from '../lib/user.js';

export interface WorkspaceSettingsRoutesOptions {
  gitops: GitopsClient | null;
}

type UpstreamResult = { ok: boolean; status: number; body: unknown };

export function registerWorkspaceSettingsRoutes(
  app: FastifyInstance,
  { gitops }: WorkspaceSettingsRoutesOptions,
): void {
  const forward = async (
    req: FastifyRequest,
    reply: FastifyReply,
    call: (client: GitopsClient) => Promise<UpstreamResult>,
    failureLog: string,
    adminOnly: boolean,
  ) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) {
      return reply.code(503).send({ error: 'gitops not configured' });
    }
    const email = await emailFromRequest(req, app.log);
    if (!email) {
      return reply.code(401).send({ error: 'not authenticated' });
    }
    if (adminOnly) {
      const role = await fwRoleFromRequest(req, gitops, app.log);
      if (role !== 'admin') {
        return reply.code(403).send({ error: 'admin only' });
      }
    }
    try {
      const r = await call(gitops);
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return r.body;
    } catch (err) {
      app.log.warn({ err }, failureLog);
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  };

  const asAdmin = (
    req: FastifyRequest,
    reply: FastifyReply,
    call: (client: GitopsClient) => Promise<UpstreamResult>,
    failureLog: string,
  ) => forward(req, reply, call, failureLog, true);

  app.get('/api/workspace/git-remote', async (req, reply) =>
    asAdmin(req, reply, (client) => client.gitRemote(), 'workspace git remote read failed'),
  );

  app.put<{ Body: { url?: unknown } }>('/api/workspace/git-remote', async (req, reply) => {
    const url = req.body?.url;
    if (typeof url !== 'string' || !url.trim()) {
      reply.header('Cache-Control', 'no-store');
      return reply.code(400).send({ error: 'url is required' });
    }
    return asAdmin(
      req,
      reply,
      (client) => client.gitRemoteSet(url.trim()),
      'workspace git remote update failed',
    );
  });

  app.delete('/api/workspace/git-remote', async (req, reply) =>
    asAdmin(req, reply, (client) => client.gitRemoteClear(), 'workspace git remote clear failed'),
  );

  app.post('/api/workspace/git-remote/push', async (req, reply) =>
    asAdmin(req, reply, (client) => client.gitRemotePush(), 'workspace git remote push failed'),
  );

  app.post('/api/workspace/git-remote/pull', async (req, reply) =>
    forward(
      req,
      reply,
      (client) => client.gitRemotePull(),
      'workspace git remote pull failed',
      false,
    ),
  );

  app.post('/api/workspace/git-remote/force-push', async (req, reply) =>
    asAdmin(
      req,
      reply,
      (client) => client.gitRemoteForcePush(),
      'workspace git remote force push failed',
    ),
  );

  app.post('/api/workspace/git-remote/pause', async (req, reply) =>
    asAdmin(req, reply, (client) => client.gitRemotePause(), 'workspace git remote pause failed'),
  );

  app.post('/api/workspace/git-remote/resume', async (req, reply) =>
    asAdmin(req, reply, (client) => client.gitRemoteResume(), 'workspace git remote resume failed'),
  );

  app.post('/api/workspace/git-remote/rotate-key', async (req, reply) =>
    asAdmin(
      req,
      reply,
      (client) => client.gitRemoteRotateKey(),
      'workspace git remote key rotation failed',
    ),
  );
}

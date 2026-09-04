import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { emailFromRequest, fwRoleFromRequest } from '../lib/user.js';
import { isValidBpId } from '../services/workspace.js';
import type { GitopsClient } from '../services/gitops.js';
import {
  ASSET_BASE_PLACEHOLDER,
  extensionPath,
  openSidebar,
  pageFor,
  sidebarEnabled,
  type SidebarOpen,
} from '../services/vscode-sidebar.js';

export interface AuditRoutesOptions {
  gitops: GitopsClient | null;
  /** Where the audit environments are mounted in this container. */
  auditsRoot?: string;
}

const ASSET_PREFIX = '/api/coding-agent/sidebar/asset';

/** The audited image's content hash, or undefined when staging is not frozen. */
function frozenSha(env: unknown): string | undefined {
  const sha = (env as { sha?: unknown } | null)?.sha;
  return typeof sha === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(sha) ? sha : undefined;
}

const AUDIT_ROLES = new Set(['admin', 'auditor']);

export function registerAuditRoutes(
  app: FastifyInstance,
  { gitops, auditsRoot = '/workspace/audits' }: AuditRoutesOptions,
): void {
  // The auditor's chat is the same hosted Claude Code panel the Coding Agent
  // tab uses, opened on the audit environment instead of a copy: the agent
  // reads source/ and production.diff and writes report.md, which is the file
  // this tab shows as the report. Keyed per (auditor, business process, image),
  // so two audits and a member's own chat never share an extension host.
  const pendingOpens = new Map<string, SidebarOpen>();

  const auditFolder = async (
    bp: string,
  ): Promise<{ folder: string; sha: string } | undefined> => {
    if (!gitops) return undefined;
    const env = await gitops.auditEnv(bp, '');
    const sha = env.ok ? frozenSha(env.body) : undefined;
    if (!sha) return undefined;
    return { folder: path.join(auditsRoot, bp, sha), sha };
  };
  const upstream = async (
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    run: () => Promise<{ ok: boolean; status: number; body: unknown }>,
    what: string,
  ) => {
    try {
      const r = await run();
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return r.body;
    } catch (err) {
      app.log.warn({ err }, `${what} failed`);
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  };

  const guard = (bp: string, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (!gitops) {
      reply.code(503).send({ error: 'gitops not configured' });
      return false;
    }
    if (!isValidBpId(bp)) {
      reply.code(400).send({ error: 'invalid business process' });
      return false;
    }
    return true;
  };

  // The audit environment: which two versions are being compared, whether the
  // audited source is materialized, and the temporary agent's state.
  app.get<{ Params: { bp: string } }>('/api/audits/:bp/env', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!guard(req.params.bp, reply)) return;
    return upstream(reply, () => gitops!.auditEnv(req.params.bp, ''), 'audit env read');
  });

  app.get<{ Params: { bp: string } }>('/api/audits/:bp/files', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!guard(req.params.bp, reply)) return;
    return upstream(reply, () => gitops!.auditEnv(req.params.bp, '/files'), 'audit tree read');
  });

  app.get<{ Params: { bp: string }; Querystring: { path?: string } }>(
    '/api/audits/:bp/file-content',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!guard(req.params.bp, reply)) return;
      const path = (req.query.path ?? '').trim();
      if (!path) return reply.code(400).send({ error: 'path is required' });
      return upstream(
        reply,
        () => gitops!.auditEnv(req.params.bp, '/file-content', { query: { path } }),
        'audit file read',
      );
    },
  );

  app.get<{ Params: { bp: string }; Querystring: { q?: string } }>(
    '/api/audits/:bp/search',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!guard(req.params.bp, reply)) return;
      const q = (req.query.q ?? '').trim();
      if (!q) return { matches: [], truncated: false };
      return upstream(
        reply,
        () => gitops!.auditEnv(req.params.bp, '/search', { query: { q } }),
        'audit search',
      );
    },
  );

  app.get<{ Params: { bp: string } }>('/api/audits/:bp/diff', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!guard(req.params.bp, reply)) return;
    return upstream(reply, () => gitops!.auditEnv(req.params.bp, '/diff'), 'audit diff read');
  });

  app.get<{ Params: { bp: string } }>('/api/audits/:bp/report', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!guard(req.params.bp, reply)) return;
    return upstream(reply, () => gitops!.auditEnv(req.params.bp, '/report'), 'audit report read');
  });

  // Writing the report and running the agent are compliance controls: resolve
  // the role from the verified identity and refuse everyone else, exactly as
  // freezing staging and signing off do.
  const auditorOnly = async (
    req: Parameters<typeof emailFromRequest>[0],
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    what: string,
  ): Promise<string | undefined> => {
    const role = await fwRoleFromRequest(req, gitops!, app.log);
    const email = await emailFromRequest(req, app.log);
    if (!AUDIT_ROLES.has(role ?? '') || !email) {
      reply.code(403).send({ error: `${what} requires an admin or auditor role.` });
      return undefined;
    }
    return email;
  };

  app.put<{ Params: { bp: string }; Body: { content?: string } }>(
    '/api/audits/:bp/report',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!guard(req.params.bp, reply)) return;
      const content = req.body?.content;
      if (typeof content !== 'string') {
        return reply.code(400).send({ error: 'content (string) is required' });
      }
      const by = await auditorOnly(req, reply, 'Writing the audit report');
      if (by === undefined) return;
      return upstream(
        reply,
        () => gitops!.auditEnv(req.params.bp, '/report', { method: 'PUT', body: { content, by } }),
        'audit report write',
      );
    },
  );

  // The chat panel itself: one page per (auditor, image), and the websocket
  // that carries it. Read-only for a member — an audit conversation is part of
  // the evidence, so only the people who can sign off can hold one.
  app.get<{ Params: { bp: string } }>('/api/audits/:bp/chat/view', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!guard(req.params.bp, reply)) return;
    if (!sidebarEnabled()) return reply.code(503).send({ error: 'sidebar not available' });
    const by = await auditorOnly(req, reply, 'The audit chat');
    if (by === undefined) return;
    const env = await auditFolder(req.params.bp);
    if (!env) {
      return reply.code(409).send({ error: 'staging is not frozen, so there is no audit' });
    }
    try {
      const opened = await openSidebar({ email: by, workspaceFolder: env.folder });
      pendingOpens.set(`${by} ${req.params.bp} ${env.sha}`, opened);
      reply.header('Content-Type', 'text/html; charset=utf-8');
      return reply.send(
        pageFor(opened.html, {
          assetBase: ASSET_PREFIX,
          extensionDir: extensionPath()!,
          assetUris: opened.assetUris,
        }),
      );
    } catch (err) {
      app.log.warn({ err, bp: req.params.bp }, 'audit chat open failed');
      return reply.code(500).send({ error: String(err) });
    }
  });

  app.get<{ Querystring: { bp?: string } }>(
    '/ws/audit-agent-chat',
    { websocket: true },
    async (socket, req) => {
      const bp = (req.query.bp ?? '').trim();
      const role = gitops ? await fwRoleFromRequest(req, gitops, app.log) : null;
      const email = await emailFromRequest(req, app.log);
      const env = isValidBpId(bp) ? await auditFolder(bp) : undefined;
      if (!env || !email || !AUDIT_ROLES.has(role ?? '') || !sidebarEnabled()) {
        socket.close(1008, 'unavailable');
        return;
      }
      const key = `${email} ${bp} ${env.sha}`;
      let opened = pendingOpens.get(key);
      if (!opened) {
        try {
          opened = await openSidebar({ email, workspaceFolder: env.folder });
          pendingOpens.set(key, opened);
        } catch (err) {
          app.log.warn({ err, bp }, 'audit chat bridge open failed');
          socket.close(1011, 'open failed');
          return;
        }
      }
      const attached = opened;
      const assetBase = `${req.protocol}://${req.headers.host}${ASSET_PREFIX}`;
      const off = attached.onToWebview((message) => {
        if (socket.readyState !== 1) return;
        socket.send(JSON.stringify(message).split(ASSET_BASE_PLACEHOLDER).join(assetBase));
      });
      socket.on('message', (raw: Buffer | string) => {
        try {
          attached.sendToExtension(JSON.parse(String(raw)));
        } catch {
          // a frame that is not JSON is not ours
        }
      });
      socket.on('close', () => {
        off();
        attached.close();
        if (pendingOpens.get(key) === attached) pendingOpens.delete(key);
      });
    },
  );

  app.post<{ Params: { bp: string }; Body: { prompt?: string } }>(
    '/api/audits/:bp/draft',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!guard(req.params.bp, reply)) return;
      const by = await auditorOnly(req, reply, 'Running the audit agent');
      if (by === undefined) return;
      return upstream(
        reply,
        () =>
          gitops!.auditEnv(req.params.bp, '/draft', {
            method: 'POST',
            body: { prompt: req.body?.prompt ?? '', by },
          }),
        'audit draft',
      );
    },
  );
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import WebSocket, { type RawData } from 'ws';
import { emailFromRequest } from '../lib/user.js';
import { isSessionKind, promptForKind } from '../services/agent-prompts.js';
import { activeSessions, createSession, latestSession, promptSession } from '../services/opencode-api.js';
import {
  OPENCODE_WS_ROUTES,
  bpDirectory,
  classifyOpenCodePath,
  directoryParamsAllowed,
  isCrossSiteMutation,
  outboundHeaders,
} from '../services/opencode-paths.js';
import {
  closeAllServers,
  ensureServer,
  forgetServer,
  idleConnections,
  stopServer,
  touchServer,
  type OpenCodeConnection,
} from '../services/opencode-server.js';
import { readPreferences } from '../services/user-preferences.js';
import { isValidBpId, isValidCopyName } from '../services/workspace.js';

/**
 * OpenCode in the Coding Agent tab (#270).
 *
 * The panel is an iframe on the dashboard's own origin showing the OpenCode
 * web UI, and this module is what makes that origin answer for OpenCode: every
 * request OpenCode's UI makes — its pages, its assets, its `/api/*` calls, its
 * terminal WebSocket — is forwarded to the caller's own OpenCode server in the
 * coding-agent container, over a per-user ssh port-forward, with the server's
 * Basic credentials added on the way. See services/opencode-paths.ts for what
 * counts as OpenCode's and docs/opencode-integration.md for the whole picture.
 *
 * Three rules hold for every forwarded request:
 *  - the caller is the gate-verified user, and only their server is reached;
 *  - the caller has chosen OpenCode (a Claude Code user gets a plain 404);
 *  - directories stay inside the copies tree.
 */

const PREFIX = '/api/coding-agent/opencode';
const MAX_PROMPT_CHARS = 8 * 1024;
const REAP_INTERVAL_MS = 5 * 60_000;

function idleTimeoutMs(): number {
  const raw = process.env.OPENCODE_IDLE_TIMEOUT_MS;
  if (raw === undefined) return 30 * 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30 * 60_000;
}

// eslint-disable-next-line no-restricted-syntax -- undefined = invalid scope
function scope(q: { copy?: string; bp?: string }): { copy: string; bp: string } | undefined {
  const copy = (q.copy ?? '').trim();
  const bp = (q.bp ?? '').trim();
  if (!copy || !bp || !isValidCopyName(copy) || !isValidBpId(bp)) return undefined;
  return { copy, bp };
}

type Gate =
  | { ok: true; email: string }
  | { ok: false; status: number; error: string };

/** The checks every OpenCode request passes before anything is forwarded. */
async function gate(app: FastifyInstance, req: FastifyRequest): Promise<Gate> {
  const email = await emailFromRequest(req, app.log);
  if (!email) return { ok: false, status: 401, error: 'not authenticated' };
  const prefs = await readPreferences(email);
  if (prefs.codingAgent !== 'opencode') return { ok: false, status: 404, error: 'not found' };
  const secFetchSite = req.headers['sec-fetch-site'];
  if (isCrossSiteMutation(req.method, Array.isArray(secFetchSite) ? secFetchSite[0] : secFetchSite)) {
    return { ok: false, status: 403, error: 'cross-site request refused' };
  }
  if (!directoryParamsAllowed(req.url)) {
    return { ok: false, status: 400, error: 'directory outside the copies tree' };
  }
  return { ok: true, email };
}

function proxyTo(
  req: FastifyRequest,
  reply: FastifyReply,
  conn: OpenCodeConnection,
): FastifyReply {
  const email = conn.email;
  return reply.from(`${conn.baseUrl}${req.url}`, {
    rewriteRequestHeaders: (_original, headers) =>
      outboundHeaders(headers, { host: `127.0.0.1:${conn.localPort}`, authorization: conn.authorization }),
    rewriteHeaders: (headers) => {
      const type = headers['content-type'];
      const isHtml = typeof type === 'string' && type.startsWith('text/html');
      // OpenCode's index.html carries no cache policy; heuristic caching would
      // pin a browser to an old bundle across an upgrade (the dashboard's own
      // SPA fallback has the same rule).
      return isHtml ? { ...headers, 'cache-control': 'no-cache' } : headers;
    },
    onError: (errReply, { error }) => {
      // Nobody answered through the tunnel: the server or the ssh forward is
      // gone. Forget it so the next request rebuilds the path.
      forgetServer(email);
      errReply.code(502).send({ error: `OpenCode is not answering: ${error.message}` });
    },
  });
}

async function forwardApi(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const g = await gate(app, req);
  if (!g.ok) return reply.code(g.status).send({ error: g.error });
  const ensured = await ensureServer(g.email);
  if (ensured.state !== 'ready') return reply.code(503).send({ error: ensured.reason, state: ensured.state });
  touchServer(g.email);
  return proxyTo(req, reply, ensured.conn);
}

/**
 * The OpenCode UI's own pages and static files, for the SPA fallback in
 * server.ts. Returns false when the request is not OpenCode's, or the caller
 * has not chosen OpenCode, so the dashboard's own 404/SPA handling runs.
 */
export async function forwardShell(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const pathname = new URL(req.url, 'http://dashboard').pathname;
  if (pathname === '/' || pathname.startsWith('/ws/') || pathname.startsWith('/api/')) return false;
  const kind = classifyOpenCodePath(pathname).kind;
  if (kind !== 'document' && kind !== 'asset') return false;

  const email = await emailFromRequest(req, app.log);
  if (!email) return false;
  const prefs = await readPreferences(email);
  if (prefs.codingAgent !== 'opencode') return false;
  if (!directoryParamsAllowed(req.url)) {
    await reply.code(400).send({ error: 'directory outside the copies tree' });
    return true;
  }
  const ensured = await ensureServer(email);
  if (ensured.state !== 'ready') {
    await reply.code(503).send({ error: ensured.reason, state: ensured.state });
    return true;
  }
  touchServer(email);
  await proxyTo(req, reply, ensured.conn);
  return true;
}

/** WebSocket close codes a peer may pass on; anything else becomes a normal close. */
function relayCloseCode(code: number): number {
  if (code === 1000 || (code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1011) || (code >= 3000 && code <= 4999)) {
    return code;
  }
  return 1000;
}

function bridgeWebSocket(app: FastifyInstance, socket: WebSocket, req: FastifyRequest): void {
  void (async () => {
    const g = await gate(app, req);
    if (!g.ok) {
      socket.close(g.status === 401 ? 1008 : 1008, g.error);
      return;
    }
    const ensured = await ensureServer(g.email);
    if (ensured.state !== 'ready') {
      socket.close(1011, ensured.reason.slice(0, 120));
      return;
    }
    const conn = ensured.conn;
    touchServer(g.email);

    const upstream = new WebSocket(`ws://127.0.0.1:${conn.localPort}${req.url}`, {
      headers: { authorization: conn.authorization },
    });
    const queued: Array<{ data: RawData; isBinary: boolean }> = [];
    let done = false;
    const finish = (code: number, reason: string) => {
      if (done) return;
      done = true;
      const c = relayCloseCode(code);
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(c, reason.slice(0, 120));
      }
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close(c, reason.slice(0, 120));
      }
    };

    upstream.on('open', () => {
      for (const m of queued.splice(0)) upstream.send(m.data, { binary: m.isBinary });
    });
    upstream.on('message', (data: RawData, isBinary: boolean) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data, { binary: isBinary });
    });
    upstream.on('close', (code: number, reason: Buffer) => finish(code, reason.toString()));
    upstream.on('error', (err: Error) => {
      forgetServer(g.email);
      finish(1011, err.message);
    });

    socket.on('message', (data: RawData, isBinary: boolean) => {
      touchServer(g.email);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      else queued.push({ data, isBinary });
    });
    socket.on('close', (code: number, reason: Buffer) => finish(code, reason.toString()));
    socket.on('error', () => finish(1011, 'client error'));
  })().catch((err: unknown) => {
    app.log.warn({ err }, 'opencode websocket bridge failed');
    try {
      socket.close(1011, 'bridge failed');
    } catch {
      // already closed
    }
  });
}

async function reapIdle(app: FastifyInstance): Promise<void> {
  const idleMs = idleTimeoutMs();
  if (idleMs <= 0) return;
  for (const conn of idleConnections(Date.now(), idleMs)) {
    try {
      // A run that outlived its browser tab is still a run: only stop servers
      // with no agent loop in flight.
      if ((await activeSessions(conn)).length > 0) continue;
      await stopServer(conn.email);
      app.log.info({ email: conn.email }, 'idle opencode server stopped');
    } catch (err) {
      app.log.warn({ err, email: conn.email }, 'could not reap idle opencode server');
    }
  }
}

/**
 * Stop OpenCode servers nobody has used for a while, the way idle Claude
 * extension hosts are evicted. Each server is a process of a few hundred MB
 * in the coding-agent container, so an abandoned tab must not hold one forever.
 */
export function startOpenCodeReaper(app: FastifyInstance): void {
  const timer = setInterval(() => void reapIdle(app), REAP_INTERVAL_MS);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    closeAllServers();
  });
}

/** The status, hand-off and forwarding routes. See the module comment. */
export async function registerOpenCodeRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Whether the caller's OpenCode server is up, and which conversation the
   * panel should open for this BP: its most recent one, or a new one created
   * here. OpenCode's UI addresses a conversation by session id only (the
   * session carries its directory), so a BP with no conversation yet gets an
   * empty one to land on rather than OpenCode's home — which on this origin
   * is the dashboard.
   */
  app.get<{ Querystring: { copy?: string; bp?: string } }>(`${PREFIX}/status`, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const s = scope(req.query);
    if (!s) return reply.code(400).send({ error: 'copy and bp are required' });
    const email = await emailFromRequest(req, app.log);
    if (!email) return reply.code(401).send({ error: 'not authenticated' });

    const ensured = await ensureServer(email);
    if (ensured.state !== 'ready') return { state: ensured.state, reason: ensured.reason };
    touchServer(email);
    const directory = bpDirectory(s.copy, s.bp);
    try {
      const session = (await latestSession(ensured.conn, directory)) ?? (await createSession(ensured.conn, directory));
      return { state: 'ready', sessionId: session.id, version: ensured.conn.info.version };
    } catch (err) {
      app.log.warn({ err, ...s }, 'could not find or create an opencode session');
      return {
        state: 'error',
        reason: `OpenCode could not open a conversation: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  /**
   * Hand OpenCode a task from another tab — Sync, Build automation, Write
   * tests, Merge back, or an ask the caller wrote. OpenCode's API cannot
   * prefill its composer the way the Claude Code extension can, so the task is
   * sent: a new conversation is created for the BP and the prompt is its first
   * message. The response names the session the panel should show.
   */
  app.post<{ Body: { copy?: string; bp?: string; kind?: string; parent?: string; text?: string } }>(
    `${PREFIX}/prompt`,
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const body = req.body ?? {};
      const s = scope(body);
      if (!s) return reply.code(400).send({ error: 'copy and bp are required' });
      // eslint-disable-next-line no-restricted-syntax -- undefined = not resolved yet
      let text: string | undefined;
      let title = 'Task from the dashboard';
      if (typeof body.text === 'string') {
        text = body.text.trim().slice(0, MAX_PROMPT_CHARS);
        if (!text) return reply.code(400).send({ error: 'text is empty' });
      } else {
        if (!isSessionKind(body.kind)) return reply.code(400).send({ error: 'unknown kind' });
        const parent = body.parent?.trim();
        if (parent !== undefined && parent !== '' && !isValidCopyName(parent)) {
          return reply.code(400).send({ error: 'invalid parent' });
        }
        text = promptForKind(body.kind, parent || undefined);
        if (!text) return reply.code(400).send({ error: `kind ${body.kind} has no canned prompt` });
        title = TASK_TITLES[body.kind] ?? title;
      }
      const email = await emailFromRequest(req, app.log);
      if (!email) return reply.code(401).send({ error: 'not authenticated' });

      const ensured = await ensureServer(email);
      if (ensured.state !== 'ready') return reply.code(503).send({ error: ensured.reason, state: ensured.state });
      touchServer(email);
      const directory = bpDirectory(s.copy, s.bp);
      try {
        const session = await createSession(ensured.conn, directory, title);
        await promptSession(ensured.conn, directory, session.id, text);
        return { sessionId: session.id };
      } catch (err) {
        app.log.warn({ err, ...s, kind: body.kind }, 'opencode prompt hand-off failed');
        return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // Everything OpenCode's UI asks its server for, forwarded raw. Encapsulated
  // so the body parsers can go: the parent's JSON parser would buffer and
  // size-limit (1 MiB) a prompt carrying an image, reject content types it does
  // not know with 415, and leave multipart bodies to a plugin that only flags
  // them — whereas a stream body is piped to the upstream untouched.
  await app.register(async (child) => {
    child.removeAllContentTypeParsers();
    child.addContentTypeParser('*', (_req, payload, done) => {
      done(null, payload);
    });
    child.all('/api/*', (req, reply) => forwardApi(app, req, reply));
    for (const route of OPENCODE_WS_ROUTES) {
      child.get(route, { websocket: true }, (socket, req) => bridgeWebSocket(app, socket, req));
    }
  });

  startOpenCodeReaper(app);
}

const TASK_TITLES: Record<string, string> = {
  sync: 'Sync with main',
  'merge-parent': 'Merge the experiment back',
  'write-tests': 'Write tests for the requirements',
  automation: 'Build the automation',
};

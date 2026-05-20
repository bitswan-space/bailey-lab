import path from 'node:path';
import { promises as dns } from 'node:dns';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { spawnPty } from '../services/pty.js';
import { handleTerminalConnection } from '../services/terminal-session.js';
import type { GitopsClient } from '../services/gitops.js';
import { isValidBpId, isValidWorktreeName } from '../services/workspace.js';
import { castStream, listSessions } from '../services/agent-sessions.js';
import { DEFAULT_PROMPT, SYNC_PROMPT } from '../services/agent-prompts.js';
import { listRequirements, type Requirement } from '../services/requirements.js';

export interface CodingAgentRoutesOptions {
  gitops: GitopsClient | null;
}

/**
 * Per-requirement focused prompt. The user has clicked "Run agent on this
 * requirement" in the dashboard, so we point Claude at a single id and
 * instruct it on the canonical lifecycle. Apostrophes in the user-typed
 * description are escaped centrally in `buildAutoCmd` — write this prompt
 * naturally.
 */
function buildRequirementPrompt(req: Requirement): string {
  return (
    `Work on requirement ${req.id}: ${req.description}. ` +
    `Read the BP's README.md, process.toml, and any existing source first. ` +
    `Use \`bitswan-coding-agent requirements list\` to see the full tree and ` +
    `\`bitswan-coding-agent requirements next\` to confirm ordering. ` +
    `When the requirement passes, run \`bitswan-coding-agent requirements update --id ${req.id} --status pass\`. ` +
    `If it doesn't pass, set status to fail or retest as appropriate.`
  );
}

/**
 * Make a string safe to embed inside a bash single-quoted region. Inside
 * `'…'` everything is literal except the closing quote itself, so the
 * standard trick is to end the quoted region, insert an escaped quote,
 * and reopen the quoted region: `'\''`.
 */
function bashSingleQuoteEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

const SSH_KEY = '/workspace/.ssh/id_ed25519';

function agentHost(): string {
  // Allow an explicit override for setups whose coding-agent container
  // doesn't follow the `${ws}-coding-agent` convention (e.g. when launched
  // by a different docker-compose project name).
  const override = process.env.CODING_AGENT_HOST;
  if (override) return override;
  const ws = process.env.BITSWAN_WORKSPACE_NAME ?? 'default';
  return `${ws}-coding-agent`;
}

function emailFromRequest(req: FastifyRequest): string {
  // oauth2-proxy fronts the dashboard and sets this header on every
  // upstream request; outside that boundary there's no authenticated user.
  const raw = req.headers['x-auth-request-email'];
  if (typeof raw === 'string' && raw) return raw;
  if (Array.isArray(raw) && raw[0]) return raw[0];
  return 'unknown';
}

type SessionKind = 'claude' | 'sync' | 'requirement';

/**
 * Default name passed to Claude via `-n`. Shown in Claude's `/resume`
 * picker and in its own UI/terminal title; survives session resumption.
 * Users can rename via Claude's `/rename` at any time. We don't bake the
 * timestamp into the name because it represents the *conversation*, not a
 * specific ssh attempt — multiple resumes of the same conversation share
 * the same name.
 */
function defaultSessionName(opts: {
  kind: SessionKind;
  worktree: string;
  bp?: string;
  requirement?: Requirement;
}): string {
  switch (opts.kind) {
    case 'sync':
      return `Sync · ${opts.worktree}`;
    case 'requirement': {
      const id = opts.requirement?.id ?? 'requirement';
      return opts.bp
        ? `Req ${id} · ${opts.worktree}/${opts.bp}`
        : `Req ${id} · ${opts.worktree}`;
    }
    default:
      return opts.bp
        ? `Claude · ${opts.worktree}/${opts.bp}`
        : `Claude · ${opts.worktree}`;
  }
}

function buildAutoCmd(opts: {
  worktree: string;
  bp?: string;
  sessionId: string;
  resume: boolean;
  kind: SessionKind;
  /** Requirement to focus the agent on. Required when kind === 'requirement'. */
  requirement?: Requirement;
}): string {
  // Sync sessions cd to the worktree root (no BP); regular claude and
  // requirement sessions cd into the BP directory.
  const cd =
    opts.kind === 'sync'
      ? `/workspace/worktrees/${opts.worktree}`
      : `/workspace/worktrees/${opts.worktree}/${opts.bp}`;
  let prompt: string;
  if (opts.kind === 'sync') prompt = SYNC_PROMPT;
  else if (opts.kind === 'requirement' && opts.requirement) {
    prompt = buildRequirementPrompt(opts.requirement);
  } else prompt = DEFAULT_PROMPT;
  // Either continue a previous chat (--resume <uuid>) or start a fresh one
  // with a caller-provided UUID (--session-id <uuid>) so the dashboard can
  // resume it later. The prompt is embedded inside single quotes; any
  // apostrophes in the requirement description (or in the canned prompt
  // templates) would otherwise terminate the quoted region.
  const safePrompt = bashSingleQuoteEscape(prompt);
  // Pass a default display name on the *first* run of a conversation —
  // `--resume` reattaches an existing conversation that already has a name
  // (either the one we set on first run or whatever the user has changed
  // it to via Claude's /rename). The name surfaces in Claude's /resume
  // picker so the user has something better than "You are a BitSwan coding
  // agent…" when picking sessions from inside Claude.
  const safeName = bashSingleQuoteEscape(
    defaultSessionName({
      kind: opts.kind,
      worktree: opts.worktree,
      ...(opts.bp ? { bp: opts.bp } : {}),
      ...(opts.requirement ? { requirement: opts.requirement } : {}),
    }),
  );
  const claudeArgs = opts.resume
    ? `--dangerously-skip-permissions --resume ${opts.sessionId}`
    : `--dangerously-skip-permissions --session-id ${opts.sessionId} -n '${safeName}' '${safePrompt}'`;
  // Inline the Claude settings stub so the agent doesn't re-prompt on every
  // session for dangerous-mode confirmation. Same shape the editor uses.
  return (
    `cd ${cd} && ` +
    `mkdir -p ~/.claude && ` +
    `echo '{"skipDangerousModePermissionPrompt":true}' > ~/.claude/settings.json && ` +
    `exec claude ${claudeArgs}`
  );
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Default 30 min of double-silence (no PTY output AND no client input).
 * Override via `CODING_AGENT_IDLE_TIMEOUT_MS=<number>`; `0` disables.
 */
function idleTimeoutMs(): number {
  const raw = process.env.CODING_AGENT_IDLE_TIMEOUT_MS;
  if (raw === undefined) return 30 * 60 * 1000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30 * 60 * 1000;
}

/**
 * Wait until DNS resolves the agent hostname. The container takes a moment
 * to register with docker's embedded DNS after `coding-agent/ensure` returns
 * — without this poll, the first session attempt after a cold start fails
 * with "Could not resolve hostname".
 */
async function waitForAgentDns(host: string, attempts = 15, delayMs = 1000): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      await dns.lookup(host);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
}

/**
 * WebSocket + REST surface for the dashboard's Agents tab.
 *
 *   - `/ws/coding-agent?worktree=…&bp=…` opens an SSH session to the
 *     `${WS}-coding-agent` container, scoped to a (worktree, bp) pair, and
 *     always runs Claude. The wrapper inside the agent container handles
 *     cd + asciinema + the launched command.
 *   - `/api/coding-agent/sessions` lists past sessions for one (worktree, bp).
 *   - `/api/coding-agent/sessions/:cast/content` streams a .cast file for
 *     asciinema playback.
 */
export function registerCodingAgentRoutes(
  app: FastifyInstance,
  { gitops }: CodingAgentRoutesOptions,
): void {
  app.get<{
    Querystring: {
      worktree?: string;
      bp?: string;
      session_id?: string;
      resume?: string;
      kind?: string;
      requirement_id?: string;
    };
  }>('/ws/coding-agent', { websocket: true }, async (socket, req) => {
    const { worktree, bp, session_id, resume, kind: kindRaw, requirement_id } = req.query;
    if (!worktree || !isValidWorktreeName(worktree)) {
      socket.send(JSON.stringify({ type: 'error', message: 'invalid worktree' }));
      socket.close(1008, 'invalid worktree');
      return;
    }
    const kind: SessionKind =
      kindRaw === 'sync' ? 'sync' : kindRaw === 'requirement' ? 'requirement' : 'claude';
    // `bp` is required for regular claude sessions and requirement sessions;
    // optional (and ignored) for worktree-level sync sessions.
    if (kind !== 'sync') {
      if (!bp || !isValidBpId(bp)) {
        socket.send(JSON.stringify({ type: 'error', message: 'invalid bp' }));
        socket.close(1008, 'invalid bp');
        return;
      }
    }
    // For requirement sessions, look up the description in the TOML so we
    // can embed it in the prompt. Refuse to spawn if the id isn't there —
    // running a session against a stale id would just confuse Claude.
    let requirement: Requirement | undefined;
    if (kind === 'requirement') {
      if (!requirement_id) {
        socket.send(
          JSON.stringify({ type: 'error', message: 'requirement_id is required' }),
        );
        socket.close(1008, 'missing requirement_id');
        return;
      }
      try {
        const reqs = await listRequirements({
          workspaceRoot: process.env.WORKSPACE_ROOT ?? '/workspace/workspace',
          worktree,
          bp: bp!,
        });
        requirement = reqs.find((r) => r.id === requirement_id);
      } catch (err) {
        socket.send(
          JSON.stringify({
            type: 'error',
            message: `failed to load requirement: ${err instanceof Error ? err.message : String(err)}`,
          }),
        );
        socket.close(1011, 'requirement load failed');
        return;
      }
      if (!requirement) {
        socket.send(
          JSON.stringify({ type: 'error', message: `requirement ${requirement_id} not found` }),
        );
        socket.close(1008, 'unknown requirement');
        return;
      }
    }
    // Exactly one of session_id or resume is required and both must be UUIDs.
    // Resume wins when both are present, but mixing is a client bug — flag it.
    const resumeId = resume ?? undefined;
    const newId = session_id ?? undefined;
    if (resumeId && newId) {
      socket.send(
        JSON.stringify({ type: 'error', message: 'pass either session_id or resume, not both' }),
      );
      socket.close(1008, 'mixed ids');
      return;
    }
    const claudeSessionId = resumeId ?? newId;
    if (!isValidUuid(claudeSessionId)) {
      socket.send(JSON.stringify({ type: 'error', message: 'invalid session id' }));
      socket.close(1008, 'invalid session id');
      return;
    }
    const isResume = Boolean(resumeId);

    const email = emailFromRequest(req);
    const autoCmd = buildAutoCmd({
      worktree,
      ...(kind !== 'sync' && bp ? { bp } : {}),
      sessionId: claudeSessionId,
      resume: isResume,
      kind,
      ...(requirement ? { requirement } : {}),
    });
    const host = agentHost();

    // React 18 strict mode (dev only) opens this WS, calls close() on
    // cleanup, then re-opens a fresh one. The cleanup happens *before* the
    // first WebSocket reaches `open` in the browser, so it never sends any
    // application-level messages. Waiting for the client's first message
    // is a reliable "this WS is real" signal that a wall-clock delay isn't.
    // Terminal.tsx fires a resize as soon as `open` fires, so the wait is
    // short for real connections.
    const FIRST_MESSAGE_TIMEOUT_MS = 5000;
    const firstFrame = await new Promise<{ ok: true; data: Buffer; isBinary: boolean } | { ok: false; reason: string }>(
      (resolve) => {
        const onMessage = (data: Buffer, isBinary: boolean) => {
          socket.off('close', onClose);
          clearTimeout(timer);
          resolve({ ok: true, data, isBinary });
        };
        const onClose = () => {
          socket.off('message', onMessage);
          clearTimeout(timer);
          resolve({ ok: false, reason: 'closed before first frame' });
        };
        const timer = setTimeout(() => {
          socket.off('message', onMessage);
          socket.off('close', onClose);
          resolve({ ok: false, reason: 'no client frame within timeout' });
        }, FIRST_MESSAGE_TIMEOUT_MS);
        socket.once('message', onMessage);
        socket.once('close', onClose);
      },
    );
    if (!firstFrame.ok) {
      // Either the strict-mode cleanup closed us, or the client just never
      // sent anything. Either way, don't spawn.
      if (socket.readyState <= 1 /* CONNECTING / OPEN */) {
        try {
          socket.close(1000, firstFrame.reason);
        } catch {
          // already closed
        }
      }
      return;
    }
    let aborted = false;
    socket.once('close', () => {
      aborted = true;
    });

    // Make sure the agent container is up before we try to ssh into it.
    // Skipping when gitops isn't configured lets local dev (no upstream) still
    // attempt the ssh — useful for debugging an already-running agent.
    if (gitops) {
      try {
        socket.send(JSON.stringify({ type: 'info', message: 'Starting coding agent…' }));
        const r = await gitops.ensureCodingAgent();
        if (aborted) return;
        if (!r.ok) {
          socket.send(
            JSON.stringify({
              type: 'error',
              message: `Failed to start coding agent (gitops returned ${r.status})`,
            }),
          );
          socket.close(1011, 'ensure failed');
          return;
        }
        const ready = await waitForAgentDns(host);
        if (aborted) return;
        if (!ready) {
          socket.send(
            JSON.stringify({
              type: 'error',
              message: `Coding agent host ${host} did not become reachable`,
            }),
          );
          socket.close(1011, 'agent unreachable');
          return;
        }
      } catch (err) {
        if (aborted) return;
        socket.send(
          JSON.stringify({
            type: 'error',
            message: `gitops error: ${err instanceof Error ? err.message : String(err)}`,
          }),
        );
        socket.close(1011, 'ensure failed');
        return;
      }
    }
    if (aborted) return;

    const spawn = (cols: number, rows: number) =>
      spawnPty({
        shell: 'ssh',
        args: [
          '-tt',
          '-i',
          SSH_KEY,
          '-o',
          'StrictHostKeyChecking=no',
          '-o',
          'UserKnownHostsFile=/dev/null',
          '-o',
          'SendEnv=SSH_USER_EMAIL SSH_LOGGED SSH_WORKTREE SSH_BP SSH_CLAUDE_SESSION_ID SSH_SESSION_KIND SSH_AUTO_CMD',
          `agent@${host}`,
        ],
        cwd: undefined,
        cols,
        rows,
        extraEnv: {
          SSH_USER_EMAIL: email,
          SSH_LOGGED: 'true',
          SSH_WORKTREE: worktree,
          // SSH_BP is only set for BP-scoped sessions. Empty/missing tells
          // the wrapper to cd to the worktree root (which is what we want
          // for sync sessions).
          ...(kind !== 'sync' && bp ? { SSH_BP: bp } : {}),
          SSH_CLAUDE_SESSION_ID: claudeSessionId,
          SSH_SESSION_KIND: kind,
          SSH_AUTO_CMD: autoCmd,
        },
      });

    handleTerminalConnection(socket, spawn, {
      idleTimeoutMs: idleTimeoutMs(),
    });
    // The first frame we swallowed above (typically the resize sent on
    // Terminal.tsx's `open`) needs to reach the pty too — replay it now
    // that handleTerminalConnection has registered its own 'message'
    // listener.
    socket.emit('message', firstFrame.data, firstFrame.isBinary);
  });

  app.post('/api/coding-agent/ensure', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!gitops) {
      return reply.code(503).send({ error: 'gitops not configured' });
    }
    try {
      const r = await gitops.ensureCodingAgent();
      if (!r.ok) {
        return reply
          .code(r.status >= 400 && r.status < 500 ? r.status : 502)
          .send({ error: 'gitops error', status: r.status, body: r.body });
      }
      return r.body ?? { status: 'ok' };
    } catch (err) {
      app.log.warn({ err }, 'ensure coding-agent failed');
      return reply.code(502).send({ error: 'gitops unreachable' });
    }
  });

  app.get<{
    Querystring: { worktree?: string; bp?: string };
  }>('/api/coding-agent/sessions', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { worktree, bp } = req.query;
    if (!worktree || !isValidWorktreeName(worktree)) {
      return reply.code(400).send({ error: 'invalid worktree' });
    }
    if (!bp || !isValidBpId(bp)) {
      return reply.code(400).send({ error: 'invalid bp' });
    }
    try {
      const sessions = await listSessions({ worktree, bp });
      return sessions;
    } catch (err) {
      app.log.warn({ err, worktree, bp }, 'list sessions failed');
      return reply.code(500).send({ error: 'list failed' });
    }
  });

  app.get<{ Params: { cast: string } }>(
    '/api/coding-agent/sessions/:cast/content',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const cast = path.basename(req.params.cast);
      if (cast !== req.params.cast) {
        return reply.code(400).send({ error: 'invalid cast filename' });
      }
      try {
        const stream = castStream(cast);
        reply.header('Content-Type', 'application/octet-stream');
        return reply.send(stream);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'cast not found') {
          return reply.code(404).send({ error: msg });
        }
        return reply.code(400).send({ error: msg });
      }
    },
  );
}

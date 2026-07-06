import path from 'node:path';
import { promises as dns } from 'node:dns';
import type { FastifyInstance } from 'fastify';
import { spawnPty } from '../services/pty.js';
import { handleTerminalConnection } from '../services/terminal-session.js';
import type { GitopsClient } from '../services/gitops.js';
import { isValidBpId, isValidCopyName } from '../services/workspace.js';
import { castStream, findSessionOwnerEmail, listSessions } from '../services/agent-sessions.js';
import {
  BUILD_AUTOMATION_PROMPT,
  DEFAULT_PROMPT,
  SYNC_PROMPT,
  WRITE_TESTS_PROMPT,
} from '../services/agent-prompts.js';
import { listRequirements, type Requirement } from '../services/requirements.js';
import { emailFromRequest } from '../lib/user.js';

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

type SessionKind = 'claude' | 'sync' | 'requirement' | 'write-tests' | 'automation';

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
  copy: string;
  bp?: string;
  requirement?: Requirement;
}): string {
  switch (opts.kind) {
    case 'sync':
      return opts.bp
        ? `Sync · ${opts.copy}/${opts.bp}`
        : `Sync · ${opts.copy}`;
    case 'requirement': {
      const id = opts.requirement?.id ?? 'requirement';
      return opts.bp
        ? `Req ${id} · ${opts.copy}/${opts.bp}`
        : `Req ${id} · ${opts.copy}`;
    }
    case 'write-tests':
      return opts.bp
        ? `Write tests · ${opts.copy}/${opts.bp}`
        : `Write tests · ${opts.copy}`;
    case 'automation':
      return opts.bp
        ? `Build automation · ${opts.copy}/${opts.bp}`
        : `Build automation · ${opts.copy}`;
    default:
      return opts.bp
        ? `Claude · ${opts.copy}/${opts.bp}`
        : `Claude · ${opts.copy}`;
  }
}

function buildAutoCmd(opts: {
  copy: string;
  bp?: string;
  sessionId: string;
  resume: boolean;
  kind: SessionKind;
  /** Requirement to focus the agent on. Required when kind === 'requirement'. */
  requirement?: Requirement;
}): string {
  // Every session — sync included — works inside a BP's own clone: the copy
  // root is a plain directory (each BP under it is a separate git repo), so
  // there is nothing to run git against up there.
  const cd = `/workspace/copies/${opts.copy}/${opts.bp}`;
  let prompt: string;
  if (opts.kind === 'sync') prompt = SYNC_PROMPT;
  else if (opts.kind === 'requirement' && opts.requirement) {
    prompt = buildRequirementPrompt(opts.requirement);
  } else if (opts.kind === 'write-tests') prompt = WRITE_TESTS_PROMPT;
  else if (opts.kind === 'automation') prompt = BUILD_AUTOMATION_PROMPT;
  else prompt = DEFAULT_PROMPT;
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
      copy: opts.copy,
      ...(opts.bp ? { bp: opts.bp } : {}),
      ...(opts.requirement ? { requirement: opts.requirement } : {}),
    }),
  );
  const claudeArgs = opts.resume
    ? `--dangerously-skip-permissions --resume ${opts.sessionId}`
    : `--dangerously-skip-permissions --session-id ${opts.sessionId} -n '${safeName}' '${safePrompt}'`;
  // Inline the Claude settings stub so the agent doesn't re-prompt on every
  // session for dangerous-mode confirmation. Same shape the editor uses.
  //
  // Pre-trust the working directory and mark onboarding complete in
  // ~/.claude.json. Claude's "trust this folder" dialog is tracked PER
  // directory (in `projects[<cwd>].hasTrustDialogAccepted`) and is NOT
  // skipped by --dangerously-skip-permissions in an interactive (TTY)
  // session, so without this the agent hangs on the trust prompt the first
  // time it enters any copy/BP folder. Setting the global onboarding
  // flags too makes a freshly-provisioned coding-agent container start
  // straight into the session (no theme picker / welcome flow). JS uses only
  // double quotes so the whole node -e stays safely single-quoted for the
  // shell + SSH_AUTO_CMD transport.
  const trustCmd =
    `node -e 'const fs=require("fs"),os=require("os"),p=os.homedir()+"/.claude.json";` +
    `let d={};try{d=JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){}` +
    `Object.assign(d,{hasCompletedOnboarding:true,bypassPermissionsModeAccepted:true,hasTrustDialogAccepted:true});` +
    `if(!d.theme)d.theme="dark";` +
    `d.projects=d.projects||{};` +
    `d.projects[process.cwd()]=Object.assign({},d.projects[process.cwd()],{hasTrustDialogAccepted:true});` +
    `fs.writeFileSync(p,JSON.stringify(d))'`;
  return (
    `cd ${cd} && ` +
    `mkdir -p ~/.claude && ` +
    `echo '{"skipDangerousModePermissionPrompt":true}' > ~/.claude/settings.json && ` +
    `${trustCmd} && ` +
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
 * to register with docker's embedded DNS after it starts — without this poll,
 * the first session attempt after a cold start can fail with "Could not
 * resolve hostname".
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
 *   - `/ws/coding-agent?copy=…&bp=…` opens an SSH session to the
 *     `${WS}-coding-agent` container, scoped to a (copy, bp) pair, and
 *     always runs Claude. The wrapper inside the agent container handles
 *     cd + asciinema + the launched command.
 *   - `/api/coding-agent/sessions` lists past sessions for one (copy, bp).
 *   - `/api/coding-agent/sessions/:cast/content` streams a .cast file for
 *     asciinema playback.
 */
export function registerCodingAgentRoutes(
  app: FastifyInstance,
  { gitops }: CodingAgentRoutesOptions,
): void {
  app.get<{
    Querystring: {
      copy?: string;
      bp?: string;
      session_id?: string;
      resume?: string;
      kind?: string;
      requirement_id?: string;
    };
  }>('/ws/coding-agent', { websocket: true }, async (socket, req) => {
    const { copy, bp, session_id, resume, kind: kindRaw, requirement_id } = req.query;
    if (!copy || !isValidCopyName(copy)) {
      socket.send(JSON.stringify({ type: 'error', message: 'invalid copy' }));
      socket.close(1008, 'invalid copy');
      return;
    }
    const kind: SessionKind =
      kindRaw === 'sync' ||
      kindRaw === 'requirement' ||
      kindRaw === 'write-tests' ||
      kindRaw === 'automation'
        ? kindRaw
        : 'claude';
    // `bp` is required for every session kind — sync sessions are BP-scoped
    // too: each business process is its own repo, and the copy root isn't one.
    if (!bp || !isValidBpId(bp)) {
      socket.send(JSON.stringify({ type: 'error', message: 'invalid bp' }));
      socket.close(1008, 'invalid bp');
      return;
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
          copy,
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

    const email = await emailFromRequest(req, app.log);
    if (!email) {
      socket.send(JSON.stringify({ type: 'error', message: 'not authenticated' }));
      socket.close(1008, 'not authenticated');
      return;
    }

    const autoCmd = buildAutoCmd({
      copy,
      ...(bp ? { bp } : {}),
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

    // Block resuming another user's session. The session list returns every
    // session for the (copy, bp), so a malicious user could grab another
    // user's claude session UUID and pass it as `resume`. Without this gate
    // they'd attach to the still-running dtach socket
    // (/tmp/.claude-dtach-<UUID>.sock) and end up driving Claude under the
    // *original* user's CLAUDE_CONFIG_DIR — leaking that user's Anthropic
    // account. Sessions with no recorded owner (pre-isolation legacy) fall
    // through; new sessions always carry an email.
    //
    // This check runs *after* firstFrame so the disk lookup doesn't race the
    // client's first message — `socket.once('message', …)` inside the
    // firstFrame promise has to be attached before any awaits, or the
    // browser's open-time resize event arrives during the await with no
    // listener and is lost (the WS then times out after 5s with no spawn).
    if (isResume && resumeId) {
      const ownerEmail = await findSessionOwnerEmail(resumeId);
      if (
        ownerEmail &&
        ownerEmail !== 'unknown' &&
        ownerEmail !== email
      ) {
        socket.send(
          JSON.stringify({
            type: 'error',
            message: 'cannot resume a session started by another user',
          }),
        );
        socket.close(1008, 'forbidden resume');
        return;
      }
    }

    let aborted = false;
    socket.once('close', () => {
      aborted = true;
    });

    // The coding-agent container is provisioned by the automation-server
    // during workspace init. Poll DNS once so we don't race the brief gap
    // between container start and Docker's embedded DNS publishing the host.
    try {
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
          message: `agent DNS lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        }),
      );
      socket.close(1011, 'agent unreachable');
      return;
    }

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
          SSH_WORKTREE: copy,
          // Every session is BP-scoped (each BP is its own repo); the
          // wrapper cds into the BP clone and records the bp in the meta.
          ...(bp ? { SSH_BP: bp } : {}),
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

  app.get<{
    Querystring: { copy?: string; bp?: string };
  }>('/api/coding-agent/sessions', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { copy, bp } = req.query;
    if (!copy || !isValidCopyName(copy)) {
      return reply.code(400).send({ error: 'invalid copy' });
    }
    if (!bp || !isValidBpId(bp)) {
      return reply.code(400).send({ error: 'invalid bp' });
    }
    const userEmail = await emailFromRequest(req, app.log);
    if (!userEmail) {
      return reply.code(401).send({ error: 'not authenticated' });
    }
    try {
      const sessions = await listSessions({ copy, bp, userEmail });
      return sessions;
    } catch (err) {
      app.log.warn({ err, copy, bp }, 'list sessions failed');
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

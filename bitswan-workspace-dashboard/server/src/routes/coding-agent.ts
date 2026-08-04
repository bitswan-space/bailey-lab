import { promises as dns } from 'node:dns';
import type { FastifyInstance } from 'fastify';
import { spawnPty } from '../services/pty.js';
import { handleTerminalConnection } from '../services/terminal-session.js';
import type { GitopsClient } from '../services/gitops.js';
import { isValidBpId, isValidCopyName } from '../services/workspace.js';
import { findSessionMeta, latestSession } from '../services/agent-sessions.js';
import {
  BUILD_AUTOMATION_PROMPT,
  SYNC_PROMPT,
  WRITE_TESTS_PROMPT,
} from '../services/agent-prompts.js';
import { emailFromRequest } from '../lib/user.js';

export interface CodingAgentRoutesOptions {
  gitops: GitopsClient | null;
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

export interface AgentSshTarget {
  host: string;
  port: number;
}

export function agentSshTarget(): AgentSshTarget {
  // Allow an explicit override for setups where the coding-agent's sshd is
  // directly reachable (e.g. a dev compose without the isolated networks).
  const override = process.env.CODING_AGENT_HOST;
  if (override) {
    return { host: override, port: Number(process.env.CODING_AGENT_SSH_PORT ?? 22) };
  }
  // The agent sits on the isolated `<ws>-agent` bridge (shared only with
  // gitops) that this dashboard is deliberately NOT part of — the agent runs
  // untrusted code and the dashboard trusts X-Forwarded-Email, so putting
  // them on one network would let the agent forge identities. Instead gitops
  // (dual-homed) runs a raw TCP proxy on :2222 to the agent's sshd; SSH auth
  // and encryption stay end-to-end. See bitswan-gitops
  // app/services/agent_ssh_proxy.py.
  const ws = process.env.BITSWAN_WORKSPACE_NAME ?? 'default';
  return { host: `${ws}-gitops`, port: 2222 };
}

type SessionKind = 'claude' | 'sync' | 'write-tests' | 'automation';

function isSessionKind(value: unknown): value is SessionKind {
  return (
    value === 'claude' ||
    value === 'sync' ||
    value === 'write-tests' ||
    value === 'automation'
  );
}

/**
 * The canned prompt each session kind carries. Used both to seed a fresh
 * conversation (embedded into the launch command by `buildAutoCmd`) and to
 * serve `/api/coding-agent/prompt`, where the client fetches the same text
 * to inject into an already-running session.
 *
 * Plain 'claude' sessions have NO prompt — the agent's standing guidance
 * comes from the CLAUDE.md baked into the coding-agent image, which Claude
 * loads on every session (fresh and resumed alike).
 */
function promptForKind(kind: SessionKind): string | undefined {
  if (kind === 'sync') return SYNC_PROMPT;
  if (kind === 'write-tests') return WRITE_TESTS_PROMPT;
  if (kind === 'automation') return BUILD_AUTOMATION_PROMPT;
  return undefined;
}

/**
 * How long a `--resume` has to survive before we stop treating its non-zero
 * exit as "the conversation isn't there". `claude --resume <uuid>` bails in
 * well under a second when it can't find the transcript ("No conversation
 * found with session ID: …"); anything that ran longer than this had a real
 * conversation and exited for its own reasons, which we must not paper over
 * by starting a new chat behind the user's back.
 */
const RESUME_FAILFAST_SECONDS = 15;

/**
 * Build the shell command the coding-agent container runs for one session
 * (transported as `SSH_AUTO_CMD`, materialised into a script and executed by
 * agent-session-wrapper). Prepares Claude's per-user config, then either
 * resumes the caller's conversation or starts a new one. Exported for tests.
 */
export function buildAutoCmd(opts: {
  copy: string;
  bp?: string;
  sessionId: string;
  resume: boolean;
  kind: SessionKind;
}): string {
  // Every session — sync included — works inside a BP's own clone: the copy
  // root is a plain directory (each BP under it is a separate git repo), so
  // there is nothing to run git against up there.
  const cd = `/workspace/copies/${opts.copy}/${opts.bp}`;
  const prompt = promptForKind(opts.kind);
  // Either continue a previous chat (--resume <uuid>) or start a fresh one
  // with a caller-provided UUID (--session-id <uuid>) so the dashboard can
  // resume it later. A canned prompt, when the kind carries one, rides as
  // the positional arg, embedded inside single quotes; any apostrophes in
  // the canned prompt templates would otherwise terminate the quoted
  // region. Plain sessions launch bare and wait for the user.
  const freshArgs =
    `--dangerously-skip-permissions --session-id ${opts.sessionId}` +
    (prompt ? ` '${bashSingleQuoteEscape(prompt)}'` : '');
  const resumeArgs = `--dangerously-skip-permissions --resume ${opts.sessionId}`;
  // Stale-session recovery. The dashboard remembers a conversation UUID for
  // this (copy, bp) forever, but the transcript that backs it lives inside
  // the coding-agent container — a container rebuild, a wiped home volume or
  // a pruned history makes it vanish. `claude --resume <uuid>` then prints
  // "No conversation found with session ID: …" and exits immediately, the
  // ssh session ends, and the dashboard is left with no agent (bailey-lab
  // #246).
  //
  // We can't read claude's stderr here (it owns the TTY), so the signal we
  // key off is its *exit status plus how fast it bailed*: a non-zero exit
  // within RESUME_FAILFAST_SECONDS means the resume never got off the
  // ground, so we start a fresh conversation instead. Re-using the SAME uuid
  // is deliberate — it's free precisely because no conversation holds it, and
  // it keeps the dtach socket name, the wrapper's .meta.json and the
  // dashboard's stored id all pointing at one conversation, so the next visit
  // resumes successfully.
  //
  // This fires at most once per ssh session: if the fresh start fails too,
  // the script exits and the client backs off rather than retrying in here.
  // Failures that are *not* recoverable this way — the container being
  // unreachable, DNS not resolving, the user not being authenticated, or
  // resuming someone else's session — are all rejected before we ever spawn
  // ssh (see the WS handler below) and never reach this command.
  //
  // Note the deliberate absence of backslash escapes in the snippet below:
  // the wrapper materialises SSH_AUTO_CMD with `echo "$AUTO_CMD" > script`,
  // and `echo`'s handling of backslashes is shell/option dependent.
  const launch = opts.resume
    ? `{ _t0=$SECONDS; claude ${resumeArgs}; _rc=$?; ` +
      `if [ "$_rc" -ne 0 ] && [ $((SECONDS - _t0)) -lt ${RESUME_FAILFAST_SECONDS} ]; then ` +
      `echo; echo '[bitswan] could not resume the previous conversation - starting a new one'; ` +
      `exec claude ${freshArgs}; fi; exit "$_rc"; }`
    : `exec claude ${freshArgs}`;
  // Both stubs below target $CLAUDE_CONFIG_DIR: agent-session-wrapper gives
  // every dashboard session a per-user config dir (keyed off the oauth2-proxy
  // email), and Claude ignores ~/.claude entirely once that env var is set.
  // The homedir fallback only matters if the wrapper ever stops exporting it.
  // Both merge instead of overwrite because Claude writes its own keys
  // (theme, …) into the same files mid-session. JS uses only double quotes so
  // the whole node -e stays safely single-quoted for the shell +
  // SSH_AUTO_CMD transport.
  //
  // settings.json: skip the dangerous-mode re-prompt on every session, and
  // drop the Co-Authored-By trailer — the wrapper already attributes commits
  // to the real user via GIT_AUTHOR_*/GIT_COMMITTER_*.
  const settingsCmd =
    `node -e 'const fs=require("fs"),os=require("os");` +
    `const dir=process.env.CLAUDE_CONFIG_DIR||os.homedir()+"/.claude";` +
    `fs.mkdirSync(dir,{recursive:true});` +
    `const p=dir+"/settings.json";` +
    `let s={};try{s=JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){}` +
    `Object.assign(s,{skipDangerousModePermissionPrompt:true,includeCoAuthoredBy:false});` +
    `fs.writeFileSync(p,JSON.stringify(s))'`;
  // .claude.json: pre-trust the working directory and mark onboarding
  // complete. Claude's "trust this folder" dialog is tracked PER directory
  // (in `projects[<cwd>].hasTrustDialogAccepted`) and is NOT skipped by
  // --dangerously-skip-permissions in an interactive (TTY) session, so
  // without this the agent hangs on the trust prompt the first time it
  // enters any copy/BP folder. Setting the global onboarding flags too makes
  // a freshly-provisioned coding-agent container start straight into the
  // session (no theme picker / welcome flow).
  const trustCmd =
    `node -e 'const fs=require("fs"),os=require("os"),` +
    `p=(process.env.CLAUDE_CONFIG_DIR||os.homedir())+"/.claude.json";` +
    `let d={};try{d=JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){}` +
    `Object.assign(d,{hasCompletedOnboarding:true,bypassPermissionsModeAccepted:true,hasTrustDialogAccepted:true});` +
    `if(!d.theme)d.theme="dark";` +
    `d.projects=d.projects||{};` +
    `d.projects[process.cwd()]=Object.assign({},d.projects[process.cwd()],{hasTrustDialogAccepted:true});` +
    `fs.writeFileSync(p,JSON.stringify(d))'`;
  return (
    `cd ${cd} && ` +
    `${settingsCmd} && ` +
    `${trustCmd} && ` +
    launch
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
 * Wait until DNS resolves the SSH target hostname (normally the gitops
 * container carrying the agent-ssh proxy; the agent itself is on a network
 * this container can't see). The container takes a moment to register with
 * docker's embedded DNS after it starts — without this poll, the first
 * session attempt after a cold start can fail with "Could not resolve
 * hostname".
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
 *     `${WS}-coding-agent` container (via the gitops agent-ssh proxy — see
 *     agentSshTarget), scoped to a (copy, bp) pair, and always runs Claude.
 *     The wrapper inside the agent container handles cd + dtach + the
 *     launched command.
 *   - `/api/coding-agent/session/latest` returns the scope's resume
 *     candidate (one conversation per user × copy × BP).
 *   - `/api/coding-agent/prompt` serves the canned prompt for a session
 *     kind, for injection into a live session.
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
    };
  }>('/ws/coding-agent', { websocket: true }, async (socket, req) => {
    const { copy, bp, session_id, resume, kind: kindRaw } = req.query;
    if (!copy || !isValidCopyName(copy)) {
      socket.send(JSON.stringify({ type: 'error', message: 'invalid copy' }));
      socket.close(1008, 'invalid copy');
      return;
    }
    const kind: SessionKind = isSessionKind(kindRaw) ? kindRaw : 'claude';
    // `bp` is required for every session kind — sync sessions are BP-scoped
    // too: each business process is its own repo, and the copy root isn't one.
    if (!bp || !isValidBpId(bp)) {
      socket.send(JSON.stringify({ type: 'error', message: 'invalid bp' }));
      socket.close(1008, 'invalid bp');
      return;
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
    });
    const { host, port } = agentSshTarget();

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

    // Gate resumes against the conversation's recorded meta, two ways:
    //
    //   - OWNER: a malicious user could grab another user's claude session
    //     UUID and pass it as `resume` — they'd attach to the still-running
    //     dtach socket (/tmp/.claude-dtach-<UUID>.sock) and end up driving
    //     Claude under the *original* user's CLAUDE_CONFIG_DIR, leaking that
    //     user's Anthropic account.
    //   - SCOPE: attaching a conversation under a different (copy, bp) than
    //     it belongs to shows one BP's conversation in another BP's Agents
    //     tab and silently migrates its meta there (the wrapper overwrites
    //     the meta with the attach-time scope) — bailey-lab #333. The client
    //     shouldn't ever ask for this; refusing makes a client bug loud
    //     instead of cross-contaminating.
    //
    // Conversations with no meta (pre-single-session legacy) fall through;
    // new sessions always write one.
    //
    // This check runs *after* firstFrame so the disk lookup doesn't race the
    // client's first message — `socket.once('message', …)` inside the
    // firstFrame promise has to be attached before any awaits, or the
    // browser's open-time resize event arrives during the await with no
    // listener and is lost (the WS then times out after 5s with no spawn).
    if (isResume && resumeId) {
      const meta = await findSessionMeta(resumeId);
      if (
        meta?.userEmail &&
        meta.userEmail !== 'unknown' &&
        meta.userEmail !== email
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
      if (meta && (meta.copy !== copy || meta.bp !== bp)) {
        socket.send(
          JSON.stringify({
            type: 'error',
            message: `session belongs to ${meta.copy}/${meta.bp ?? ''}, not ${copy}/${bp}`,
          }),
        );
        socket.close(1008, 'wrong scope');
        return;
      }
    }

    let aborted = false;
    socket.once('close', () => {
      aborted = true;
    });

    // The SSH target (gitops, carrying the agent-ssh proxy) is provisioned by
    // the automation-server during workspace init. Poll DNS once so we don't
    // race the brief gap between container start and Docker's embedded DNS
    // publishing the host.
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
          '-p',
          String(port),
          '-i',
          SSH_KEY,
          '-o',
          'StrictHostKeyChecking=no',
          '-o',
          'UserKnownHostsFile=/dev/null',
          '-o',
          'SendEnv=SSH_USER_EMAIL SSH_WORKTREE SSH_BP SSH_CLAUDE_SESSION_ID SSH_AUTO_CMD',
          `agent@${host}`,
        ],
        cwd: undefined,
        cols,
        rows,
        extraEnv: {
          SSH_USER_EMAIL: email,
          SSH_WORKTREE: copy,
          // Every session is BP-scoped (each BP is its own repo); the
          // wrapper cds into the BP clone and records the bp in the meta.
          ...(bp ? { SSH_BP: bp } : {}),
          SSH_CLAUDE_SESSION_ID: claudeSessionId,
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
  }>('/api/coding-agent/session/latest', async (req, reply) => {
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
      // null when the scope has no session yet — the client starts fresh.
      const session = await latestSession({ copy, bp, userEmail });
      return { session };
    } catch (err) {
      app.log.warn({ err, copy, bp }, 'latest session lookup failed');
      return reply.code(500).send({ error: 'lookup failed' });
    }
  });

  // The canned prompt for one session kind, as plain text. The client
  // fetches this to inject into an already-running session's terminal —
  // the same text `buildAutoCmd` embeds when it has to start a fresh one,
  // so both paths stay in lockstep.
  app.get<{
    Querystring: { copy?: string; bp?: string; kind?: string };
  }>('/api/coding-agent/prompt', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { copy, bp, kind: kindRaw } = req.query;
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
    const kind: SessionKind = isSessionKind(kindRaw) ? kindRaw : 'claude';
    const prompt = promptForKind(kind);
    if (!prompt) {
      // Plain 'claude' sessions carry no canned prompt (the baked CLAUDE.md
      // is their standing guidance) — nothing to inject.
      return reply.code(400).send({ error: `kind ${kind} has no canned prompt` });
    }
    return { prompt };
  });
}

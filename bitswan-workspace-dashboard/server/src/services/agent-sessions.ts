import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { isBootstrapPrompt } from './agent-prompts.js';

/**
 * Bind-mount target for the coding-agent's session transcripts. The agent
 * writes `<sessionId>.meta.json` and `<sessionId>.cast` here; we read both
 * for the dashboard's per-BP session list and asciinema playback.
 */
export const SESSIONS_DIR =
  process.env.AGENT_SESSIONS_DIR ?? '/workspace/agent-sessions';

/**
 * Read-only view of the coding-agent's `/home/agent`, bind-mounted in from
 * `gitopsPath/coding-agent-home`. Holds per-user Claude config dirs at
 * `.claude_<slug>/projects/<encoded-cwd>/<uuid>.jsonl` (new layout) and the
 * legacy shared `.claude/projects/...` (pre-isolation sessions).
 */
export const AGENT_HOME_DIR =
  process.env.AGENT_HOME_DIR ?? '/workspace/agent-home';

/**
 * Map a user email to the directory suffix the coding-agent wrapper uses
 * for that user's Claude config (CLAUDE_CONFIG_DIR=/home/agent/.claude_<slug>).
 * MUST stay in sync with `sanitize_email` in
 * `bitswan-coding-agent/agent-session-wrapper` — the bash and TS
 * implementations have to produce identical slugs so the dashboard reads
 * the same path the agent wrote.
 */
export function sanitizeEmail(raw: string): string {
  const clean = raw
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .slice(0, 40);
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8);
  return `${clean}_${hash}`;
}

const TITLE_MAX_LEN = 80;

export interface AgentSession {
  id: string;
  timestamp: string;
  userEmail: string;
  worktree: string;
  /** null when the session was created by the editor (no SSH_BP env var) or is a worktree-level sync session. */
  bp: string | null;
  /** Empty string when no `.cast` file exists alongside the metadata. */
  castFile: string;
  logged: boolean;
  /**
   * Claude conversation UUID — passed in by the dashboard via
   * SSH_CLAUDE_SESSION_ID so we can `--resume <uuid>` later. May be null
   * for legacy or editor-created sessions.
   */
  claudeSessionId: string | null;
  /**
   * "claude" for a regular BP-scoped chat (the default), "sync" for the
   * worktree-level git-sync flow, "requirement" for a per-requirement
   * focused session, "write-tests" / "automation" for the Requirements
   * tab's canned-prompt sessions, or null for legacy / editor-launched
   * sessions where the wrapper didn't record a kind.
   */
  kind: 'claude' | 'sync' | 'requirement' | 'write-tests' | 'automation' | null;
  /**
   * First user prompt from Claude's transcript, truncated. Empty until the
   * user has actually typed something into the session.
   */
  title: string;
}

interface RawMeta {
  id?: string;
  user_email?: string;
  userEmail?: string;
  worktree?: string;
  bp?: string | null;
  claude_session_id?: string | null;
  claudeSessionId?: string | null;
  kind?: string | null;
  started_at?: string;
  timestamp?: string;
  logged?: boolean;
}

/**
 * Scan `SESSIONS_DIR` and return parsed session metadata. When `bp` is
 * supplied the result is filtered to sessions started under that exact
 * (worktree, bp) pair — editor sessions (which have `bp = null`) are
 * dropped from the per-BP view. When `userEmail` is supplied, only
 * sessions started by that user are returned (legacy sessions whose
 * meta has no recorded email are kept under the assumption they predate
 * per-user isolation).
 */
export async function listSessions(filter: {
  worktree?: string;
  bp?: string;
  limit?: number;
  userEmail?: string;
}): Promise<AgentSession[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(SESSIONS_DIR);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }

  const sessions: AgentSession[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.meta.json')) continue;
    let raw: RawMeta;
    try {
      const buf = await fs.readFile(path.join(SESSIONS_DIR, entry), 'utf8');
      raw = JSON.parse(buf) as RawMeta;
    } catch {
      continue; // skip corrupt entries silently
    }

    const worktree = raw.worktree ?? '';
    const bp = raw.bp ?? null;
    const kindRaw = raw.kind ?? null;
    const kind: AgentSession['kind'] =
      kindRaw === 'claude' ||
      kindRaw === 'sync' ||
      kindRaw === 'requirement' ||
      kindRaw === 'write-tests' ||
      kindRaw === 'automation'
        ? kindRaw
        : null;
    const userEmail = raw.user_email ?? raw.userEmail ?? '';
    if (filter.userEmail !== undefined) {
      // Skip if this session belongs to someone else. Sessions with no
      // recorded email (legacy / pre-isolation) are kept so users don't
      // suddenly lose access to old sessions; new sessions always carry an
      // email courtesy of the wrapper's hard-fail.
      if (userEmail && userEmail !== 'unknown' && userEmail !== filter.userEmail) continue;
    }
    if (filter.worktree !== undefined && worktree !== filter.worktree) continue;
    if (filter.bp !== undefined) {
      // Worktree-level sync sessions (bp=null, kind='sync') surface in any
      // BP's Agents tab inside the worktree — there's nowhere else for the
      // user to see them. Other null-bp sessions (legacy / editor) stay
      // filtered out so the dashboard view doesn't accidentally pick them up.
      const matchesBp = bp === filter.bp;
      const isSyncForWorktree = kind === 'sync' && bp === null;
      if (!matchesBp && !isSyncForWorktree) continue;
    }

    const baseName = entry.slice(0, -'.meta.json'.length);
    const castName = `${baseName}.cast`;
    const castFile = fsSync.existsSync(path.join(SESSIONS_DIR, castName))
      ? castName
      : '';

    const claudeSessionId = raw.claude_session_id ?? raw.claudeSessionId ?? null;
    sessions.push({
      id: raw.id ?? baseName,
      timestamp: raw.started_at ?? raw.timestamp ?? '',
      userEmail,
      worktree,
      bp,
      castFile,
      logged: raw.logged !== false,
      claudeSessionId,
      kind,
      title: '',
    });
  }

  sessions.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  // Dedupe by claudeSessionId. The wrapper writes a fresh .meta.json on
  // every SSH connection, so each resume of the same conversation adds
  // another row. Keep the most-recent meta (first after the sort above) so
  // the cast filename and timestamp reflect the latest attempt; legacy /
  // editor sessions without a UUID stay as-is since each is a distinct
  // conversation.
  const seenClaudeIds = new Set<string>();
  const deduped: AgentSession[] = [];
  for (const s of sessions) {
    if (s.claudeSessionId) {
      if (seenClaudeIds.has(s.claudeSessionId)) continue;
      seenClaudeIds.add(s.claudeSessionId);
    }
    deduped.push(s);
  }

  const capped = deduped.slice(0, filter.limit ?? 50);

  // Resolve titles in parallel. Each lookup is a single open+read+close on
  // the JSONL; bounded by `capped` (≤50) so concurrent fan-out is fine.
  // Each session's title path depends on its own scope — sync sessions
  // (bp=null) live at the worktree root, BP-scoped sessions inside the BP.
  await Promise.all(
    capped.map(async (s) => {
      if (!s.claudeSessionId || !s.worktree) return;
      s.title = await readFirstPromptTitle({
        worktree: s.worktree,
        bp: s.bp ?? undefined,
        claudeSessionId: s.claudeSessionId,
        userEmail: s.userEmail,
      });
    }),
  );
  return capped;
}

/**
 * Look up the recorded `user_email` for a session by its Claude conversation
 * UUID. Returns null when no meta file references that UUID. Used to gate
 * `resume` requests so a user can't attach to (and steal) another user's
 * still-running claude process via the dtach socket.
 */
export async function findSessionOwnerEmail(
  claudeSessionId: string,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(SESSIONS_DIR);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.meta.json')) continue;
    let raw: RawMeta;
    try {
      const buf = await fs.readFile(path.join(SESSIONS_DIR, entry), 'utf8');
      raw = JSON.parse(buf) as RawMeta;
    } catch {
      continue;
    }
    const id = raw.claude_session_id ?? raw.claudeSessionId ?? null;
    if (id === claudeSessionId) {
      return raw.user_email ?? raw.userEmail ?? null;
    }
  }
  return null;
}

/**
 * Path Claude uses for its per-project JSONL. Mirrors the CLI's own
 * encoding: the absolute cwd is sanitised by replacing every non
 * alphanumeric character with `-`. We don't pull the encoding from the
 * CLI directly because it's not exposed as a public API.
 */
function encodeClaudeProjectDir(absoluteCwd: string): string {
  return absoluteCwd.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Pick the best human-readable title for a session from its Claude JSONL.
 *
 * Claude writes three relevant record types as a conversation progresses:
 *   - `ai-title` / `aiTitle` — Claude's auto-generated summary, refreshed as
 *     the conversation evolves (e.g. "Extend lorem ipsum text for REQ-004").
 *     Preferred because it actually describes what the conversation is
 *     *about* — the dashboard's default `-n` name (custom-title) is just
 *     "Claude · wt/bp", which is what we'd fall back to anyway.
 *   - `custom-title` / `customTitle` — name set by `-n` on start, or
 *     overwritten by `/rename` inside Claude. Used when no ai-title exists yet.
 *   - `user` messages — first user prompt, after skipping our own bootstrap
 *     and the local-command-caveat wrapper. Last resort.
 *
 * The first two are repeated (re-written each time they change). We take the
 * *last* occurrence of each. The user-prompt scan keeps the first non-meta
 * match. A single streaming pass collects all three.
 */
async function readFirstPromptTitle(opts: {
  worktree: string;
  bp?: string;
  claudeSessionId: string;
  userEmail?: string;
}): Promise<string> {
  // The agent runs claude with cwd = `/workspace/worktrees/<wt>/<bp>` for
  // a regular BP-scoped session, or `/workspace/worktrees/<wt>` for a
  // worktree-level sync session (see routes/coding-agent.ts → buildAutoCmd).
  // Claude encodes that path into its own projects/ subdirectory name.
  const cwd = opts.bp
    ? `/workspace/worktrees/${opts.worktree}/${opts.bp}`
    : `/workspace/worktrees/${opts.worktree}`;
  const projDir = encodeClaudeProjectDir(cwd);
  // Per-user sessions write transcripts under `.claude_<slug>/projects/...`;
  // legacy / unattributed sessions land in the shared `.claude/projects/...`.
  // Try the per-user path first when we have an email, then fall back.
  const candidates: string[] = [];
  if (opts.userEmail && opts.userEmail !== 'unknown') {
    const slug = sanitizeEmail(opts.userEmail);
    candidates.push(
      path.join(AGENT_HOME_DIR, `.claude_${slug}`, 'projects', projDir, `${opts.claudeSessionId}.jsonl`),
    );
  }
  candidates.push(
    path.join(AGENT_HOME_DIR, '.claude', 'projects', projDir, `${opts.claudeSessionId}.jsonl`),
  );
  const full = candidates.find((p) => fsSync.existsSync(p)) ?? candidates[candidates.length - 1];

  let customTitle = '';
  let aiTitle = '';
  let firstPrompt = '';

  try {
    const stream = fsSync.createReadStream(full, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line.startsWith('{')) continue;
        let entry: {
          type?: string;
          isMeta?: boolean;
          customTitle?: string;
          aiTitle?: string;
          message?: { role?: string; content?: unknown };
        };
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }

        if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') {
          const t = entry.customTitle.trim();
          if (t) customTitle = t;
          continue;
        }
        if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string') {
          const t = entry.aiTitle.trim();
          if (t) aiTitle = t;
          continue;
        }
        if (firstPrompt) continue; // already found one; nothing else to do for user-msg pass
        if (entry.type !== 'user' || entry.isMeta) continue;
        const content = entry.message?.content;
        const text =
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content
                  .map((c) =>
                    typeof c === 'object' &&
                    c !== null &&
                    'text' in c &&
                    typeof (c as { text: unknown }).text === 'string'
                      ? (c as { text: string }).text
                      : '',
                  )
                  .join(' ')
              : '';
        const cleaned = text.replace(/\s+/g, ' ').trim();
        if (!cleaned) continue;
        // Skip Claude's own command-caveat wrapper; it's not a real prompt.
        if (cleaned.startsWith('<local-command-caveat>')) continue;
        // Skip the dashboard's own bootstrap prompts (the canned text we
        // pass to Claude on session start). Without this every session
        // row reads the same generic "You are a BitSwan coding agent…"
        // until the user types their first real message.
        if (isBootstrapPrompt(cleaned)) continue;
        firstPrompt = cleaned;
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // Don't spam logs over a transient read race — silently fall back.
    }
  }

  const chosen = aiTitle || customTitle || firstPrompt;
  if (!chosen) return '';
  return chosen.length > TITLE_MAX_LEN
    ? chosen.slice(0, TITLE_MAX_LEN - 1) + '…'
    : chosen;
}

/**
 * Resolve a `.cast` filename to a read stream. Path-traversal-safe: the
 * basename is reduced to its tail, must end in `.cast`, and the file must
 * actually exist under `SESSIONS_DIR`.
 */
export function castStream(name: string): Readable {
  const base = path.basename(name);
  if (base !== name || !base.endsWith('.cast')) {
    throw new Error('invalid cast filename');
  }
  const full = path.join(SESSIONS_DIR, base);
  // existsSync is sufficient — the createReadStream will surface
  // permission / race-condition errors on its 'error' event.
  if (!fsSync.existsSync(full)) {
    throw new Error('cast not found');
  }
  return fsSync.createReadStream(full);
}

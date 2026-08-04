import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { isBootstrapPrompt } from './agent-prompts.js';

/**
 * Bind-mount target for the coding-agent's session metadata. The agent's
 * session wrapper writes one `<claudeSessionId>.meta.json` per conversation;
 * we read them to find a scope's resume candidate and its owner. (Old
 * timestamped meta files and `.cast` recordings from the pre-single-session
 * era may still sit here — they parse fine and age out naturally.)
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
  timestamp: string;
  userEmail: string;
  copy: string;
  bp: string | null;
  /** Claude conversation UUID — what `--resume <uuid>` takes. */
  claudeSessionId: string;
  /**
   * Best human-readable name for the conversation (Claude's ai-title, a
   * /rename, or the first real user prompt). Empty until one exists.
   */
  title: string;
}

interface RawMeta {
  user_email?: string;
  /** Wire field written by the coding-agent's session wrapper (`"worktree": …`); read as the copy name. */
  worktree?: string;
  bp?: string | null;
  claude_session_id?: string | null;
  started_at?: string;
}

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

async function readMeta(entry: string): Promise<RawMeta | null> {
  try {
    const buf = await fs.readFile(path.join(SESSIONS_DIR, entry), 'utf8');
    return JSON.parse(buf) as RawMeta;
  } catch {
    return null; // skip corrupt entries silently
  }
}

/**
 * The most recent session for one (copy, bp) scope, or null when the scope
 * has never run one. This is the dashboard's resume candidate: the Agents
 * tab re-attaches to it (dtach socket / `claude --resume`) on visit.
 * Sessions belonging to other users are skipped; sessions with no recorded
 * email (legacy) are kept so old conversations stay reachable.
 */
export async function latestSession(filter: {
  copy: string;
  bp: string;
  userEmail?: string;
}): Promise<AgentSession | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(SESSIONS_DIR);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }

  // eslint-disable-next-line no-restricted-syntax -- null = no session yet
  let latest: AgentSession | null = null;
  let latestAt = -Infinity;
  for (const entry of entries) {
    if (!entry.endsWith('.meta.json')) continue;
    const raw = await readMeta(entry);
    if (!raw) continue;

    const userEmail = raw.user_email ?? '';
    if (filter.userEmail !== undefined) {
      // Skip if this session belongs to someone else. Sessions with no
      // recorded email (legacy) are kept so users don't suddenly lose access
      // to old sessions; new sessions always carry an email courtesy of the
      // wrapper's hard-fail.
      if (userEmail && userEmail !== 'unknown' && userEmail !== filter.userEmail)
        continue;
    }
    if ((raw.worktree ?? '') !== filter.copy) continue;
    if ((raw.bp ?? null) !== filter.bp) continue;
    const claudeSessionId = raw.claude_session_id ?? null;
    if (!claudeSessionId) continue;

    const timestamp = raw.started_at ?? '';
    // Unparseable timestamps sort oldest so a malformed meta never shadows
    // a real session.
    const at = Number.isFinite(Date.parse(timestamp)) ? Date.parse(timestamp) : 0;
    if (latest && latestAt >= at) continue;
    latestAt = at;
    latest = {
      timestamp,
      userEmail,
      copy: filter.copy,
      bp: raw.bp ?? null,
      claudeSessionId,
      title: '',
    };
  }

  if (latest) {
    latest.title = await readFirstPromptTitle({
      copy: latest.copy,
      bp: latest.bp ?? undefined,
      claudeSessionId: latest.claudeSessionId,
      userEmail: latest.userEmail,
    });
  }
  return latest;
}

export interface SessionMetaInfo {
  userEmail: string | null;
  copy: string | null;
  bp: string | null;
}

/**
 * Look up a conversation's recorded owner + scope by its Claude UUID.
 * Returns null when no meta file references that UUID. Used to gate
 * `resume` requests two ways: a user must not attach to (and steal)
 * another user's still-running claude process via the dtach socket, and a
 * conversation must not be re-attached under a different (copy, bp) than
 * it belongs to — that would show one BP's conversation in another BP's
 * Agents tab and silently migrate its meta there (bailey-lab #333).
 *
 * The wrapper writes one `<uuid>.meta.json` per conversation, so this is a
 * direct read. Legacy timestamp-named metas aren't consulted — a missing
 * file reads as "nothing recorded", the same allowance legacy sessions
 * always had.
 */
export async function findSessionMeta(
  claudeSessionId: string,
): Promise<SessionMetaInfo | null> {
  if (!UUID_RE.test(claudeSessionId)) return null;
  const raw = await readMeta(`${claudeSessionId}.meta.json`);
  if (!raw) return null;
  return {
    userEmail: raw.user_email ?? null,
    copy: raw.worktree ?? null,
    bp: raw.bp ?? null,
  };
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
 *     *about*.
 *   - `custom-title` / `customTitle` — name set by `/rename` inside Claude.
 *     Used when no ai-title exists yet.
 *   - `user` messages — first user prompt, after skipping our own bootstrap
 *     and the local-command-caveat wrapper. Last resort.
 *
 * The first two are repeated (re-written each time they change). We take the
 * *last* occurrence of each. The user-prompt scan keeps the first non-meta
 * match. A single streaming pass collects all three.
 */
async function readFirstPromptTitle(opts: {
  copy: string;
  bp?: string;
  claudeSessionId: string;
  userEmail?: string;
}): Promise<string> {
  // The agent runs claude with cwd = `/workspace/copies/<c>/<bp>`. Claude
  // encodes that path into its own projects/ subdirectory name.
  const cwd = opts.bp
    ? `/workspace/copies/${opts.copy}/${opts.bp}`
    : `/workspace/copies/${opts.copy}`;
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
  // The shared-path fallback, pushed last; doubles as the "none exist"
  // default so `full` is always defined.
  const sharedPath = path.join(
    AGENT_HOME_DIR, '.claude', 'projects', projDir, `${opts.claudeSessionId}.jsonl`,
  );
  candidates.push(sharedPath);
  const full = candidates.find((p) => fsSync.existsSync(p)) ?? sharedPath;

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
        // pass to Claude on session start or inject into a live one).
        // Without this every session reads the same generic "You are a
        // BitSwan coding agent…" until the user types their first real
        // message.
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

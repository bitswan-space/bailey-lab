import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Bind-mount target for the coding-agent's session metadata. The agent's
 * session wrapper writes one `<claudeSessionId>.meta.json` per conversation;
 * we read them to find a scope's resume candidate and its owner. (Old
 * timestamped meta files and `.cast` recordings from the pre-single-session
 * era may still sit here — they parse fine and age out naturally.)
 */
export const SESSIONS_DIR =
  process.env.AGENT_SESSIONS_DIR ?? '/workspace/agent-sessions';

export interface AgentSession {
  timestamp: string;
  userEmail: string;
  copy: string;
  bp: string | null;
  /** Claude conversation UUID — what `--resume <uuid>` takes. */
  claudeSessionId: string;
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
    };
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

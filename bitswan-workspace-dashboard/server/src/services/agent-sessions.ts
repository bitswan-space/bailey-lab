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
 * Bind-mount target for Claude's per-project JSONL transcripts. The agent
 * writes here as user `agent` (its $HOME is `/home/agent`, mounted from
 * `gitopsPath/coding-agent-home`); we read these files read-only to lift
 * the first user prompt out as a session title.
 */
export const CLAUDE_PROJECTS_DIR =
  process.env.CLAUDE_PROJECTS_DIR ?? '/workspace/.claude/projects';

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
   * focused session, or null for legacy / editor-launched sessions where
   * the wrapper didn't record a kind.
   */
  kind: 'claude' | 'sync' | 'requirement' | null;
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
 * dropped from the per-BP view.
 */
export async function listSessions(filter: {
  worktree?: string;
  bp?: string;
  limit?: number;
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
    const kind: 'claude' | 'sync' | 'requirement' | null =
      kindRaw === 'claude' || kindRaw === 'sync' || kindRaw === 'requirement'
        ? kindRaw
        : null;
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
      userEmail: raw.user_email ?? raw.userEmail ?? '',
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
  const capped = sessions.slice(0, filter.limit ?? 50);

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
      });
    }),
  );
  return capped;
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
}): Promise<string> {
  // The agent runs claude with cwd = `/workspace/worktrees/<wt>/<bp>` for
  // a regular BP-scoped session, or `/workspace/worktrees/<wt>` for a
  // worktree-level sync session (see routes/coding-agent.ts → buildAutoCmd).
  // Claude encodes that path into its own projects/ subdirectory name.
  const cwd = opts.bp
    ? `/workspace/worktrees/${opts.worktree}/${opts.bp}`
    : `/workspace/worktrees/${opts.worktree}`;
  const projDir = encodeClaudeProjectDir(cwd);
  const full = path.join(CLAUDE_PROJECTS_DIR, projDir, `${opts.claudeSessionId}.jsonl`);

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

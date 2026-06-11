/**
 * Bootstrap prompts the dashboard passes to Claude on session creation.
 * Exported from a single module so the title-extraction logic in
 * `agent-sessions.ts` can recognise (and skip) them when scanning Claude's
 * JSONL for a real first user message — otherwise every session row reads
 * "You are a BitSwan coding agent…" as its title.
 */

export const DEFAULT_PROMPT =
  'You are a BitSwan coding agent. Start by running: bitswan-coding-agent --help. ' +
  'Read the BP\'s README.md, process.toml, and bitswan.yaml to orient yourself before ' +
  'making changes. Ask for clarification when the user\'s request is ambiguous.';

/** Worktree-level sync flow. Mirrors bitswan-editor's syncWorktree prompt. */
export const SYNC_PROMPT =
  'IMPORTANT: git is not installed. Use ONLY bitswan-coding-agent commands. ' +
  'Sync this worktree with main: 1) bitswan-coding-agent vcs commit -m pre-sync-commit ' +
  '2) bitswan-coding-agent vcs sync 3) If conflicts, resolve and run bitswan-coding-agent vcs sync-continue. ' +
  'Tell me when sync is complete.';

const BOOTSTRAP_PROMPTS = [DEFAULT_PROMPT, SYNC_PROMPT];

/**
 * True when the given (already-trimmed, single-line) user message is one of
 * the prompts the dashboard itself sent to bootstrap a session, so a title
 * scanner should keep walking the JSONL for the next user turn.
 */
export function isBootstrapPrompt(text: string): boolean {
  return BOOTSTRAP_PROMPTS.includes(text);
}

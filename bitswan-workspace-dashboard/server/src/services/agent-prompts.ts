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

/** Copy-level sync flow. Mirrors bitswan-editor's syncWorktree prompt. */
export const SYNC_PROMPT =
  'IMPORTANT: git is not installed. Use ONLY bitswan-coding-agent commands. ' +
  'Sync this copy with main: 1) bitswan-coding-agent vcs commit -m pre-sync-commit ' +
  '2) bitswan-coding-agent vcs sync 3) If conflicts, resolve and run bitswan-coding-agent vcs sync-continue. ' +
  'Tell me when sync is complete.';

/**
 * "Write tests" button in the Requirements tab. The agent turns the BP's
 * testable requirements into mechanically-verifiable tests.
 */
export const WRITE_TESTS_PROMPT =
  'Write automated tests for this BP\'s testable requirements. ' +
  'Run `bitswan-coding-agent requirements list` to see the requirements, and read the ' +
  'BP\'s README.md, process.toml, and existing source/tests first to follow the conventions. ' +
  'Create or extend tests so each requirement can be verified mechanically, run them, and ' +
  'update each tested requirement with `bitswan-coding-agent requirements update --id <id> --status <pass|fail>`. ' +
  'Do not change requirement descriptions.';

/**
 * "Build automation" button in the Description tab. The agent implements
 * the automation the BP's description (README.md) describes, using the
 * testable requirements as the work list where they exist.
 */
export const BUILD_AUTOMATION_PROMPT =
  'Build the automation this BP\'s description describes. ' +
  'Read the BP\'s README.md first — it is the specification the user wrote — then ' +
  'process.toml and bitswan.yaml to orient yourself. ' +
  'Run `bitswan-coding-agent requirements list`; if testable requirements exist, work through ' +
  'them in order (`bitswan-coding-agent requirements next` gives the next one), updating each with ' +
  '`bitswan-coding-agent requirements update --id <id> --status <pass|fail>` as you go. ' +
  'Otherwise implement what the README describes and propose requirements for it.';

const BOOTSTRAP_PROMPTS = [
  DEFAULT_PROMPT,
  SYNC_PROMPT,
  WRITE_TESTS_PROMPT,
  BUILD_AUTOMATION_PROMPT,
];

/**
 * True when the given (already-trimmed, single-line) user message is one of
 * the prompts the dashboard itself sent to bootstrap a session, so a title
 * scanner should keep walking the JSONL for the next user turn.
 */
export function isBootstrapPrompt(text: string): boolean {
  return BOOTSTRAP_PROMPTS.includes(text);
}

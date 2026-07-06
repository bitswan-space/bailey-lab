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

/**
 * Per-BP sync flow. Every business process is its OWN git repo; the session's
 * cwd is that BP's clone, whose `origin` points at the BP's repo on the
 * workspace git server (credentials are already configured), so the agent
 * uses plain git. The server accepts fast-forward pushes only. This prompt is
 * the conflict-resolution path: the dashboard does a plain commit + ff-push
 * itself when no rebase is needed, and only hands off to the agent here when
 * the BP's branch actually has to be rebased onto a moved main.
 */
export const SYNC_PROMPT =
  'Sync this business process with main using git. You are inside the business ' +
  "process's own git clone — each business process under this copy is a separate " +
  'repository, so nothing you do here touches the other business processes. ' +
  '1) Commit your work in progress: `git add -A && git commit -m "wip"` (skip if there is nothing to commit). ' +
  '2) Rebase onto the latest main: `git pull --rebase origin main`. ' +
  '3) If there are conflicts, resolve them, then `git add` the resolved files and `git rebase --continue`. ' +
  '4) Publish your branch: `git push origin HEAD` (the server accepts fast-forward pushes only). ' +
  'Do not run git in other business-process directories. Tell me when the sync is complete.';

/**
 * The pre-per-BP-repos sync prompt. Kept ONLY so title scanning of old
 * session transcripts still recognises it as a bootstrap prompt (see
 * `isBootstrapPrompt`); never sent to new sessions.
 */
const LEGACY_SYNC_PROMPT =
  'Sync this copy with main using git. ' +
  '1) Commit your work in progress: `git add -A && git commit -m "wip"` (skip if there is nothing to commit). ' +
  '2) Rebase onto the latest main: `git pull --rebase origin main`. ' +
  '3) If there are conflicts, resolve them, then `git add` the resolved files and `git rebase --continue`. ' +
  '4) Publish your branch: `git push origin HEAD` (the server accepts fast-forward pushes only). ' +
  'Tell me when the sync is complete.';

/**
 * "Write tests" button in the Requirements tab. The agent turns the BP's
 * testable requirements into mechanically-verifiable tests.
 */
export const WRITE_TESTS_PROMPT =
  'Write automated tests for this BP\'s testable requirements. ' +
  'Run `bitswan-coding-agent requirements list` to see the requirements, and read the ' +
  'BP\'s README.md, process.toml, and existing source/tests first to follow the conventions. ' +
  'For each requirement write a deterministic test whose name carries the requirement ID with ' +
  'hyphens turned into underscores, so REQ-003 maps to the token REQ_003 (e.g. def test_REQ_003_...). ' +
  'This naming lets a test be triggered by ID. Then run and record each one with ' +
  '`bitswan-coding-agent requirements test --id <id>`, which execs the test inside the BP\'s ' +
  'live-dev container and writes pass/fail back to the requirement automatically (run without ' +
  '--id to test all of them; default runner is pytest, pass --runner with a {id} placeholder for ' +
  'other frameworks). Do not change requirement descriptions.';

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
  LEGACY_SYNC_PROMPT,
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

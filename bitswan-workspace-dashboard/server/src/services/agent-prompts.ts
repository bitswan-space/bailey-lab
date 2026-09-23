/**
 * Canned task prompts the dashboard hands to Claude — seeded into a fresh
 * conversation or typed into a running one (sendPrompt).
 *
 * The agent's standing identity/orientation text is NOT here: it lives in
 * the CLAUDE.md baked into the coding-agent image at /workspace/CLAUDE.md,
 * which Claude loads on every session (ancestor-directory memory), so plain
 * sessions start with no prompt at all.
 */

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
 * Fixed opening sentence shared by every `mergeBackPrompt` instance,
 * regardless of the parent branch it targets. `SYNC_PROMPT` above is a
 * single unchanging constant a caller can match with `===`; a merge-back
 * prompt's text varies by `parentBranch`, so this lets a caller recognize
 * one with `startsWith` instead.
 */
export const MERGE_BACK_PROMPT_PREFIX =
  'Merge this experiment back into its parent copy using git.';

/**
 * Conflict-resolution path for an experiment's "Merge back into my copy"
 * action — the rebase-onto-`<parentBranch>` variant of {@link SYNC_PROMPT}.
 * Experiments merge back into the copy they branched from, never main, so
 * this rebases onto `parentBranch` instead of main; everything else
 * (per-BP clone, fast-forward-only push, scope) is identical. The
 * merge-to-parent endpoint hands off here only when it reports
 * `needs_rebase` (the parent moved ahead of what the experiment branched
 * from) — the same way sync hands off to SYNC_PROMPT only on a real conflict.
 */
export function mergeBackPrompt(parentBranch: string): string {
  return (
    MERGE_BACK_PROMPT_PREFIX +
    " You are inside the business process's own git clone — each business " +
    'process under this copy is a separate repository, so nothing you do ' +
    'here touches the other business processes. ' +
    '1) Commit your work in progress: `git add -A && git commit -m "wip"` (skip if there is nothing to commit). ' +
    '2) Rebase onto the latest ' +
    parentBranch +
    ': `git pull --rebase origin ' +
    parentBranch +
    '`. ' +
    '3) If there are conflicts, resolve them, then `git add` the resolved files and `git rebase --continue`. ' +
    '4) Publish your branch: `git push origin HEAD` (the server accepts fast-forward pushes only). ' +
    'Do not run git in other business-process directories. Tell me when the merge is complete.'
  );
}

/**
 * "Write tests" button in the Requirements tab. The agent turns the BP's
 * testable requirements into mechanically-verifiable tests.
 *
 * It does NOT tell the agent to record results: it cannot. A verdict comes
 * from gitops running the test, which happens on every commit.
 */
export const WRITE_TESTS_PROMPT =
  "Write automated tests for this BP's testable requirements. " +
  'Run `bitswan-coding-agent requirements list` to see them, and read the ' +
  "BP's README.md, process.toml and the existing source/tests first to follow " +
  'the conventions. ' +
  'For each requirement write a deterministic test whose NAME carries the ' +
  'requirement id with hyphens turned into underscores, so REQ-7QX4 is tested ' +
  'by a test whose name contains REQ_7QX4 — def test_REQ_7QX4_… (pytest), ' +
  "func TestREQ_7QX4_… (go), it('test_REQ_7QX4_…') (vitest). That name is the " +
  'only binding; there is no registry to update. ' +
  'Put each test INSIDE the automation directory (the one with ' +
  'automation.toml): only that directory is mounted into the container the ' +
  'tests run in, so a test elsewhere in the BP cannot be found. That mount is ' +
  'read-only — write any temporary file to /tmp. ' +
  'Declare automation on every requirement, naming the automation its test ' +
  'lives in: a BP is scaffolded with a frontend AND a backend, so a ' +
  'requirement that does not say inherits the BP default, and inheriting the ' +
  'wrong one makes a correct test report "no test" because it ran in a ' +
  'container where that source is not mounted. ' +
  'If the BP has more than one automation, make sure process.toml says which ' +
  'one runs the tests and which framework, under [testing]. If it mixes ' +
  'languages, give each automation its own [testing.<automation>] section (or ' +
  'set framework on the requirement itself) — the BP-wide framework applies to ' +
  'every automation otherwise, and a pytest suite parsed as go test output ' +
  'reports "no test" for tests that ran and passed. ' +
  'The test tooling has to be in that automation\'s own image — automations ' +
  'scaffolded from the built-in templates already have it; in an older one, ' +
  'add it to image/requirements-test.txt and rebuild with ' +
  '`bitswan-coding-agent deployments build-and-restart <deployment-id>`. ' +
  'Then commit: the tests run automatically on every commit and the verdicts ' +
  'appear in Requirements & tests. Read them with ' +
  '`bitswan-coding-agent requirements list` and fix whatever does not pass. ' +
  'You cannot set a verdict by hand and must not try to — if a requirement ' +
  'genuinely cannot be tested mechanically, say so rather than writing a test ' +
  'that always passes. Do not change requirement descriptions.';

/**
 * "Build automation" button in the Description tab. The agent implements
 * the automation the BP's description (README.md) describes, using the
 * testable requirements as the work list where they exist.
 */
export const BUILD_AUTOMATION_PROMPT =
  "Build the automation this BP's description describes. " +
  "Read the BP's README.md first — it is the specification the user wrote — " +
  'then process.toml and bitswan.yaml to orient yourself. ' +
  'Run `bitswan-coding-agent requirements list`; if testable requirements ' +
  'exist, work through them in order (`bitswan-coding-agent requirements next` ' +
  'gives the next one). Commit as you go: the tests run on every commit and ' +
  'the verdicts come back on their own — you do not record them yourself, and ' +
  'there is no flag that would let you. ' +
  'Otherwise implement what the README describes and propose requirements for ' +
  'it with `bitswan-coding-agent requirements add --proposed`.';

/**
 * The jobs the dashboard can hand the agent. 'claude' is a plain session with
 * no canned prompt at all.
 */
export type SessionKind = 'claude' | 'sync' | 'merge-parent' | 'write-tests' | 'automation';

export function isSessionKind(value: unknown): value is SessionKind {
  return (
    value === 'claude' ||
    value === 'sync' ||
    value === 'merge-parent' ||
    value === 'write-tests' ||
    value === 'automation'
  );
}

/**
 * The canned prompt each session kind carries. Used to seed a fresh terminal
 * conversation (embedded into the launch command by `buildAutoCmd`), to serve
 * `/api/coding-agent/prompt`, and to fill the hosted panel's composer when a
 * button in another tab hands over a task.
 *
 * Plain 'claude' sessions have NO prompt — the agent's standing guidance
 * comes from the CLAUDE.md baked into the coding-agent image, which Claude
 * loads on every session (fresh and resumed alike).
 *
 * `'merge-parent'` carries no FIXED prompt: its text is parameterized by
 * `parent` (the experiment's parent copy, the branch it rebases onto), so
 * `parent` is required for it — see `mergeBackPrompt`. Missing it yields no
 * prompt, same as any kind with nothing to say.
 */
export function promptForKind(kind: SessionKind, parent?: string): string | undefined {
  if (kind === 'sync') return SYNC_PROMPT;
  if (kind === 'merge-parent') return parent ? mergeBackPrompt(parent) : undefined;
  if (kind === 'write-tests') return WRITE_TESTS_PROMPT;
  if (kind === 'automation') return BUILD_AUTOMATION_PROMPT;
  return undefined;
}

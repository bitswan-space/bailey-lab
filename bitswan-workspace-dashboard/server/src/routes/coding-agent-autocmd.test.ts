import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { buildAutoCmd } from './coding-agent.js';

const execFileAsync = promisify(execFile);

const UUID = '281f388b-a0cb-4007-a64f-9164503155c5';

function autoCmd(resume: boolean): string {
  return buildAutoCmd({
    copy: 'admin-timssandbox2-bswn-io',
    bp: 'bookmaker',
    sessionId: UUID,
    resume,
    kind: 'claude',
  });
}

/**
 * Run the launch tail of an auto-command with a fake `claude` on PATH, the
 * way the coding-agent container would: written to a file with `echo` and
 * executed by bash (see agent-session-wrapper). `claudeScript` stands in for
 * the real CLI.
 *
 * The `cd` / settings / trust prefix is dropped — those touch paths that only
 * exist inside the agent container — leaving exactly the resume / fallback
 * logic under test.
 */
async function runLaunch(opts: {
  resume: boolean;
  claudeScript: string;
}): Promise<{ stdout: string; code: number }> {
  const full = autoCmd(opts.resume);
  const launch = full.slice(full.indexOf(opts.resume ? '{ _t0=' : 'exec claude'));
  const harness = [
    'set -u',
    'BIN=$(mktemp -d)',
    "cat > \"$BIN/claude\" <<'CLAUDE'",
    '#!/bin/bash',
    opts.claudeScript,
    'CLAUDE',
    'chmod +x "$BIN/claude"',
    'export PATH="$BIN:$PATH"',
    'echo "$1" > "$BIN/auto.sh"',
    'bash "$BIN/auto.sh"',
  ].join('\n');
  try {
    const { stdout } = await execFileAsync('bash', ['-c', harness, 'bash', launch]);
    return { stdout, code: 0 };
  } catch (err) {
    // eslint-disable-next-line no-restricted-syntax -- child_process error shape
    const e = err as { stdout?: string; code?: number };
    return { stdout: e.stdout ?? '', code: e.code ?? -1 };
  }
}

test('a fresh session execs claude with the caller-provided session id', () => {
  const cmd = autoCmd(false);
  assert.match(cmd, new RegExp(`exec claude [^\\n]*--session-id ${UUID}`));
  assert.doesNotMatch(cmd, /--resume/);
  // No display name: one conversation per (user, copy, BP) — naming was for
  // the removed multi-session list.
  assert.doesNotMatch(cmd, / -n /);
});

test('the stale-session fallback is gated on the resume failing fast', () => {
  // A slow failure is a real conversation that broke, not a missing one, so
  // the fallback must not fire for it. Asserted structurally: exercising the
  // window for real would mean a 15s sleep in the test.
  assert.match(autoCmd(true), /\$\(\(SECONDS - _t0\)\) -lt 15/);
});

test('a resume that works is not restarted behind the user’s back', async () => {
  const { stdout, code } = await runLaunch({
    resume: true,
    // A real conversation: prints something, then the user quits cleanly.
    claudeScript: 'echo "resumed $*"; exit 0',
  });
  assert.match(stdout, /resumed .*--resume/);
  assert.doesNotMatch(stdout, /could not resume/);
  assert.equal(code, 0);
});

test('a resume of a vanished conversation starts a new one on the same id', async () => {
  const { stdout, code } = await runLaunch({
    resume: true,
    // Mirrors the real failure: `--resume` bails instantly with "No
    // conversation found with session ID: …"; `--session-id` then works
    // because nothing holds that id.
    claudeScript: [
      'case "$*" in',
      `  *--resume*) echo "No conversation found with session ID: ${UUID}"; exit 1 ;;`,
      '  *) echo "started fresh: $*"; exit 0 ;;',
      'esac',
    ].join('\n'),
  });
  assert.match(stdout, /No conversation found/);
  assert.match(stdout, /could not resume the previous conversation/);
  assert.match(stdout, new RegExp(`started fresh: .*--session-id ${UUID}`));
  assert.equal(code, 0);
});

test('the stale-session fallback fires at most once', async () => {
  const { stdout, code } = await runLaunch({
    resume: true,
    // Nothing works — e.g. claude isn't authenticated in this container. We
    // must try exactly one fresh start and then give up, leaving the client
    // to back off rather than looping in here.
    claudeScript: 'echo boom; exit 1',
  });
  assert.equal(stdout.match(/boom/g)?.length, 2);
  assert.notEqual(code, 0);
});

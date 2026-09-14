import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { assertBundledClaudeDisarmed } from './vscode-sidebar.js';

/**
 * Claude Code must never execute in the dashboard container. That container
 * reaches the whole workspace — the deploy secret, the workspace SSH key, every
 * user's Claude credentials, its own server bundle — and an agent runs
 * model-chosen shell commands. It runs in the coding-agent container instead,
 * through claude-process-wrapper.
 *
 * Two things enforce that: the entrypoint takes the execute bit off the
 * extension's bundled copy at startup, and spawnHost refuses to start a host
 * while that copy is runnable. This pins the second one, because it is the half
 * that has to hold when something else has gone wrong — a re-armed file, a
 * hand-mounted extension directory, a restored volume.
 *
 * Failing closed is deliberate. A broken Coding Agent tab is visible and
 * fixable; an agent quietly running next to the deploy secret is neither.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-disarm-'));

function extensionDir(mode: number | null): string {
  const dir = fs.mkdtempSync(path.join(tmp, 'ext-'));
  if (mode !== null) {
    const resources = path.join(dir, 'resources', 'native-binary');
    fs.mkdirSync(resources, { recursive: true });
    const binary = path.join(resources, 'claude');
    fs.writeFileSync(binary, 'ELF');
    fs.chmodSync(binary, mode);
  }
  return dir;
}

test('refuses while the bundled claude is executable', () => {
  assert.throws(
    () => assertBundledClaudeDisarmed(extensionDir(0o755)),
    (err: Error) =>
      /executable in the dashboard container/.test(err.message) &&
      /only ever run in the coding-agent container/.test(err.message),
  );
});

test('any execute bit is enough to refuse, not just the owner one', () => {
  // 0o711 owner-only-ish, plus group-x and other-x on an otherwise plain file:
  // a mode that looks harmless in `ls` still hands execution to someone.
  for (const mode of [0o711, 0o654, 0o645]) {
    assert.throws(
      () => assertBundledClaudeDisarmed(extensionDir(mode)),
      /executable in the dashboard container/,
      `mode ${mode.toString(8)} should have been refused`,
    );
  }
});

test('a disarmed binary passes', () => {
  assert.doesNotThrow(() => assertBundledClaudeDisarmed(extensionDir(0o644)));
  assert.doesNotThrow(() => assertBundledClaudeDisarmed(extensionDir(0o600)));
});

test('an absent binary passes — nothing to run is the safest state', () => {
  assert.doesNotThrow(() => assertBundledClaudeDisarmed(extensionDir(null)));
});

test('a missing extension directory does not throw on our behalf', () => {
  // The caller has already established the extension exists; this guard must
  // not turn an unrelated missing path into a security-sounding error.
  assert.doesNotThrow(() => assertBundledClaudeDisarmed(path.join(tmp, 'no-such-dir')));
});

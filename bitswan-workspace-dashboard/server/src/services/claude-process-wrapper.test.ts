import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * What claude-process-wrapper hands to the far side.
 *
 * The extension launches the agent through this script and configures that
 * process entirely through argv and environment. ssh carries neither by
 * default, so anything the wrapper does not deliberately rebuild is silently
 * dropped — and the failures that causes do not look like transport failures.
 *
 * CLAUDE_CODE_ENTRYPOINT is the example that cost a day: the extension sets it
 * to `claude-vscode`, the CLI writes it into every transcript, and the sidebar
 * hides `sdk-cli`/`sdk-ts`/`sdk-py` sessions from its history as programmatic.
 * Dropped, the CLI defaulted to sdk-cli and the panel could not see the
 * conversations it had itself just had — empty history, nothing to resume, a
 * new conversation on every visit, with the agent working perfectly throughout.
 *
 * These run the real script against a stub `ssh` and read back the command it
 * would have run.
 */

const WRAPPER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../claude-process-wrapper',
);

interface Run {
  host: string;
  remote: string;
  argv: string[];
}

/**
 * Run the wrapper with a stub `ssh` on PATH and return what it was asked to do.
 * The stub dumps its own argv, so this observes the real command line rather
 * than a re-implementation of it.
 */
function run(env: Record<string, string>, args: string[] = []): Run {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapper-'));
  const out = path.join(dir, 'argv');
  fs.writeFileSync(
    path.join(dir, 'ssh'),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(out)}\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(dir, 'key'), 'not a real key', { mode: 0o600 });

  execFileSync(WRAPPER, args, {
    env: {
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      SIDEBAR_AGENT_SSH_HOST: 'ws-gitops',
      SIDEBAR_AGENT_SSH_PORT: '2222',
      SIDEBAR_USER_EMAIL: 'ada@example.com',
      SIDEBAR_COPY: 'ada-example-com',
      SIDEBAR_BP: 'bp',
      SIDEBAR_AGENT_SSH_KEY: path.join(dir, 'key'),
      ...env,
    },
  });

  const argv = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean);
  return { host: argv[argv.length - 2] ?? '', remote: argv[argv.length - 1] ?? '', argv };
}

test('the extension classification of the process reaches the CLI', () => {
  const { remote } = run({ CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' });
  assert.match(remote, /export CLAUDE_CODE_ENTRYPOINT='claude-vscode';/);
  // Before `exec claude`, or the CLI never sees it.
  assert.ok(
    remote.indexOf('CLAUDE_CODE_ENTRYPOINT') < remote.indexOf('exec claude'),
    remote,
  );
});

test('the other settings the extension makes for its CLI come too', () => {
  const { remote } = run({
    CLAUDE_CODE_ENTRYPOINT: 'claude-vscode',
    MCP_CONNECTION_NONBLOCKING: 'true',
    CLAUDE_CODE_ENABLE_TASKS: '0',
  });
  assert.match(remote, /export MCP_CONNECTION_NONBLOCKING='true';/);
  assert.match(remote, /export CLAUDE_CODE_ENABLE_TASKS='0';/);
});

test('an unset variable is left unset rather than guessed at', () => {
  const { remote } = run({});
  assert.ok(!remote.includes('CLAUDE_CODE_ENTRYPOINT'), remote);
  assert.match(remote, /exec claude/);
});

test('nothing else in the environment is forwarded', () => {
  // The wrapper's own environment is the dashboard server's, which holds the
  // deploy secret among other things. Only the allow-list crosses.
  const { remote } = run({
    CLAUDE_CODE_ENTRYPOINT: 'claude-vscode',
    BITSWAN_DEPLOY_SECRET: 'super-secret',
    ANTHROPIC_API_KEY: 'sk-not-this-one',
  });
  assert.ok(!remote.includes('super-secret'), remote);
  assert.ok(!remote.includes('sk-not-this-one'), remote);
});

test('values are quoted for the remote shell, not interpolated into it', () => {
  const { remote } = run({ CLAUDE_CODE_ENTRYPOINT: "it's; rm -rf /" });
  assert.match(remote, /export CLAUDE_CODE_ENTRYPOINT='it'\\''s; rm -rf \/';/);
  // The injected `;` must sit inside the quotes, so the only command
  // separators are the ones the wrapper wrote.
  assert.equal(remote.split('exec claude').length, 2, remote);
});

test('arguments are quoted the same way', () => {
  const { remote } = run({}, ['--resume=5c8b7c77', "--title=it's fine"]);
  assert.match(remote, /exec claude '--resume=5c8b7c77' '--title=it'\\''s fine'/);
});

test('the bundled binary path the extension prepends is dropped', () => {
  const ext = '/claude-extension-cache/extension';
  const { remote } = run({ CLAUDE_EXTENSION_PATH: ext }, [
    `${ext}/resources/native-binary/claude`,
    '--print',
  ]);
  assert.ok(!remote.includes('native-binary'), remote);
  assert.match(remote, /exec claude '--print'/);
});

test('a real argument that merely looks similar is kept', () => {
  const { remote } = run({ CLAUDE_EXTENSION_PATH: '/claude-extension-cache/extension' }, [
    '--add-dir=/claude-extension-cache/extension-notes',
    '--print',
  ]);
  assert.match(remote, /--add-dir=\/claude-extension-cache\/extension-notes/);
});

test('it refuses rather than connecting somewhere unscoped', () => {
  assert.throws(() => run({ SIDEBAR_USER_EMAIL: '' }), /SIDEBAR_USER_EMAIL/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { configDirNameFor } from './vscode-sidebar.js';
import {
  isAgentKind,
  parsePreferences,
  preferencesPath,
  readPreferences,
  writePreferences,
} from './user-preferences.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dashboard-prefs-'));
process.env.SIDEBAR_CONFIG_ROOT = root;

test('the file lives in the same per-user directory as the rest of the user’s state', () => {
  const email = 'Alice@Example.com';
  assert.equal(preferencesPath(email), path.join(root, configDirNameFor(email), 'dashboard-preferences.json'));
});

test('no file, an empty file and garbage all read as "nothing chosen yet"', async () => {
  assert.deepEqual(await readPreferences('nobody@example.com'), {});
  assert.deepEqual(parsePreferences(''), {});
  assert.deepEqual(parsePreferences('not json'), {});
  assert.deepEqual(parsePreferences('[1,2]'), {});
  assert.deepEqual(parsePreferences('{"codingAgent":"vim"}'), {});
});

test('a choice is written atomically and read back, per user', async () => {
  const alice = 'alice@example.com';
  const bob = 'bob@example.com';
  assert.deepEqual(await writePreferences(alice, { codingAgent: 'opencode' }), { codingAgent: 'opencode' });
  assert.deepEqual(await readPreferences(alice), { codingAgent: 'opencode' });
  assert.deepEqual(await readPreferences(bob), {});
  const entries = await fs.readdir(path.dirname(preferencesPath(alice)));
  assert.deepEqual(entries.filter((e) => e.endsWith('.tmp')), [], 'no temp file left behind');
  const mode = (await fs.stat(preferencesPath(alice))).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('changing the choice replaces it and the cache does not serve the old one', async () => {
  const carol = 'carol@example.com';
  await writePreferences(carol, { codingAgent: 'opencode' });
  await writePreferences(carol, { codingAgent: 'claude-code' });
  assert.deepEqual(await readPreferences(carol), { codingAgent: 'claude-code' });
});

test('only the two agents are agent kinds', () => {
  assert.equal(isAgentKind('claude-code'), true);
  assert.equal(isAgentKind('opencode'), true);
  assert.equal(isAgentKind('OpenCode'), false);
  assert.equal(isAgentKind(''), false);
  assert.equal(isAgentKind(undefined), false);
});

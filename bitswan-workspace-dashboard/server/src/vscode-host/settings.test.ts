import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createHostState, buildVscodeApi } from './api.js';

/**
 * The extension configures itself through `workspace.getConfiguration`, which
 * it calls 36 times during activation. Until now the host answered every one of
 * those with undefined, so no published setting could reach it — including
 * `claudeCode.claudeProcessWrapper`, the one that decides which executable the
 * agent actually runs.
 *
 * These pin the lookup shape the extension uses, because getting it subtly
 * wrong fails the way an unseeded map does: silently, with the extension
 * falling back to its bundled binary and the panel looking fine while the agent
 * has none of the workspace's tooling.
 */

function configOf(settings: Record<string, unknown>) {
  const api = buildVscodeApi(createHostState('/ws', settings)) as {
    workspace: {
      getConfiguration: (section?: string) => {
        get: (key: string, fallback?: unknown) => unknown;
        has: (key: string) => boolean;
        update: (key: string, value: unknown) => Promise<void>;
      };
    };
  };
  return api.workspace.getConfiguration;
}

test('a section lookup finds a dotted key, which is how the extension asks', () => {
  const getConfiguration = configOf({
    'claudeCode.claudeProcessWrapper': '/usr/local/bin/claude-process-wrapper',
  });
  assert.equal(
    getConfiguration('claudeCode').get('claudeProcessWrapper'),
    '/usr/local/bin/claude-process-wrapper',
  );
});

test('an unseeded key still falls back, and reports itself absent', () => {
  const getConfiguration = configOf({});
  assert.equal(getConfiguration('claudeCode').get('claudeProcessWrapper'), undefined);
  assert.equal(getConfiguration('claudeCode').get('claudeProcessWrapper', 'fallback'), 'fallback');
  assert.equal(getConfiguration('claudeCode').has('claudeProcessWrapper'), false);
});

test('a seeded key reports itself present', () => {
  const getConfiguration = configOf({ 'claudeCode.claudeProcessWrapper': '/w' });
  assert.equal(getConfiguration('claudeCode').has('claudeProcessWrapper'), true);
});

test('no settings at all is still a usable configuration', () => {
  // createHostState is called without settings on every non-sidebar path.
  const getConfiguration = configOf({});
  assert.equal(getConfiguration(undefined).get('anything', 7), 7);
});

test('the extension can still write settings back', async () => {
  const getConfiguration = configOf({ 'claudeCode.claudeProcessWrapper': '/w' });
  await getConfiguration('claudeCode').update('autosave', true);
  assert.equal(getConfiguration('claudeCode').get('autosave'), true);
  // Seeded values survive an unrelated write.
  assert.equal(getConfiguration('claudeCode').get('claudeProcessWrapper'), '/w');
});

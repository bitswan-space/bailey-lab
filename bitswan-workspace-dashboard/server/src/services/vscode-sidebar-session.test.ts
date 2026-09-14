import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pageFor, sidebarWorkspaceFolder, webviewStateKey } from './vscode-sidebar.js';

/**
 * What makes a conversation findable again.
 *
 * Claude Code writes every conversation to
 * $CLAUDE_CONFIG_DIR/projects/<cwd with the slashes flattened>/<uuid>.jsonl,
 * and the extension lists a BP's history by reading that directory itself, in
 * the extension host — here, in the dashboard container. The CLI runs in the
 * coding-agent container, where the same clone is /workspace/copies/<copy>/<bp>
 * rather than the dashboard's /workspace/workspace/copies/<copy>/<bp>. Point
 * the host at its own spelling and it computes a different directory name,
 * finds nothing, and shows an empty history for a BP with a dozen
 * conversations in it — which is exactly what it did.
 *
 * The other half is the webview's own state: VS Code hands setState() back
 * through getState() after a reload, and without that the panel cold-starts
 * every time even when the extension still holds the session.
 */

test('the workspace folder is the path the agent container uses', () => {
  const previous = process.env.SIDEBAR_COPIES_ROOT;
  process.env.SIDEBAR_COPIES_ROOT = '/workspace/copies';
  try {
    assert.equal(
      sidebarWorkspaceFolder({ copy: 'ada-example-com', bp: 'bp', workspaceRoot: '/workspace/workspace' }),
      '/workspace/copies/ada-example-com/bp',
    );
  } finally {
    if (previous === undefined) delete process.env.SIDEBAR_COPIES_ROOT;
    else process.env.SIDEBAR_COPIES_ROOT = previous;
  }
});

test('without the shared mount it falls back to the dashboard tree', () => {
  const previous = process.env.SIDEBAR_COPIES_ROOT;
  delete process.env.SIDEBAR_COPIES_ROOT;
  try {
    // Standalone runs and the dev server have one container, so the two
    // spellings already agree and the fallback is correct there.
    assert.equal(
      sidebarWorkspaceFolder({ copy: 'ada-example-com', bp: 'bp', workspaceRoot: '/workspace/workspace' }),
      '/workspace/workspace/copies/ada-example-com/bp',
    );
  } finally {
    if (previous !== undefined) process.env.SIDEBAR_COPIES_ROOT = previous;
  }
});

test('webview state is keyed per user and per BP', () => {
  const ada = { email: 'ada@example.com', copy: 'ada-example-com', bp: 'bp' };
  assert.notEqual(webviewStateKey(ada), webviewStateKey({ ...ada, bp: 'bp2' }));
  assert.notEqual(webviewStateKey(ada), webviewStateKey({ ...ada, copy: 'other' }));
  assert.notEqual(webviewStateKey(ada), webviewStateKey({ ...ada, email: 'grace@example.com' }));
  assert.equal(webviewStateKey(ada), webviewStateKey({ ...ada }));
  // No raw email in something a browser stores and any script on the page
  // could read back.
  assert.ok(!webviewStateKey(ada).includes('ada@example.com'));
});

test('the page restores and saves webview state under that key', () => {
  const key = webviewStateKey({ email: 'ada@example.com', copy: 'c', bp: 'bp' });
  const page = pageFor('<html><head></head><body></body></html>', {
    assetBase: '/assets',
    extensionDir: '/nonexistent',
    stateKey: key,
  });
  assert.ok(page.includes(JSON.stringify(key)), 'the key must reach the page');
  assert.match(page, /localStorage\.getItem\(KEY\)/);
  assert.match(page, /localStorage\.setItem\(KEY/);
});

test('no key means the old in-memory behaviour, not a crash', () => {
  const page = pageFor('<html><head></head><body></body></html>', {
    assetBase: '/assets',
    extensionDir: '/nonexistent',
  });
  assert.ok(!page.includes('__bitswanSidebarStateKey ='));
  assert.match(page, /acquireVsCodeApi/);
});

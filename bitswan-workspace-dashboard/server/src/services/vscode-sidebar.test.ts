import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

/**
 * `sidebarEnabled` decides whether the Coding Agent tab is offered at all, and
 * it is now the only thing standing between a half-provisioned container and a
 * user staring at `{"error":"sidebar not available"}` rendered as the panel.
 *
 * The daemon sets CLAUDE_EXTENSION_PATH unconditionally and the container's
 * entrypoint downloads the extension into it, so "the variable is set" and
 * "there is an extension to serve" are genuinely different states — and the
 * window between them is a whole first-boot download wide. These pin that the
 * gate reports the second, not the first.
 */

const { sidebarEnabled, extensionPath } = await import('./vscode-sidebar.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-sidebar-'));

function withPath<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.CLAUDE_EXTENSION_PATH;
  if (value === undefined) delete process.env.CLAUDE_EXTENSION_PATH;
  else process.env.CLAUDE_EXTENSION_PATH = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_EXTENSION_PATH;
    else process.env.CLAUDE_EXTENSION_PATH = previous;
  }
}

test('off when no extension path is configured', () => {
  withPath(undefined, () => {
    assert.equal(extensionPath(), undefined);
    assert.equal(sidebarEnabled(), false);
  });
  withPath('', () => assert.equal(sidebarEnabled(), false));
});

test('off when the configured directory does not exist', () => {
  withPath(path.join(tmp, 'nothing-here'), () => {
    assert.equal(sidebarEnabled(), false);
  });
});

test('off while the directory exists but is still empty', () => {
  // The state during a first-boot download: the daemon mounted the volume and
  // set the variable, but the entrypoint has not finished unpacking. Claiming
  // availability here is what made /view 503 after status said it was ready.
  const empty = fs.mkdtempSync(path.join(tmp, 'empty-'));
  withPath(empty, () => assert.equal(sidebarEnabled(), false));
});

test('off when extension.js is a directory rather than a file', () => {
  const odd = fs.mkdtempSync(path.join(tmp, 'odd-'));
  fs.mkdirSync(path.join(odd, 'extension.js'));
  withPath(odd, () => assert.equal(sidebarEnabled(), false));
});

test('on once the extension is unpacked', () => {
  const ready = fs.mkdtempSync(path.join(tmp, 'ready-'));
  fs.writeFileSync(path.join(ready, 'extension.js'), '// the activated bundle');
  withPath(ready, () => assert.equal(sidebarEnabled(), true));
});

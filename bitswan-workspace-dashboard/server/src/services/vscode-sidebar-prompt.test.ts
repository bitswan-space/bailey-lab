import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seedInitialPrompt } from './vscode-sidebar.js';

const PAGE = '<html><body><pre id="claude-error"></pre><div id="root"></div></body></html>';

test('a seeded prompt lands on the element the webview reads at boot', () => {
  const html = seedInitialPrompt(PAGE, 'Write the audit report');
  assert.match(html, /<div id="root" data-initial-prompt="Write the audit report"/);
});

test('no prompt leaves the page untouched', () => {
  assert.equal(seedInitialPrompt(PAGE, undefined), PAGE);
  assert.equal(seedInitialPrompt(PAGE, '   '), PAGE);
});

test('a prompt cannot break out of the attribute it is written into', () => {
  const html = seedInitialPrompt(PAGE, '"><script>alert(1)</script><div x="');
  assert.ok(!html.includes('<script>alert(1)'));
  assert.match(html, /data-initial-prompt="&quot;&gt;&lt;script&gt;/);
});

test('an enormous prompt is cut rather than pasted whole into the page', () => {
  const html = seedInitialPrompt(PAGE, 'x'.repeat(20000));
  const seeded = /data-initial-prompt="(x+)"/.exec(html)?.[1] ?? '';
  assert.equal(seeded.length, 8 * 1024);
});

test('the prompt is seeded once per page, on the root element only', () => {
  const html = seedInitialPrompt(`${PAGE}<div id="root"></div>`, 'hello');
  assert.equal(html.match(/data-initial-prompt/g)?.length, 1);
});

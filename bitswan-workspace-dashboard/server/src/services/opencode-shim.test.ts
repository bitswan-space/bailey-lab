import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import {
  STORAGE_SHIM_SOURCE,
  WINDOW_STORAGE_PREFIX,
  cspAllowingShim,
  injectStorageShim,
  panelScopeFromName,
  scopedStorageKey,
  storageShimHash,
} from './opencode-shim.js';

/** A stand-in for the browser's Storage, enough for the shim to run on. */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

/** Run the shim against a fake window and return that window. */
function windowWithShim(name: string) {
  const storage = fakeStorage();
  const window: { name: string; localStorage: typeof storage } = { name, localStorage: storage };
  new Function('window', STORAGE_SHIM_SOURCE)(window);
  return { window, storage };
}

test('a panel scope comes from the iframe name, and only from a panel name', () => {
  assert.equal(panelScopeFromName('bitswan-opencode:alice-acme-com/orders'), 'alice-acme-com/orders');
  assert.equal(panelScopeFromName('bitswan-opencode:'), undefined);
  assert.equal(panelScopeFromName(''), undefined);
  assert.equal(panelScopeFromName('something-else'), undefined);
});

test('only window-scoped keys move, to a prefix of their own per scope', () => {
  assert.equal(
    scopedStorageKey(`${WINDOW_STORAGE_PREFIX}tabs`, 'alice/orders'),
    'opencode.window.alice/orders.dat:tabs',
  );
  assert.equal(scopedStorageKey('opencode.global.dat:theme', 'alice/orders'), 'opencode.global.dat:theme');
});

/**
 * The bug this file exists for: every OpenCode panel showed the tabs the
 * other panels had opened, because the web build keeps its tab strip under
 * one `opencode.window.browser.dat:` prefix for the whole origin.
 */
test('in a panel, the shim gives window-scoped keys a per-panel home and leaves the rest alone', () => {
  const { window, storage } = windowWithShim('bitswan-opencode:alice/orders');
  window.localStorage.setItem(`${WINDOW_STORAGE_PREFIX}tabs`, '["ses_1"]');
  window.localStorage.setItem('opencode.global.dat:theme', 'oc-2');
  assert.deepEqual(
    [...storage.map.keys()],
    ['opencode.window.alice/orders.dat:tabs', 'opencode.global.dat:theme'],
  );
  assert.equal(window.localStorage.getItem(`${WINDOW_STORAGE_PREFIX}tabs`), '["ses_1"]');
  assert.equal(window.localStorage.getItem('opencode.global.dat:theme'), 'oc-2');
  window.localStorage.removeItem(`${WINDOW_STORAGE_PREFIX}tabs`);
  assert.deepEqual([...storage.map.keys()], ['opencode.global.dat:theme']);
  assert.equal(window.localStorage.key(0), 'opencode.global.dat:theme');
  assert.equal(window.localStorage.length, 1);
});

test('two panels on one storage keep separate tabs', () => {
  const shared = fakeStorage();
  const a: { name: string; localStorage: typeof shared } = { name: 'bitswan-opencode:alice/orders', localStorage: shared };
  const b: { name: string; localStorage: typeof shared } = { name: 'bitswan-opencode:alice/invoices', localStorage: shared };
  new Function('window', STORAGE_SHIM_SOURCE)(a);
  new Function('window', STORAGE_SHIM_SOURCE)(b);
  a.localStorage.setItem(`${WINDOW_STORAGE_PREFIX}tabs`, '["ses_orders"]');
  assert.equal(b.localStorage.getItem(`${WINDOW_STORAGE_PREFIX}tabs`), null);
  b.localStorage.setItem(`${WINDOW_STORAGE_PREFIX}tabs`, '["ses_invoices"]');
  assert.equal(a.localStorage.getItem(`${WINDOW_STORAGE_PREFIX}tabs`), '["ses_orders"]');
});

test('outside a panel the shim does nothing', () => {
  const { window, storage } = windowWithShim('');
  window.localStorage.setItem(`${WINDOW_STORAGE_PREFIX}tabs`, 'x');
  assert.deepEqual([...storage.map.keys()], [`${WINDOW_STORAGE_PREFIX}tabs`]);
});

test('the shim is the first thing in <head>, once', () => {
  const html = '<!doctype html><html><head>\n<meta charset="utf-8"><script>theme()</script></head><body></body></html>';
  const out = injectStorageShim(html);
  assert.match(out, /<head><script id="bitswan-opencode-storage-shim">/);
  assert.equal(out.indexOf('bitswan-opencode-storage-shim') < out.indexOf('theme()'), true);
  assert.equal(injectStorageShim(out), out);
  assert.match(injectStorageShim('<p>no head</p>'), /^<script id="bitswan-opencode-storage-shim">/);
});

test('the CSP allowance is the hash of exactly what is inlined', () => {
  const expected = crypto.createHash('sha256').update(STORAGE_SHIM_SOURCE).digest('base64');
  assert.equal(storageShimHash(), expected);
  const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'sha256-abc='; style-src 'self'";
  const out = cspAllowingShim(csp);
  assert.equal(out, `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'sha256-abc=' 'sha256-${expected}'; style-src 'self'`);
  assert.equal(cspAllowingShim(out), out);
  assert.equal(cspAllowingShim("default-src 'self'"), "default-src 'self'");
  // The inlined source must never close the tag early.
  assert.equal(STORAGE_SHIM_SOURCE.includes('</script'), false);
});

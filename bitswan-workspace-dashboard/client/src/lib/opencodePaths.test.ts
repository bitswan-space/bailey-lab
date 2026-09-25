import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeBase64Url, isOpenCodeRoute, opencodePanelName, sessionPath } from './opencodePaths.ts';

const origin = 'https://ws-dashboard--inner.example.com';

test('the server key is base64url without padding, as OpenCode encodes it', () => {
  const key = encodeBase64Url(origin);
  assert.match(key, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(key, 'base64url').toString('utf8'), origin);
  // Padding would have been '=' and the standard alphabet would use '+' or '/'.
  assert.equal(encodeBase64Url('/workspace/copies/a/b?'), 'L3dvcmtzcGFjZS9jb3BpZXMvYS9iPw');
});

test('a conversation page is /server/<key>/session/<id>', () => {
  assert.equal(sessionPath(origin, 'ses_01ABC'), `/server/${encodeBase64Url(origin)}/session/ses_01ABC`);
});

test('the pages OpenCode’s router knows, other than home, are OpenCode’s', () => {
  assert.equal(isOpenCodeRoute(sessionPath(origin, 'ses_1')), true);
  assert.equal(isOpenCodeRoute('/settings'), true);
  assert.equal(isOpenCodeRoute('/connect'), true);
  assert.equal(isOpenCodeRoute('/new-session'), true);
  assert.equal(isOpenCodeRoute('/settings/'), true);
});

test('home and the dashboard’s own pages are not', () => {
  assert.equal(isOpenCodeRoute('/'), false);
  assert.equal(isOpenCodeRoute('/index.html'), false);
  assert.equal(isOpenCodeRoute(`/server/${encodeBase64Url(origin)}`), false);
  assert.equal(isOpenCodeRoute(`/server/${encodeBase64Url(origin)}/session`), false);
  assert.equal(isOpenCodeRoute('/server/not base64/session/ses_1'), false);
});

test('a panel is named after its BP, with the prefix the storage shim looks for', () => {
  assert.equal(opencodePanelName('alice-acme-com', 'orders'), 'bitswan-opencode:alice-acme-com/orders');
});

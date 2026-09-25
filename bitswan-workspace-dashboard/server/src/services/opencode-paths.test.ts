import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bpDirectory,
  classifyOpenCodePath,
  directoryParamsAllowed,
  isCrossSiteMutation,
  outboundHeaders,
} from './opencode-paths.js';

const dir = bpDirectory('alice-acme-com', 'orders');
// A server key: base64url of the origin the browser sees.
const key = Buffer.from('https://ws-dashboard--inner.example.com', 'utf8').toString('base64url');

test('the BP clone path is where the coding-agent container keeps it', () => {
  assert.equal(dir, '/workspace/copies/alice-acme-com/orders');
});

test('OpenCode pages, assets and API calls are told apart', () => {
  // The pages 2.0.16's router recognises, and nothing else.
  for (const p of [`/server/${key}/session/ses_01ABC`, '/settings', '/connect', '/new-session', '/settings/']) {
    assert.deepEqual(classifyOpenCodePath(p), { kind: 'document' }, p);
  }
  assert.deepEqual(classifyOpenCodePath('/_assets/index-abc.js'), { kind: 'asset' });
  assert.deepEqual(classifyOpenCodePath('/icons/prod/favicon.ico'), { kind: 'asset' });
  assert.deepEqual(classifyOpenCodePath('/site.webmanifest'), { kind: 'asset' });
  assert.deepEqual(classifyOpenCodePath('/openapi.json'), { kind: 'asset' });
  assert.deepEqual(classifyOpenCodePath('/api/session'), { kind: 'api' });
});

test('what is not OpenCode falls through to the dashboard', () => {
  for (const p of [
    '/', // OpenCode's home is the dashboard here
    '/index.html',
    '/assets/dashboard.js',
    '/somewhere',
    `/server/${key}`,
    `/server/${key}/session`,
    `/server/${key}/session/ses_1/extra`,
    `/server/${key}/other/ses_1`,
    '/server/not base64/session/ses_1',
  ]) {
    assert.deepEqual(classifyOpenCodePath(p), { kind: 'none' }, p);
  }
});

test('directory query parameters must stay inside the copies tree', () => {
  assert.equal(directoryParamsAllowed(`/api/session?directory=${encodeURIComponent(dir)}`), true);
  assert.equal(directoryParamsAllowed('/api/session'), true);
  // The UI names the server's own working directory — the copies root — as
  // its default location on every load, and sometimes no directory at all.
  assert.equal(directoryParamsAllowed('/api/location?location%5Bdirectory%5D='), true);
  assert.equal(directoryParamsAllowed('/api/provider?location%5Bdirectory%5D=%2Fworkspace%2Fcopies'), true);
  assert.equal(directoryParamsAllowed('/api/provider?directory=%2Fworkspace%2Fcopies%2F'), true);
  assert.equal(directoryParamsAllowed('/api/provider?directory=%2Fworkspace%2Fcopies-other'), false);
  assert.equal(directoryParamsAllowed('/api/session?directory=%2Fhome%2Fagent'), false);
  assert.equal(directoryParamsAllowed('/api/session?directory=%2Fworkspace%2Fcopies%2Fa%2F..%2F..%2Fetc'), false);
  assert.equal(
    directoryParamsAllowed(`/api/pty?location%5Bdirectory%5D=${encodeURIComponent('/etc')}`),
    false,
  );
  assert.equal(
    directoryParamsAllowed(`/api/pty?location%5Bdirectory%5D=${encodeURIComponent(dir)}`),
    true,
  );
});

/**
 * The gate re-applies the visitor's identity and live access token to every
 * request it forwards to the dashboard, and browsers add cookies. None of it
 * may reach the coding-agent container, where model-chosen code runs.
 */
test('forwarded headers are an allowlist: identity, tokens and cookies never cross', () => {
  const out = outboundHeaders(
    {
      host: 'ws-dashboard--inner.example.com',
      cookie: '_oauth2_proxy=abc',
      authorization: 'Bearer keycloak-token',
      'x-forwarded-email': 'alice@example.com',
      'x-forwarded-access-token': 'secret',
      'x-forwarded-groups': 'admins',
      'x-auth-request-email': 'alice@example.com',
      origin: 'https://ws-dashboard--inner.example.com',
      referer: 'https://ws-dashboard--inner.example.com/',
      accept: 'text/event-stream',
      'content-type': 'application/json',
      'last-event-id': '42',
      'x-opencode-directory': dir,
      'accept-encoding': ['gzip', 'br'],
    },
    { host: '127.0.0.1:43931', authorization: 'Basic b3BlbmNvZGU6cHc=' },
  );
  assert.deepEqual(out, {
    accept: 'text/event-stream',
    'content-type': 'application/json',
    'last-event-id': '42',
    'x-opencode-directory': dir,
    'accept-encoding': 'gzip, br',
    host: '127.0.0.1:43931',
    authorization: 'Basic b3BlbmNvZGU6cHc=',
  });
});

test('a cross-site state change is refused, reads and same-site calls are not', () => {
  assert.equal(isCrossSiteMutation('POST', 'cross-site'), true);
  assert.equal(isCrossSiteMutation('DELETE', 'cross-site'), true);
  assert.equal(isCrossSiteMutation('GET', 'cross-site'), false);
  assert.equal(isCrossSiteMutation('POST', 'same-origin'), false);
  assert.equal(isCrossSiteMutation('POST', undefined), false);
});

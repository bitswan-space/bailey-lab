import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from './api';
import { SessionExpiredError } from './session';

type Answer = { status: number; body: string; type?: string; opaque?: boolean };

function stubFetch(answers: Answer[]): { calls: string[] } {
  const calls: string[] = [];
  const queue = [...answers];
  (globalThis as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
    if (String(url).startsWith('/oauth2/auth')) {
      return new Response(null, { status: 200 });
    }
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const a = queue.shift() ?? answers[answers.length - 1]!;
    const r = new Response(a.body, {
      status: a.opaque ? 200 : a.status,
      headers: { 'content-type': a.type ?? 'application/json; charset=utf-8' },
    });
    if (a.opaque) Object.defineProperty(r, 'type', { value: 'opaqueredirect' });
    return r;
  };
  return { calls };
}

const save = () => api.copyFiles.save('alice-acme-com', 'bp/README.md', { content: '# hi\n' });

test('a save returns the server’s JSON', async () => {
  stubFetch([{ status: 200, body: '{"ok":true,"etag":{"mtimeMs":1,"size":5}}' }]);
  assert.deepEqual(await save(), { ok: true, etag: { mtimeMs: 1, size: 5 } });
});

test('a save keeps a 4xx JSON body instead of throwing', async () => {
  stubFetch([{ status: 409, body: '{"error":"conflict"}' }]);
  assert.deepEqual(await save(), { error: 'conflict' });
});

// The window right after a business process is created: Traefik is
// reconfiguring and answers in plain text. The GET helpers already retry it;
// a save used to hand the JSON parser's complaint to the user instead.
test('a save retries the workspace router’s plain-text 404, then succeeds', async () => {
  const { calls } = stubFetch([
    { status: 404, body: '404 page not found\n', type: 'text/plain' },
    { status: 200, body: '{"ok":true,"etag":{"mtimeMs":2,"size":5}}' },
  ]);
  assert.deepEqual(await save(), { ok: true, etag: { mtimeMs: 2, size: 5 } });
  assert.equal(calls.length, 2);
});

test('a save reports what a non-JSON answer said, not a parser error', async () => {
  stubFetch([{ status: 502, body: '<html><body>Bad Gateway</body></html>', type: 'text/html' }]);
  await assert.rejects(save(), (err: Error) => {
    assert.match(err.message, /HTTP 502/);
    assert.match(err.message, /text\/html/);
    assert.doesNotMatch(err.message, /JSON at position|Unexpected/);
    return true;
  });
});

test('a save on a dead session raises the session signal', async () => {
  stubFetch([{ status: 200, body: '', opaque: true }]);
  await assert.rejects(save(), SessionExpiredError);
});

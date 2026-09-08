import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gateSessionState } from './auth-token.ts';

/** A fetch that answers with one status, and records what it was asked. */
function fetchReturning(status: number): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const f = async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(null, { status });
  };
  return Object.assign(f as unknown as typeof fetch, { calls });
}

test('401 from the gate means signed out', () => {
  // The one answer that is evidence. `/oauth2/auth` is the gate's own
  // auth-check endpoint and returns this when it holds no session.
  return gateSessionState(fetchReturning(401)).then((s) =>
    assert.equal(s, 'signed-out'),
  );
});

test('it asks the gate, same-origin', async () => {
  // The whole reason this works where an /api call does not: /oauth2/auth
  // answers instead of redirecting to Keycloak on another origin.
  const f = fetchReturning(401);
  await gateSessionState(f);
  assert.deepEqual(f.calls, ['/oauth2/auth']);
});

test('a 2xx means the session is alive', async () => {
  assert.equal(await gateSessionState(fetchReturning(202)), 'alive');
  assert.equal(await gateSessionState(fetchReturning(200)), 'alive');
});

test('a network error is not evidence of being signed out', async () => {
  // The failure this test exists to prevent: reading a dropped request as
  // "your session expired" and sending the user off to sign in again when
  // nothing was wrong with their session.
  const boom: typeof fetch = () => Promise.reject(new Error('network down'));
  assert.equal(await gateSessionState(boom), 'unknown');
});

test('nor is any other error status', async () => {
  // 502 from a proxy in front, 403, an HTML captive-portal page with a 200 —
  // none of these say the gate lost the session.
  for (const status of [403, 500, 502, 503]) {
    assert.equal(
      await gateSessionState(fetchReturning(status)),
      'unknown',
      `status ${status}`,
    );
  }
});

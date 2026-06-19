// api.test.js — exercises every helper + endpoint wrapper in api.js with a
// mocked fetch (success, error-body shapes, NDJSON streaming, form encoding).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SC_API, installFetch } from './harness.js';

const { getJSON, postJSON, postForm, postFormExpectStatus, postNDJSON, Api, ApiError } = SC_API;

describe('ApiError', () => {
  it('carries status + path', () => {
    const e = new ApiError('boom', 503, '/p');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ApiError');
    expect(e.status).toBe(503);
    expect(e.path).toBe('/p');
  });
});

describe('getJSON', () => {
  it('parses a JSON body', async () => {
    installFetch({ '/x': { json: { hi: 1 } } });
    expect(await getJSON('/x')).toEqual({ hi: 1 });
  });
  it('returns null for an empty body', async () => {
    installFetch({ '/x': { text: '' } });
    expect(await getJSON('/x')).toBeNull();
  });
  it('throws ApiError with {error} message on non-2xx', async () => {
    installFetch({ '/x': { status: 500, json: { error: 'kaboom' } } });
    await expect(getJSON('/x')).rejects.toMatchObject({ name: 'ApiError', status: 500, message: 'kaboom' });
  });
  it('throws on a non-2xx plain-text body', async () => {
    installFetch({ '/x': { status: 403, text: 'forbidden zone' } });
    await expect(getJSON('/x')).rejects.toMatchObject({ status: 403, message: 'forbidden zone' });
  });
  it('falls back to status text when body is HTML', async () => {
    installFetch({ '/x': { status: 401, text: '<html>redirect</html>' } });
    await expect(getJSON('/x')).rejects.toMatchObject({ status: 401, message: '401 Error' });
  });
  it('throws on invalid JSON in a 2xx body', async () => {
    installFetch({ '/x': { text: 'not json' } });
    await expect(getJSON('/x')).rejects.toMatchObject({ message: 'invalid JSON from /x' });
  });
  it('truncates a long plain-text error to 200 chars', async () => {
    const long = 'e'.repeat(500);
    installFetch({ '/x': { status: 400, text: long } });
    await expect(getJSON('/x')).rejects.toMatchObject({ message: 'e'.repeat(200) });
  });
  it('handles a malformed {error} JSON body gracefully', async () => {
    installFetch({ '/x': { status: 400, text: '{bad json' } });
    await expect(getJSON('/x')).rejects.toMatchObject({ status: 400, message: '{bad json' });
  });
});

describe('postJSON / postForm', () => {
  it('posts JSON and parses the response', async () => {
    const f = installFetch({ '/p': { json: { ok: true } } });
    expect(await postJSON('/p', { a: 1 })).toEqual({ ok: true });
    const [, init] = f.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect(init.headers['Content-Type']).toBe('application/json');
  });
  it('postJSON defaults the body to {} when omitted', async () => {
    const f = installFetch({ '/p': { json: {} } });
    await postJSON('/p');
    expect(f.mock.calls[0][1].body).toBe('{}');
  });
  it('postForm url-encodes the fields', async () => {
    const f = installFetch({ '/p': { json: { ok: 1 } } });
    await postForm('/p', { id: 'abc', n: '2' });
    const [, init] = f.mock.calls[0];
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.body).toBe('id=abc&n=2');
  });
  it('postForm tolerates a missing fields object', async () => {
    const f = installFetch({ '/p': { json: {} } });
    await postForm('/p');
    expect(f.mock.calls[0][1].body).toBe('');
  });
});

describe('postFormExpectStatus', () => {
  it('resolves the raw response on 2xx', async () => {
    installFetch({ '/2fa-gate/approve': { status: 200, text: '<html>ok</html>' } });
    const res = await postFormExpectStatus('/2fa-gate/approve', { email: 'a@b', code: 'X' });
    expect(res.ok).toBe(true);
  });
  it('throws ApiError on a non-2xx (e.g. 401 mismatch)', async () => {
    installFetch({ '/2fa-gate/approve': { status: 401, json: { error: 'mismatch' } } });
    await expect(postFormExpectStatus('/2fa-gate/approve', {})).rejects.toMatchObject({ status: 401, message: 'mismatch' });
  });
});

describe('postNDJSON', () => {
  it('streams events, calls onEvent per line, returns the last event', async () => {
    installFetch({ '/s': { ndjson: [{ event: 'start', message: 'a' }, { event: 'log', message: 'b' }, { event: 'done' }] } });
    const seen = [];
    const last = await postNDJSON('/s', {}, (e) => seen.push(e.event));
    expect(seen).toEqual(['start', 'log', 'done']);
    expect(last).toEqual({ event: 'done' });
  });
  it('throws ApiError when a line is event:error', async () => {
    installFetch({ '/s': { ndjson: [{ event: 'start' }, { event: 'error', error: 'broke' }] } });
    await expect(postNDJSON('/s', {})).rejects.toMatchObject({ name: 'ApiError', message: 'broke' });
  });
  it('throws when the initial response is not ok', async () => {
    installFetch({ '/s': { status: 500, json: { error: 'no stream' } } });
    await expect(postNDJSON('/s', {})).rejects.toMatchObject({ status: 500, message: 'no stream' });
  });
  it('returns {event:done} when there is no streaming body', async () => {
    installFetch({ '/s': { status: 200, noBody: true } });
    expect(await postNDJSON('/s', {})).toEqual({ event: 'done' });
  });
  it('skips malformed JSON lines and blank lines', async () => {
    installFetch({ '/s': { streamText: '\nnot-json\n{"event":"done"}\n' } });
    const last = await postNDJSON('/s', {});
    expect(last).toEqual({ event: 'done' });
  });
  it('returns {event:done} fallback when stream yields no events', async () => {
    installFetch({ '/s': { streamText: '\n\n' } });
    expect(await postNDJSON('/s', {})).toEqual({ event: 'done' });
  });
});

describe('Api endpoint wrappers', () => {
  beforeEach(() => {
    // A catch-all router returning a benign JSON object for any GET/POST.
    installFetch({});
    global.fetch = vi.fn(() => Promise.resolve({
      ok: true, status: 200, statusText: 'OK',
      text: () => Promise.resolve('{}'), json: () => Promise.resolve({}), body: null,
    }));
    window.fetch = global.fetch;
  });

  it('routes each wrapper to its backend path', async () => {
    await Api.whoami();
    await Api.gateState();
    await Api.claim();
    await Api.pendingPair();
    await Api.pendingPairPoll();
    await Api.selfTrust('123456');
    await Api.recover({ totp: '123456' });
    await Api.totpEnroll();
    await Api.totpVerify('123456');
    await Api.regenerateBackupCodes();
    await Api.devices();
    await Api.removeDevice('d1');
    await Api.approvals();
    await Api.endpoints();
    await Api.workspaces();
    await Api.trashWorkspace('ws one');
    await Api.restoreWorkspace('ws one');
    await Api.notificationsCount();
    await Api.overview();
    await Api.people();
    await Api.adminDevices();
    await Api.adminRemoveDevice('a@b', 'd1');
    await Api.adminNetworkMap();
    await Api.adminDefaultImages();
    await Api.setAdminDefaultImages({ x: 1 });

    const paths = global.fetch.mock.calls.map((c) => c[0]);
    expect(paths).toContain('/bailey/api/whoami');
    expect(paths).toContain('/bailey/api/gate-state');
    expect(paths).toContain('/bailey/api/self-trust');
    // encodeURIComponent applied to the workspace name in the path.
    expect(paths).toContain('/bailey/api/workspaces/ws%20one/trash');
    expect(paths).toContain('/bailey/api/workspaces/ws%20one/restore');
    expect(paths).toContain('/bailey/api/admin/default-images');
  });

  it('approvePair posts to the gate approve handler (form, status-only)', async () => {
    const f = installFetch({ '/2fa-gate/approve': { status: 200, text: 'ok' } });
    await Api.approvePair('a@b', 'CODE1234');
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('/2fa-gate/approve');
    expect(init.body).toContain('email=a%40b');
    expect(init.body).toContain('code=CODE1234');
  });

  it('createWorkspace streams NDJSON to the workspaces endpoint', async () => {
    installFetch({ '/bailey/api/workspaces': { ndjson: [{ event: 'done' }] } });
    const last = await Api.createWorkspace('demo', () => {});
    expect(last).toEqual({ event: 'done' });
  });

  it('updateWorkspace + emptyTrash stream NDJSON', async () => {
    installFetch({
      '/bailey/api/workspaces/demo/update': { ndjson: [{ event: 'done' }] },
      '/bailey/api/workspaces/empty-trash': { ndjson: [{ event: 'done' }] },
    });
    expect(await Api.updateWorkspace('demo', () => {})).toEqual({ event: 'done' });
    expect(await Api.emptyTrash(() => {})).toEqual({ event: 'done' });
  });

  it('invite posts to the invite endpoint', async () => {
    const f = installFetch({ '/bailey/api/people/invite': { status: 501, json: { error: 'nope' } } });
    await expect(Api.invite('a@b', 'member')).rejects.toMatchObject({ status: 501 });
    expect(f.mock.calls[0][0]).toBe('/bailey/api/people/invite');
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerWorkspaceSettingsRoutes } from './workspace-settings.js';
import type { GitopsClient } from '../services/gitops.js';

const VIEW = {
  url: null,
  public_key: 'ssh-ed25519 AAAA test',
  fingerprint: 'SHA256:abc',
  status: { result: 'unconfigured', branches: {} },
};

function buildApp(
  roles: Record<string, 'admin' | 'auditor' | 'member'>,
  upstream: { ok: boolean; status: number; body: unknown } = { ok: true, status: 200, body: VIEW },
) {
  const calls: Array<{ method: string; url?: string }> = [];
  const gitops = {
    async userRole(email: string) {
      return roles[email] ?? 'member';
    },
    async gitRemote() {
      calls.push({ method: 'get' });
      return upstream;
    },
    async gitRemoteSet(url: string) {
      calls.push({ method: 'set', url });
      return upstream;
    },
    async gitRemoteClear() {
      calls.push({ method: 'clear' });
      return upstream;
    },
    async gitRemotePush() {
      calls.push({ method: 'push' });
      return upstream;
    },
    // eslint-disable-next-line no-restricted-syntax -- minimal test double for the wide GitopsClient class
  } as unknown as GitopsClient;
  const app = Fastify({ logger: false });
  registerWorkspaceSettingsRoutes(app, { gitops });
  return { app, calls };
}

const URL = '/api/workspace/git-remote';
const ADMIN = { 'x-forwarded-email': 'alice@acme.com' };
const MEMBER = { 'x-forwarded-email': 'bob@acme.com' };
const ROLES = { 'alice@acme.com': 'admin', 'bob@acme.com': 'member' } as const;

test('an admin reads the git remote view, uncached', async () => {
  const { app, calls } = buildApp(ROLES);
  const res = await app.inject({ method: 'GET', url: URL, headers: ADMIN });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(res.json(), VIEW);
  assert.deepEqual(calls, [{ method: 'get' }]);
  await app.close();
});

test('a member is refused before gitops is asked', async () => {
  const { app, calls } = buildApp(ROLES);
  const res = await app.inject({ method: 'GET', url: URL, headers: MEMBER });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.json(), { error: 'admin only' });
  assert.equal(calls.length, 0);
  await app.close();
});

test('no verified identity fails closed', async () => {
  const { app, calls } = buildApp(ROLES);
  const res = await app.inject({ method: 'GET', url: URL });
  assert.equal(res.statusCode, 401);
  assert.equal(calls.length, 0);
  await app.close();
});

test('saving forwards the trimmed url and rejects an empty one', async () => {
  const { app, calls } = buildApp(ROLES);
  const ok = await app.inject({
    method: 'PUT',
    url: URL,
    headers: ADMIN,
    payload: { url: ' git@github.com:acme/ws.git ' },
  });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(calls, [{ method: 'set', url: 'git@github.com:acme/ws.git' }]);
  const empty = await app.inject({ method: 'PUT', url: URL, headers: ADMIN, payload: {} });
  assert.equal(empty.statusCode, 400);
  assert.equal(calls.length, 1);
  await app.close();
});

test("gitops's own rejection reaches the client with its message", async () => {
  const { app } = buildApp(ROLES, {
    ok: false,
    status: 400,
    body: { detail: 'Only SSH remotes are supported' },
  });
  const res = await app.inject({
    method: 'PUT',
    url: URL,
    headers: ADMIN,
    payload: { url: 'https://github.com/acme/ws.git' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().body.detail, 'Only SSH remotes are supported');
  await app.close();
});

test('clearing and pushing each call gitops once, admin only', async () => {
  const { app, calls } = buildApp(ROLES);
  assert.equal((await app.inject({ method: 'DELETE', url: URL, headers: ADMIN })).statusCode, 200);
  assert.equal(
    (await app.inject({ method: 'POST', url: `${URL}/push`, headers: ADMIN })).statusCode,
    200,
  );
  assert.deepEqual(calls, [{ method: 'clear' }, { method: 'push' }]);
  assert.equal(
    (await app.inject({ method: 'POST', url: `${URL}/push`, headers: MEMBER })).statusCode,
    403,
  );
  assert.equal(calls.length, 2);
  await app.close();
});

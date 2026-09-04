import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerAuditRoutes } from './audits.js';
import type { GitopsClient } from '../services/gitops.js';

type Call = { path: string; method: string; body: unknown; query?: Record<string, string> };

function buildApp(
  roles: Record<string, 'admin' | 'auditor' | 'member'> = {},
  answer: { ok: boolean; status: number; body: unknown } = {
    ok: true,
    status: 200,
    body: { ready: true },
  },
) {
  const calls: Call[] = [];
  const gitops = {
    async userRole(email: string) {
      return roles[email] ?? 'member';
    },
    async auditEnv(
      _bp: string,
      path: string,
      init?: { method?: string; body?: unknown; query?: Record<string, string> },
    ) {
      calls.push({
        path,
        method: init?.method ?? 'GET',
        body: init?.body ?? null,
        ...(init?.query ? { query: init.query } : {}),
      });
      return answer;
    },
    // eslint-disable-next-line no-restricted-syntax -- minimal test double for the wide GitopsClient class
  } as unknown as GitopsClient;
  const app = Fastify({ logger: false });
  registerAuditRoutes(app, { gitops });
  return { app, calls };
}

const AUDITOR = { 'x-forwarded-email': 'auditor@acme.com' };
const MEMBER = { 'x-forwarded-email': 'member@acme.com' };
const ROLES = { 'auditor@acme.com': 'auditor' as const, 'member@acme.com': 'member' as const };

test('the audit environment and its source are readable by anyone who can open the tab', async () => {
  const { app, calls } = buildApp(ROLES);
  for (const [url, path] of [
    ['/api/audits/orders/env', ''],
    ['/api/audits/orders/files', '/files'],
    ['/api/audits/orders/diff', '/diff'],
    ['/api/audits/orders/report', '/report'],
  ] as const) {
    const res = await app.inject({ method: 'GET', url, headers: MEMBER });
    assert.equal(res.statusCode, 200, `${url} → ${res.statusCode}`);
    assert.equal(calls.at(-1)?.path, path);
    assert.equal(calls.at(-1)?.method, 'GET');
  }
  await app.close();
});

test('a file and a search carry their arguments through', async () => {
  const { app, calls } = buildApp(ROLES);
  await app.inject({
    method: 'GET',
    url: '/api/audits/orders/file-content?path=vendors/ares.py',
    headers: MEMBER,
  });
  assert.deepEqual(calls.at(-1)?.query, { path: 'vendors/ares.py' });
  await app.inject({ method: 'GET', url: '/api/audits/orders/search?q=vat', headers: MEMBER });
  assert.deepEqual(calls.at(-1)?.query, { q: 'vat' });
  await app.close();
});

test('a file read with no path is refused before it reaches gitops', async () => {
  const { app, calls } = buildApp(ROLES);
  const res = await app.inject({
    method: 'GET',
    url: '/api/audits/orders/file-content',
    headers: MEMBER,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
  await app.close();
});

test('an empty search answers with nothing rather than asking gitops', async () => {
  const { app, calls } = buildApp(ROLES);
  const res = await app.inject({
    method: 'GET',
    url: '/api/audits/orders/search?q=%20',
    headers: MEMBER,
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { matches: [], truncated: false });
  assert.equal(calls.length, 0);
  await app.close();
});

// Writing the report and running the agent are compliance controls, gated the
// same way freezing staging and signing off are.
test('a member may not write the report or run the agent', async () => {
  const { app, calls } = buildApp(ROLES);
  const write = await app.inject({
    method: 'PUT',
    url: '/api/audits/orders/report',
    headers: MEMBER,
    payload: { content: '# mine' },
  });
  assert.equal(write.statusCode, 403);
  const draft = await app.inject({
    method: 'POST',
    url: '/api/audits/orders/draft',
    headers: MEMBER,
    payload: {},
  });
  assert.equal(draft.statusCode, 403);
  assert.equal(calls.length, 0);
  await app.close();
});

test('an auditor writes the report, attributed to the gate identity', async () => {
  const { app, calls } = buildApp(ROLES);
  const res = await app.inject({
    method: 'PUT',
    url: '/api/audits/orders/report',
    headers: AUDITOR,
    payload: { content: '# Findings\n', by: 'mallory@acme.com' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.at(-1)?.method, 'PUT');
  assert.deepEqual(calls.at(-1)?.body, { content: '# Findings\n', by: 'auditor@acme.com' });
  await app.close();
});

test('the agent runs for an auditor, with their prompt and their identity', async () => {
  const { app, calls } = buildApp(ROLES);
  const res = await app.inject({
    method: 'POST',
    url: '/api/audits/orders/draft',
    headers: AUDITOR,
    payload: { prompt: 'focus on the VAT change' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.at(-1)?.body, {
    prompt: 'focus on the VAT change',
    by: 'auditor@acme.com',
  });
  await app.close();
});

test('a report write with no content is refused', async () => {
  const { app } = buildApp(ROLES);
  const res = await app.inject({
    method: 'PUT',
    url: '/api/audits/orders/report',
    headers: AUDITOR,
    payload: {},
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('an unfrozen business process keeps gitops’ 409 rather than becoming a 502', async () => {
  const { app } = buildApp(ROLES, {
    ok: false,
    status: 409,
    body: { detail: 'Staging is not frozen for this business process' },
  });
  const res = await app.inject({ method: 'GET', url: '/api/audits/orders/env', headers: MEMBER });
  assert.equal(res.statusCode, 409);
  assert.match(JSON.stringify(res.json()), /not frozen/);
  await app.close();
});

test('a gitops 5xx is reported as a bad gateway, not passed through', async () => {
  const { app } = buildApp(ROLES, { ok: false, status: 500, body: { detail: 'boom' } });
  const res = await app.inject({ method: 'GET', url: '/api/audits/orders/env', headers: MEMBER });
  assert.equal(res.statusCode, 502);
  await app.close();
});

test('an invalid business process never reaches gitops', async () => {
  const { app, calls } = buildApp(ROLES);
  const res = await app.inject({
    method: 'GET',
    url: '/api/audits/..%2fetc/env',
    headers: MEMBER,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
  await app.close();
});

test('with no gitops configured the audit surface says so', async () => {
  const app = Fastify({ logger: false });
  registerAuditRoutes(app, { gitops: null });
  const res = await app.inject({ method: 'GET', url: '/api/audits/orders/env', headers: MEMBER });
  assert.equal(res.statusCode, 503);
  await app.close();
});

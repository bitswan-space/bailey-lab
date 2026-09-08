import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerAuditRoutes } from './audits.js';
import type { GitopsClient } from '../services/gitops.js';

function buildApp(answer: { ok: boolean; status: number; body: unknown }) {
  const calls: string[] = [];
  const gitops = {
    async auditState(bp: string) {
      calls.push(`state ${bp}`);
      return answer;
    },
    async openAudit(bp: string) {
      calls.push(`open ${bp}`);
      return answer;
    },
    // eslint-disable-next-line no-restricted-syntax -- minimal test double for the wide GitopsClient class
  } as unknown as GitopsClient;
  const app = Fastify({ logger: false });
  registerAuditRoutes(app, { gitops });
  return { app, calls };
}

const OK = { ok: true, status: 200, body: { frozen: true, name: 'audit-abc12345-ab12cd' } };
const AUDITOR = { 'x-forwarded-email': 'auditor@acme.com' };

test('reading the audit state asks gitops and answers with it', async () => {
  const { app, calls } = buildApp(OK);
  const res = await app.inject({ method: 'GET', url: '/api/audits/orders/copy', headers: AUDITOR });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), OK.body);
  assert.deepEqual(calls, ['state orders']);
  await app.close();
});

test('opening an audit asks gitops to open it', async () => {
  const { app, calls } = buildApp(OK);
  const res = await app.inject({ method: 'POST', url: '/api/audits/orders/copy', headers: AUDITOR });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, ['open orders']);
  await app.close();
});

// gitops decides who may audit and whether there is anything to audit; the
// dashboard must carry its answer rather than flatten it into a 502.
test('a refusal from gitops reaches the user unchanged', async () => {
  for (const [status, detail] of [
    [403, 'Opening an audit requires an admin or auditor role.'],
    [409, 'Staging is not frozen for this business process'],
  ] as const) {
    const { app } = buildApp({ ok: false, status, body: { detail } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/audits/orders/copy',
      headers: AUDITOR,
    });
    assert.equal(res.statusCode, status);
    assert.match(JSON.stringify(res.json()), new RegExp(detail.slice(0, 20)));
    await app.close();
  }
});

test('a gitops 5xx is reported as a bad gateway', async () => {
  const { app } = buildApp({ ok: false, status: 500, body: { detail: 'boom' } });
  const res = await app.inject({ method: 'GET', url: '/api/audits/orders/copy', headers: AUDITOR });
  assert.equal(res.statusCode, 502);
  await app.close();
});

test('an invalid business process never reaches gitops', async () => {
  const { app, calls } = buildApp(OK);
  const res = await app.inject({
    method: 'GET',
    url: '/api/audits/..%2fetc/copy',
    headers: AUDITOR,
  });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(calls, []);
  await app.close();
});

test('with no gitops configured the audit surface says so', async () => {
  const app = Fastify({ logger: false });
  registerAuditRoutes(app, { gitops: null });
  const res = await app.inject({ method: 'GET', url: '/api/audits/orders/copy', headers: AUDITOR });
  assert.equal(res.statusCode, 503);
  await app.close();
});

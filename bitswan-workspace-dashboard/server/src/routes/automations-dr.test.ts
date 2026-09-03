import assert from 'node:assert/strict';
import os from 'node:os';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerAutomationRoutes } from './automations.js';
import type { GitopsClient } from '../services/gitops.js';

/**
 * POST …/dr/tests records compliance evidence, so it must (a) attribute the
 * entry to the identity the Bailey gate verified — never a client-supplied
 * `by` — and (b) be role-gated like PUT …/dr/policy (admin/auditor only).
 * Regression tests for issue #133.
 */

type DrTestPayload = { by?: string; note?: string; snapshot?: string };

function buildApp(roles: Record<string, 'admin' | 'auditor' | 'member'>) {
  const recorded: Array<{ bp: string; payload: DrTestPayload }> = [];
  const gitops = {
    async userRole(email: string) {
      return roles[email] ?? 'member';
    },
    async recordDrTest(bp: string, payload: DrTestPayload) {
      recorded.push({ bp, payload });
      return { ok: true, status: 200, body: { policy: 'quarterly', tests: [] } };
    },
    // eslint-disable-next-line no-restricted-syntax -- minimal test double for the wide GitopsClient class
  } as unknown as GitopsClient;
  const app = Fastify({ logger: false });
  registerAutomationRoutes(app, { gitops, workspaceRoot: os.tmpdir() });
  return { app, recorded };
}

const URL = '/api/automations/business-processes/orders/dr/tests';

test('DR test attribution comes from the gate identity, ignoring body `by`', async () => {
  const { app, recorded } = buildApp({ 'alice@acme.com': 'admin' });
  const res = await app.inject({
    method: 'POST',
    url: URL,
    headers: { 'x-forwarded-email': 'alice@acme.com' },
    payload: { by: 'mallory@acme.com', note: 'n', snapshot: 'snap-1' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.payload.by, 'alice@acme.com');
  assert.equal(recorded[0]?.payload.note, 'n');
  assert.equal(recorded[0]?.payload.snapshot, 'snap-1');
  await app.close();
});

test('a member may not record a DR test (403, nothing written)', async () => {
  const { app, recorded } = buildApp({ 'bob@acme.com': 'member' });
  const res = await app.inject({
    method: 'POST',
    url: URL,
    headers: { 'x-forwarded-email': 'bob@acme.com' },
    payload: { note: 'n', snapshot: 'snap-1' },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(recorded.length, 0);
  await app.close();
});

test('an auditor may record a DR test (same gate as PUT …/dr/policy)', async () => {
  const { app, recorded } = buildApp({ 'carol@acme.com': 'auditor' });
  const res = await app.inject({
    method: 'POST',
    url: URL,
    headers: { 'x-forwarded-email': 'carol@acme.com' },
    payload: { snapshot: 'snap-2' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.payload.by, 'carol@acme.com');
  await app.close();
});

test('no verified identity fails closed (role defaults to member → 403)', async () => {
  const { app, recorded } = buildApp({});
  const res = await app.inject({
    method: 'POST',
    url: URL,
    payload: { by: 'mallory@acme.com', snapshot: 'snap-1' },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(recorded.length, 0);
  await app.close();
});

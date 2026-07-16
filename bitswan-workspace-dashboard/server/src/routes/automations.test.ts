import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerAutomationRoutes } from './automations.js';
import type { GitopsClient } from '../services/gitops.js';

/**
 * POST /api/automations/promote — `deployed_by` attribution must come from
 * the authenticated identity (the gate's X-Forwarded-Email header), never
 * from the request body. A body-supplied value would let a member forge the
 * production deploy audit trail (#132).
 */

type PromoteDeployInput = Parameters<GitopsClient['promoteDeploy']>[1];

function buildApp() {
  const calls: { deploymentId: string; input: PromoteDeployInput }[] = [];
  const gitops = {
    promoteDeploy: async (deploymentId: string, input: PromoteDeployInput) => {
      calls.push({ deploymentId, input });
      return { ok: true, status: 200, body: { ok: true } };
    },
  } as unknown as GitopsClient;
  const app = Fastify({ logger: false });
  registerAutomationRoutes(app, { gitops });
  return { app, calls };
}

const promoteBody = {
  automation_name: 'my-automation',
  context: 'my-bp',
  stage: 'production',
  checksum: 'abc123',
  relative_path: 'my-bp/my-automation',
};

test('promote ignores body deployed_by and uses the token identity', async () => {
  const { app, calls } = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/api/automations/promote',
    headers: { 'x-forwarded-email': 'alice@acme.com' },
    payload: { ...promoteBody, deployed_by: 'forged-ceo@acme.com' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input.deployed_by, 'alice@acme.com');
  await app.close();
});

test('promote without an authenticated identity sends no deployed_by', async () => {
  const { app, calls } = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/api/automations/promote',
    payload: { ...promoteBody, deployed_by: 'forged-ceo@acme.com' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0] && !('deployed_by' in calls[0].input));
  await app.close();
});

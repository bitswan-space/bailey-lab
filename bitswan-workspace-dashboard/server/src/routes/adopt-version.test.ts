import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import {
  experimentNameFromTitle,
  parkedWorkTitle,
  registerCopyRoutes,
} from './copies.js';
import type { GitopsClient } from '../services/gitops.js';

/**
 * The BFF's half of "take this version wholesale".
 *
 * gitops owns the git and re-checks everything, so what is worth pinning here
 * is what the BFF ALONE decides: that the copy being written to is the
 * caller's own (derived from the gate identity, never from the URL), that the
 * attribution is the verified email rather than anything the client sent, and
 * that the experiment a park creates gets a name and a title that a person
 * will still understand in the Advanced menu three weeks later.
 */

type Recorded = { path: string; args: unknown[] };

function buildApp() {
  const calls: Recorded[] = [];
  const gitops = {
    async copyNameBudget() {
      return { ok: true, status: 200, body: { max_length: 40 } };
    },
    async adoptVersion(name: string, body: unknown) {
      calls.push({ path: 'adopt', args: [name, body] });
      return { ok: true, status: 200, body: { adopted: 'main' } };
    },
    async revertDevToVersion(bp: string, body: unknown) {
      calls.push({ path: 'revert-dev', args: [bp, body] });
      return { ok: true, status: 200, body: { status: 'success' } };
    },
    async deployOverMain(name: string, body: unknown) {
      calls.push({ path: 'deploy-over-main', args: [name, body] });
      return { ok: true, status: 200, body: { status: 'success' } };
    },
    async deployOverMainPreview(name: string, bp: string) {
      calls.push({ path: 'preview', args: [name, bp] });
      return { ok: true, status: 200, body: { blocked: false, superseded: [] } };
    },
    // eslint-disable-next-line no-restricted-syntax -- minimal test double for the wide GitopsClient class
  } as unknown as GitopsClient;
  const app = Fastify({ logger: false });
  registerCopyRoutes(app, { gitops });
  return { app, calls };
}

// `copyNameForEmail` turns this into `alice-acme-com`.
const ALICE = 'alice@acme.com';
const ALICE_COPY = 'alice-acme-com';

test('a version is adopted into the caller’s own copy, never a named one', async () => {
  const { app, calls } = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/api/copies/bob-acme-com/adopt',
    headers: { 'x-forwarded-email': ALICE },
    payload: { bp: 'compost', source: 'main' },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(calls.length, 0);
  await app.close();
});

test('the parked experiment is attributed to the verified identity', async () => {
  const { app, calls } = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: `/api/copies/${ALICE_COPY}/adopt`,
    headers: { 'x-forwarded-email': ALICE },
    payload: {
      bp: 'compost',
      source: 'main',
      bpLabel: 'Compost',
      deployer: 'mallory@acme.com',
    },
  });
  assert.equal(res.statusCode, 200);
  const body = calls[0]?.args[1] as {
    deployer: string;
    park_title: string;
    bp_label: string;
  };
  assert.equal(body.deployer, ALICE);
  assert.match(body.park_title, /^My previous Compost work — /);
  // gitops stores directory slugs; everything a person reads goes through the
  // display name, so it has to travel with the request.
  assert.equal(body.bp_label, 'Compost');
  await app.close();
});

test('a source the primitive does not have is refused before gitops is called', async () => {
  const { app, calls } = buildApp();
  for (const payload of [
    { bp: 'compost', source: 'whatever' },
    { bp: 'compost', source: 'experiment' }, // no experiment named
    { bp: 'compost', source: 'commit' }, // no commit named
    { source: 'main' }, // no bp
  ]) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/copies/${ALICE_COPY}/adopt`,
      headers: { 'x-forwarded-email': ALICE },
      payload,
    });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
  assert.equal(calls.length, 0);
  await app.close();
});

test('the park title names the business process the way the user sees it', () => {
  const at = new Date('2026-08-07T14:32:09Z');
  assert.equal(
    parkedWorkTitle('Compost', at),
    'My previous Compost work — 2026-08-07 14:32',
  );
  // Two parks on the same process on the same day are told apart by the time,
  // and their generated names differ regardless (the random suffix).
  const a = experimentNameFromTitle(parkedWorkTitle('Compost', at), 40);
  const b = experimentNameFromTitle(parkedWorkTitle('Compost', at), 40);
  assert.notEqual(a, b);
  for (const name of [a, b]) {
    assert.ok(name.length <= 40, name);
    assert.match(name, /^[a-zA-Z0-9][a-zA-Z0-9-]*$/);
    assert.ok(!name.includes('-copy-'), name);
  }
});

test('reverting dev is attributed to the gate identity and needs a commit', async () => {
  const { app, calls } = buildApp();
  const missing = await app.inject({
    method: 'POST',
    url: '/api/copies/main/bp/compost/revert-dev',
    headers: { 'x-forwarded-email': ALICE },
    payload: {},
  });
  assert.equal(missing.statusCode, 400);

  const res = await app.inject({
    method: 'POST',
    url: '/api/copies/main/bp/compost/revert-dev',
    headers: { 'x-forwarded-email': ALICE },
    payload: { commit: '8b52ad1', bpLabel: 'Compost', deployer: 'mallory@acme.com' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls[0]?.args, [
    'compost',
    { commit: '8b52ad1', bp_label: 'Compost', deployer: ALICE },
  ]);
  await app.close();
});

test('only your own copy can be published over main, and no mode travels with it', async () => {
  const { app, calls } = buildApp();
  const other = await app.inject({
    method: 'POST',
    url: '/api/copies/bob-acme-com/deploy-over-main',
    headers: { 'x-forwarded-email': ALICE },
    payload: { bp: 'compost' },
  });
  assert.equal(other.statusCode, 403);

  const noBp = await app.inject({
    method: 'POST',
    url: `/api/copies/${ALICE_COPY}/deploy-over-main`,
    headers: { 'x-forwarded-email': ALICE },
    payload: {},
  });
  assert.equal(noBp.statusCode, 400);
  assert.equal(calls.length, 0);

  const ok = await app.inject({
    method: 'POST',
    url: `/api/copies/${ALICE_COPY}/deploy-over-main`,
    headers: { 'x-forwarded-email': ALICE },
    payload: {
      bp: 'compost',
      expectedMain: 'abc1234',
      bpLabel: 'Compost',
      // A caller that still sends one gets it dropped: publishing over main
      // has exactly one outcome, and a `mode` reaching gitops would be a
      // second, invisible way to ask for a different one.
      mode: 'rebase',
    },
  });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(calls[0]?.args[1], {
    bp: 'compost',
    expected_main: 'abc1234',
    bp_label: 'Compost',
    deployer: ALICE,
  });
  await app.close();
});

test('the deploy-over-main preview is per business process', async () => {
  const { app, calls } = buildApp();
  const noBp = await app.inject({
    method: 'GET',
    url: `/api/copies/${ALICE_COPY}/deploy-over-main-preview`,
    headers: { 'x-forwarded-email': ALICE },
  });
  assert.equal(noBp.statusCode, 400);

  const res = await app.inject({
    method: 'GET',
    url: `/api/copies/${ALICE_COPY}/deploy-over-main-preview?bp=compost`,
    headers: { 'x-forwarded-email': ALICE },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls[0]?.args, [ALICE_COPY, 'compost']);
  await app.close();
});

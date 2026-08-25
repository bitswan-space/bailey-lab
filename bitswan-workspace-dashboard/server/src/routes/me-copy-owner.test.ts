import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerMeRoutes } from './me.js';
import type { GitopsClient } from '../services/gitops.js';

/**
 * Signing in records who a legacy copy belongs to.
 *
 * Copies created before the `.copy.json` sidecar existed have no recorded
 * owner, and every operation that REPLACES a copy's contents fails closed
 * without one. On any workspace that has been running a while that is every
 * real person's copy — so "Edit main's version without merging my changes"
 * answered 403 for all of them, and the test suite never noticed because every
 * test copy is created through the modern path.
 *
 * gitops does the writing (it owns the copies directory and re-checks the
 * identity itself). What the BFF alone decides, and what is pinned here, is
 * WHICH copy is offered for the backfill: the one derived from the verified
 * email, and only when it already exists.
 */

// `copyNameForEmail` turns this into `alice-acme-com`.
const ALICE = 'alice@acme.com';
const ALICE_COPY = 'alice-acme-com';

interface Ensured {
  name: string;
  owner: string;
}

function buildApp({ existing }: { existing: string[] }) {
  const ensured: Ensured[] = [];
  const created: string[] = [];
  const gitops = {
    hasCopy(name: string) {
      return existing.includes(name);
    },
    async ensureCopyOwner(name: string, owner: string) {
      ensured.push({ name, owner });
      return { ok: true, status: 200, body: { status: 'recorded' } };
    },
    async createCopy(body: { branch_name: string }) {
      created.push(body.branch_name);
      return { ok: true, status: 200, body: {} };
    },
    async userRole() {
      return 'member' as const;
    },
    // eslint-disable-next-line no-restricted-syntax -- minimal test double for the wide GitopsClient class
  } as unknown as GitopsClient;
  const app = Fastify({ logger: false });
  registerMeRoutes(app, { gitops });
  return { app, ensured, created };
}

/** The backfill is fire-and-forget, so let the microtask queue drain. */
async function settle(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

test('signing in offers the caller’s existing copy for owner backfill', async () => {
  const { app, ensured } = buildApp({ existing: [ALICE_COPY] });

  const res = await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { 'x-forwarded-email': ALICE },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().copy, ALICE_COPY);
  await settle();
  // The owner sent is the VERIFIED email, not anything the client supplied —
  // and gitops refuses it anyway unless it matches the identity it was given.
  assert.deepEqual(ensured, [{ name: ALICE_COPY, owner: ALICE }]);
  await app.close();
});

test('a copy that does not exist yet is created, not backfilled', async () => {
  const { app, ensured, created } = buildApp({ existing: [] });

  await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { 'x-forwarded-email': ALICE },
  });

  await settle();
  assert.deepEqual(ensured, [], 'nothing to record an owner on');
  assert.deepEqual(created, [ALICE_COPY]);
  await app.close();
});

test('no other copy is ever offered for backfill, however many exist', async () => {
  // The whole safety of this is that the only copy named is the one derived
  // from the verified identity. A stranger's legacy copy must stay unowned.
  const { app, ensured } = buildApp({
    existing: ['main', 'bob-acme-com', ALICE_COPY, 'exp-something-ab12'],
  });

  await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { 'x-forwarded-email': ALICE },
  });

  await settle();
  assert.deepEqual(ensured.map((e) => e.name), [ALICE_COPY]);
  await app.close();
});

test('an unauthenticated caller records nothing', async () => {
  const { app, ensured, created } = buildApp({ existing: [ALICE_COPY] });

  const res = await app.inject({ method: 'GET', url: '/api/me' });

  assert.equal(res.statusCode, 401);
  await settle();
  assert.deepEqual(ensured, []);
  assert.deepEqual(created, []);
  await app.close();
});

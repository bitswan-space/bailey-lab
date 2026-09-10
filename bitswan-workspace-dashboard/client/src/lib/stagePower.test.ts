import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stagePower } from './stagePower.ts';

const up = { up: true, present: true };
const asleep = { up: false, present: true };
const neverDeployed = { up: false, present: false };

test('a stage with ONE service asleep can still be woken', () => {
  // The bug this pins: Wake was offered only when every member was asleep, so
  // a stage whose frontend had been evicted while its backend kept serving
  // showed "Put to sleep" and nothing that could bring the frontend back.
  const p = stagePower([up, asleep]);
  assert.equal(p.canWake, true);
  assert.equal(p.canSleep, true);
  assert.equal(p.sleeping, 1);
  assert.match(p.label, /1 service of 2 asleep/);
});

test('a fully asleep stage keeps its old message and offers only Wake', () => {
  const p = stagePower([asleep, asleep], 'memory-pressure');
  assert.equal(p.canWake, true);
  assert.equal(p.canSleep, false);
  assert.equal(p.label, 'Asleep — evicted under memory pressure. Wakes on access, or wake now.');
});

test('a fully running stage offers only Put to sleep', () => {
  const p = stagePower([up, up]);
  assert.equal(p.canWake, false);
  assert.equal(p.canSleep, true);
  assert.match(p.label, /Free this stage’s memory now/);
});

test('a member that was never deployed is not asleep', () => {
  // Nothing to wake: it has no deployment record, so Wake would act on nothing
  // and the row must not claim otherwise.
  const p = stagePower([up, neverDeployed]);
  assert.equal(p.canWake, false);
  assert.equal(p.sleeping, 0);
});

test('the sleep is attributed when gitops says who did it', () => {
  assert.match(stagePower([up, asleep], 'manual').label, /put to sleep manually/);
  assert.match(stagePower([up, asleep], 'memory-pressure').label, /evicted under memory pressure/);
  assert.doesNotMatch(stagePower([up, asleep]).label, /manually|memory pressure/);
});

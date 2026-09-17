import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stagePower } from './stagePower.ts';

const up = { asleep: false, up: true, present: true, expose: false };
const upFrontend = { ...up, expose: true };
const asleep = { asleep: true, up: false, present: true, expose: false };
const asleepFrontend = { ...asleep, expose: true };
const dead = { asleep: false, up: false, present: true, expose: false };
const neverDeployed = { asleep: false, up: false, present: false, expose: false };

test('a stage with ONE service asleep can still be woken', () => {
  const p = stagePower([up, asleepFrontend]);
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
  const p = stagePower([up, neverDeployed]);
  assert.equal(p.canWake, false);
  assert.equal(p.sleeping, 0);
});

test('the sleep is attributed when gitops says who did it', () => {
  assert.match(stagePower([up, asleep], 'manual').label, /put to sleep manually/);
  assert.match(stagePower([up, asleep], 'memory-pressure').label, /evicted under memory pressure/);
  assert.doesNotMatch(stagePower([up, asleep]).label, /manually|memory pressure/);
});

test('a dead container is not COUNTED as asleep, while something still runs', () => {
  const p = stagePower([up, dead]);
  assert.equal(p.sleeping, 0);
  assert.equal(p.canWake, false, 'something is still up — Wake is for a stage that is not');
});

test('a stage whose containers ALL died still offers Wake', () => {
  const p = stagePower([dead, dead]);
  assert.equal(p.canWake, true);
  assert.equal(p.canSleep, false);
  assert.match(p.label, /Nothing is running on this stage/);
  assert.match(p.label, /not asleep/i);
  assert.match(p.label, /nothing brings them back on access/i);
});

test('a sleeping WORKER is not promised it will wake on access', () => {
  assert.match(stagePower([upFrontend, asleep]).label, /Wake now\.$/);
  assert.match(stagePower([up, asleepFrontend]).label, /leave them to wake on access/);
});

test('the count is out of the members that could be asleep', () => {
  assert.match(stagePower([up, asleep, neverDeployed]).label, /1 service of 2 asleep/);
});

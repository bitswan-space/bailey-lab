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
  // The bug this pins: Wake was offered only when every member was asleep, so
  // a stage whose frontend had been evicted while its backend kept serving
  // showed "Put to sleep" and nothing that could bring the frontend back.
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

test('a dead container is not COUNTED as asleep, while something still runs', () => {
  // "Not up" also covers exited/failed/unreadable containers. Counting those as
  // sleeping put "1 service of 2 asleep … leave them to wake on access" above a
  // card correctly saying "1 service not running".
  const p = stagePower([up, dead]);
  assert.equal(p.sleeping, 0);
  assert.equal(p.canWake, false, 'something is still up — Wake is for a stage that is not');
});

test('a stage whose containers ALL died still offers Wake', () => {
  // Wake re-activates the group and runs `docker compose up`, which revives
  // dead containers too — so the stage that most needs the button was the one
  // left without it. The sentence must not call them asleep, though.
  const p = stagePower([dead, dead]);
  assert.equal(p.canWake, true);
  assert.equal(p.canSleep, false);
  assert.match(p.label, /Nothing is running on this stage/);
  // It may mention sleep — it has to, to DENY it. What it must not do is claim
  // these containers are asleep, or promise that opening the app revives them.
  assert.match(p.label, /not asleep/i);
  assert.match(p.label, /nothing brings them back on access/i);
});

test('a sleeping WORKER is not promised it will wake on access', () => {
  // Wake-on-access needs a request to reach a dehydrated ingress host. A
  // backend behind a frontend that is still serving has nothing routing to
  // it, so nobody will ever knock: telling the operator they may leave it is
  // a promise with no mechanism behind it.
  assert.match(stagePower([upFrontend, asleep]).label, /Wake now\.$/);
  assert.match(stagePower([up, asleepFrontend]).label, /leave them to wake on access/);
});

test('the count is out of the members that could be asleep', () => {
  // A never-deployed member is not part of the denominator, or the row says
  // "1 of 3" about two deployments.
  assert.match(stagePower([up, asleep, neverDeployed]).label, /1 service of 2 asleep/);
});

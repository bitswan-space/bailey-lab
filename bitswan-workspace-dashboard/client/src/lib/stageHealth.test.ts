import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stageHealth } from './stageHealth.ts';

test('a stage whose container keeps restarting is not healthy', () => {
  // The bug this pins (bailey-lab #463): `restarting` counted as up, and only
  // failed/stopped counted as failing, so a production stage that had been
  // crashlooping for two months reported "Healthy" in green.
  const h = stageHealth({ deployed: true, statuses: ['running', 'restarting'] });
  assert.equal(h.kind, 'restarting');
  assert.equal(h.label, '1 service restarting');
});

test('the pipeline tick is reserved for a stage that was seen to be fine', () => {
  // The node's ✓ used to mean "something is deployed here", which is what its
  // emerald fill already says — so it sat above a card reporting a restart
  // loop. Only 'healthy' may draw it now.
  assert.equal(stageHealth({ deployed: true, statuses: ['running', 'running'] }).kind, 'healthy');
  for (const statuses of [['restarting'], ['stopped'], ['failed'], []] as const) {
    const kind = stageHealth({ deployed: true, statuses: [...statuses] }).kind;
    if (statuses.length > 0) assert.notEqual(kind, 'healthy');
  }
});

test('deployed with its containers unresolved claims nothing either way', () => {
  // Disaster recovery outside its own view: the standby slot's name is not
  // known there, so the members cannot be looked up. Saying "healthy" would
  // be inventing an observation; saying "not deployed" would be wrong too.
  const h = stageHealth({ deployed: true });
  assert.equal(h.kind, 'unknown');
  assert.equal(h.label, 'Deployed');
});

test('nothing deployed reads as nothing deployed, whatever the containers say', () => {
  assert.equal(stageHealth({ deployed: false, statuses: ['running'] }).kind, 'not-deployed');
  assert.equal(stageHealth({ deployed: false }).label, 'Not deployed yet');
});

test('a stage with nothing up is asleep, not failing', () => {
  // Every member reads `stopped` when a stage is asleep (an operator's Sleep,
  // or the on-demand memory sweep), so this has to be decided before the
  // failing count — it wakes on access and is not a fault.
  const h = stageHealth({ deployed: true, statuses: ['stopped', 'stopped'] });
  assert.equal(h.kind, 'asleep');
  assert.equal(h.label, 'Asleep');
});

test('a real failure outranks a restart loop, and both are counted', () => {
  const failing = stageHealth({ deployed: true, statuses: ['running', 'failed', 'restarting'] });
  assert.equal(failing.kind, 'failing');
  assert.equal(failing.label, '1 service not running');
  const many = stageHealth({ deployed: true, statuses: ['restarting', 'restarting', 'running'] });
  assert.equal(many.label, '2 services restarting');
});

test('a stage with ONE service asleep is not Healthy', () => {
  // The gap this pins: a slept member arrives with no container state, so
  // reading only the state made it 'unknown' — no observation — and the
  // summary counted nothing wrong and said Healthy, tick and all, while one
  // of the stage's services was not running at all.
  const h = stageHealth({ deployed: true, statuses: ['running', 'asleep'] });
  assert.equal(h.kind, 'partly-asleep');
  assert.equal(h.label, '1 service of 2 asleep');
  assert.notEqual(h.kind, 'healthy');
});

test('a stage where everything is asleep still reads Asleep, not partly', () => {
  assert.equal(stageHealth({ deployed: true, statuses: ['asleep', 'asleep'] }).kind, 'asleep');
});

test('a fault outranks a sleeping member', () => {
  // Sleeping is deliberate; a container that died is not. The louder one wins.
  assert.equal(
    stageHealth({ deployed: true, statuses: ['asleep', 'restarting', 'running'] }).kind,
    'restarting',
  );
  assert.equal(
    stageHealth({ deployed: true, statuses: ['asleep', 'failed', 'running'] }).kind,
    'failing',
  );
});

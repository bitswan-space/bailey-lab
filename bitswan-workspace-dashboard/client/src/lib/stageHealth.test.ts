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

test('a stage whose containers all DIED is not asleep', () => {
  // "Asleep — it wakes on access" is a promise. A stage that is down because
  // every container stopped or failed will not wake on access, and saying so
  // is the same false comfort this module exists to remove. (This test
  // replaces one that asserted the opposite: back when a slept member read as
  // 'stopped', "nothing is up" was a fair proxy for asleep. It no longer is.)
  const h = stageHealth({ deployed: true, statuses: ['stopped', 'stopped'] });
  assert.equal(h.kind, 'failing');
  assert.equal(h.label, '2 services not running');
});

test('a stage that is part asleep and part dead reports the death', () => {
  const h = stageHealth({ deployed: true, statuses: ['asleep', 'failed'] });
  assert.equal(h.kind, 'failing');
  assert.equal(h.label, '1 service not running');
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

test('a stage nobody has heard anything about is not Healthy', () => {
  // On the first paint the automations snapshot is still empty, so every
  // member reads 'not-deployed'. That used to fall through to Healthy — a
  // green tick and the word Healthy for a stage nothing had been observed
  // about, which is the one claim this module promises never to make.
  assert.equal(
    stageHealth({ deployed: true, statuses: ['not-deployed', 'not-deployed'] }).kind,
    'unknown',
  );
  // A container removed outside gitops reads 'unknown' for good.
  assert.equal(stageHealth({ deployed: true, statuses: ['unknown'] }).kind, 'unknown');
  // And a history entry that carries no members at all.
  assert.equal(stageHealth({ deployed: true, statuses: [] }).kind, 'unknown');
});

test('Healthy is for a stage seen WHOLE', () => {
  // Every member observed up. (An earlier version of this test accepted
  // 'running' + 'unknown' as healthy — that is the very gap the
  // not-accounted-for case below closes: one running service does not vouch
  // for the one nobody can find.)
  assert.equal(stageHealth({ deployed: true, statuses: ['running', 'running'] }).kind, 'healthy');
  assert.equal(
    stageHealth({ deployed: true, statuses: ['running', 'restarting'] }).kind,
    'restarting',
  );
});

test('a stage missing one of its services is not Healthy either', () => {
  // A container removed out of band, a `compose up` that never created it, an
  // entry missing from the snapshot: the member reads 'unknown', and counting
  // it as neither failing nor up left the stage with a green tick while one of
  // its services was entirely absent.
  const h = stageHealth({ deployed: true, statuses: ['running', 'running', 'unknown'] });
  assert.equal(h.kind, 'unknown');
  assert.equal(h.label, '1 service of 3 not accounted for');
  const g = stageHealth({ deployed: true, statuses: ['running', 'not-deployed'] });
  assert.equal(g.kind, 'unknown');
});

test('a real fault still outranks a member nobody can account for', () => {
  assert.equal(
    stageHealth({ deployed: true, statuses: ['running', 'unknown', 'failed'] }).kind,
    'failing',
  );
});

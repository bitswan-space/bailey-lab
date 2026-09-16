import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stageHealth } from './stageHealth.ts';

test('a stage whose container keeps restarting is not healthy', () => {
  const h = stageHealth({ deployed: true, statuses: ['running', 'restarting'] });
  assert.equal(h.kind, 'restarting');
  assert.equal(h.label, '1 service restarting');
});

test('the pipeline tick is reserved for a stage that was seen to be fine', () => {
  assert.equal(stageHealth({ deployed: true, statuses: ['running', 'running'] }).kind, 'healthy');
  for (const statuses of [['restarting'], ['stopped'], ['failed'], []] as const) {
    const kind = stageHealth({ deployed: true, statuses: [...statuses] }).kind;
    if (statuses.length > 0) assert.notEqual(kind, 'healthy');
  }
});

test('deployed with its containers unresolved claims nothing either way', () => {
  const h = stageHealth({ deployed: true });
  assert.equal(h.kind, 'unknown');
  assert.equal(h.label, 'Deployed');
});

test('nothing deployed reads as nothing deployed, whatever the containers say', () => {
  assert.equal(stageHealth({ deployed: false, statuses: ['running'] }).kind, 'not-deployed');
  assert.equal(stageHealth({ deployed: false }).label, 'Not deployed yet');
});

test('a stage whose containers all DIED is not asleep', () => {
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
  const h = stageHealth({ deployed: true, statuses: ['running', 'asleep'] });
  assert.equal(h.kind, 'partly-asleep');
  assert.equal(h.label, '1 service of 2 asleep');
  assert.notEqual(h.kind, 'healthy');
});

test('a stage where everything is asleep still reads Asleep, not partly', () => {
  assert.equal(stageHealth({ deployed: true, statuses: ['asleep', 'asleep'] }).kind, 'asleep');
});

test('a fault outranks a sleeping member', () => {
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
  assert.equal(
    stageHealth({ deployed: true, statuses: ['not-deployed', 'not-deployed'] }).kind,
    'unknown',
  );
  assert.equal(stageHealth({ deployed: true, statuses: ['unknown'] }).kind, 'unknown');
  assert.equal(stageHealth({ deployed: true, statuses: [] }).kind, 'unknown');
});

test('Healthy is for a stage seen WHOLE', () => {
  assert.equal(stageHealth({ deployed: true, statuses: ['running', 'running'] }).kind, 'healthy');
  assert.equal(
    stageHealth({ deployed: true, statuses: ['running', 'restarting'] }).kind,
    'restarting',
  );
});

test('a stage missing one of its services is not Healthy either', () => {
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

test('a member nobody can account for is named even when another is asleep', () => {
  const h = stageHealth({ deployed: true, statuses: ['running', 'asleep', 'unknown'] });
  assert.equal(h.kind, 'unknown');
  assert.equal(h.label, '1 service of 3 not accounted for');
});

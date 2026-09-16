import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bpContainers, type BpContainer } from './bpContainers.ts';
import { displayFor, stateToDisplay } from './status.ts';
import { isUpStatus, worstStatus } from './status.ts';
import type { DeployedAutomation } from '../types/automation.ts';

const COPY = 'alice';
const BP = 'test33';

const rec = (over: Partial<DeployedAutomation> = {}): DeployedAutomation => ({
  container_id: 'c1',
  endpoint_name: null,
  created_at: null,
  name: 'backend',
  state: 'running',
  status: 'healthy',
  deployment_id: 'backend-7622-live-dev',
  active: true,
  automation_url: null,
  relative_path: `copies/${COPY}/${BP}/backend`,
  stage: 'live-dev',
  automation_name: 'backend',
  context: null,
  version_hash: null,
  replicas: 1,
  ...over,
});

const only = (rows: BpContainer[]): BpContainer => {
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row);
  return row;
};

test('a restarting container is reported as restarting, not running', () => {
  assert.equal(only(bpContainers([rec({ state: 'restarting' })], COPY, BP)).status, 'restarting');
});

test('a restarting container still counts as up, so it keeps its Stop button', () => {
  assert.equal(isUpStatus('restarting'), true);
  assert.equal(isUpStatus('stopped'), false);
});

test('one healthy record does not hide a broken one behind the same name', () => {
  const c = only(
    bpContainers(
      [
        rec({ deployment_id: 'backend-live-dev', state: 'running' }),
        rec({ deployment_id: 'backend-live-dev@green', state: 'restarting' }),
      ],
      COPY,
      BP,
    ),
  );
  assert.equal(c.status, 'restarting');
});

test('an observation always outranks the absence of one', () => {
  const c = only(
    bpContainers(
      [rec({ deployment_id: null, container_id: null, state: null }), rec({ state: 'running' })],
      COPY,
      BP,
    ),
  );
  assert.equal(c.status, 'running');
  assert.equal(worstStatus('not-deployed', 'running'), 'running');
});

test('a never-deployed automation reads as not deployed, not as stopped', () => {
  const c = only(
    bpContainers([rec({ deployment_id: null, container_id: null, state: null })], COPY, BP),
  );
  assert.equal(c.status, 'not-deployed');
  assert.equal(c.deploymentId, undefined);
});

test('the health string in `status` is never read as a container state', () => {
  assert.equal(only(bpContainers([rec({ state: '', status: 'healthy' })], COPY, BP)).status, 'unknown');
});

test('the restart count comes through, and the highest of a set wins', () => {
  const c = only(
    bpContainers(
      [
        rec({ deployment_id: 'backend-live-dev', restart_count: 12 }),
        rec({ deployment_id: 'backend-live-dev@green', restart_count: 23032 }),
      ],
      COPY,
      BP,
    ),
  );
  assert.equal(c.restartCount, 23032);
});

test('an unread restart count stays absent rather than becoming zero', () => {
  assert.equal(only(bpContainers([rec({ restart_count: null })], COPY, BP)).restartCount, undefined);
  assert.equal(only(bpContainers([rec({ restart_count: 0 })], COPY, BP)).restartCount, 0);
});

test('only the copy+BP asked for is listed, and each name appears once', () => {
  const rows = bpContainers(
    [
      rec({ automation_name: 'backend' }),
      rec({ automation_name: 'frontend', expose: true, automation_url: 'https://x' }),
      rec({ automation_name: 'backend', deployment_id: 'backend-7622-dev' }),
      rec({ relative_path: `copies/bob/${BP}/backend` }),
      rec({ relative_path: `copies/${COPY}/other-bp/backend` }),
    ],
    COPY,
    BP,
  );
  assert.deepEqual(
    rows.map((r) => r.name),
    ['backend', 'frontend'],
  );
  const frontend = rows[1];
  assert.ok(frontend);
  assert.equal(frontend.expose, true);
  assert.equal(frontend.url, 'https://x');
});

test('a slept automation reads as asleep, not as an unknown state', () => {
  const c = only(
    bpContainers([rec({ active: false, state: null, container_id: null })], COPY, BP),
  );
  assert.equal(c.status, 'asleep');
});

test('asleep outranks running when a name collapses several records', () => {
  const c = only(
    bpContainers(
      [
        rec({ deployment_id: 'backend-live-dev', state: 'running' }),
        rec({
          deployment_id: 'backend-live-dev@green',
          active: false,
          state: null,
          container_id: null,
        }),
      ],
      COPY,
      BP,
    ),
  );
  assert.equal(c.status, 'asleep');
});

test('a RUNNING container never reads as asleep, whatever the flags say', () => {
  assert.equal(
    only(bpContainers([rec({ active: false, state: 'running' })], COPY, BP)).status,
    'running',
  );
  assert.equal(
    only(bpContainers([rec({ asleep_reason: 'manual', state: 'running' })], COPY, BP)).status,
    'running',
  );
});

test('the row points its buttons at the record its dot describes', () => {
  const c = only(
    bpContainers(
      [
        rec({ deployment_id: 'backend-live-dev', state: 'running' }),
        rec({ deployment_id: 'backend-live-dev@green', state: 'restarting' }),
      ],
      COPY,
      BP,
    ),
  );
  assert.equal(c.status, 'restarting');
  assert.equal(c.deploymentId, 'backend-live-dev@green');
});

test('a woken deployment that failed to come back is not "asleep"', () => {
  const c = only(
    bpContainers(
      [rec({ active: true, state: null, container_id: null, asleep_reason: 'manual' })],
      COPY,
      BP,
    ),
  );
  assert.equal(c.status, 'unknown');
});

test('the open link comes from the record the row describes', () => {
  const c = only(
    bpContainers(
      [
        rec({ deployment_id: 'frontend-live-dev', state: 'running', automation_url: 'https://healthy' }),
        rec({ deployment_id: 'frontend-live-dev@green', state: 'restarting', automation_url: null }),
      ],
      COPY,
      BP,
    ),
  );
  assert.equal(c.status, 'restarting');
  assert.equal(c.deploymentId, 'frontend-live-dev@green');
  assert.equal(c.url, undefined, 'not the healthy slot’s URL');
});

test('a container created and never started is not "running"', () => {
  assert.equal(stateToDisplay('created'), 'unknown');
  assert.equal(
    displayFor({
      container_id: 'c1',
      endpoint_name: null,
      created_at: null,
      name: 'backend',
      state: 'created',
      status: null,
      deployment_id: 'backend-live-dev',
      active: true,
      automation_url: null,
      relative_path: 'copies/alice/test33/backend',
      stage: 'live-dev',
      automation_name: 'backend',
      context: null,
      version_hash: null,
      replicas: 1,
    }),
    'unknown',
  );
  assert.equal(stateToDisplay('starting'), 'running');
});

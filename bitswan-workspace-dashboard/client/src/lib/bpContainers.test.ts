import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bpContainers, type BpContainer } from './bpContainers.ts';
import { isUpStatus, worstStatus } from './status.ts';
import type { DeployedAutomation } from '../types/automation.ts';

const COPY = 'alice';
const BP = 'test33';

/** A deployed automation record as gitops puts it on the wire. */
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

/** The one row the call is expected to produce. */
const only = (rows: BpContainer[]): BpContainer => {
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row);
  return row;
};

test('a restarting container is reported as restarting, not running', () => {
  // The bug this pins (bailey-lab #463): `restarting` was mapped onto
  // `running`, so a business process that had crashlooped 23,032 times over
  // two months sat under a green dot and nobody knew.
  assert.equal(only(bpContainers([rec({ state: 'restarting' })], COPY, BP)).status, 'restarting');
});

test('a restarting container still counts as up, so it keeps its Stop button', () => {
  // Honest dot, unchanged affordance: a crashlooper is not asleep, and the
  // operator needs Stop/Restart on it — not the Start button an "it is down"
  // reading would offer.
  assert.equal(isUpStatus('restarting'), true);
  assert.equal(isUpStatus('stopped'), false);
});

test('one healthy record does not hide a broken one behind the same name', () => {
  // The second half of #463: the merge preferred `running`, so of a production
  // member's blue/green pair — both restarting — the row showed whichever
  // record was healthiest.
  const c = only(
    bpContainers(
      [
        // Two records for one name in one copy — the shape the blue/green
        // slots have. (A copy's pane can only ever see its own live-dev
        // records: `main` is excluded from the copies listing, and the
        // promoted stages live under `copies/main/…`.)
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
  // A name whose other record has never been deployed must not drag a running
  // container down to "not deployed" — worst-wins is about observed states.
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
  // gitops fills `status` with health-or-state, so the old `state ?? status`
  // fallback compared "healthy" against docker state names, matched nothing,
  // and landed on "stopped" — a red dot on a healthy container.
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
  // "Restarted 0 times" is a claim; not having read the count is not.
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
  // The live-dev cap evicts previews the same way the memory sweep evicts a
  // stage's members: the record stays, `active` goes false and no container
  // state comes with it.
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

test('a sleep gitops attributed is asleep even if `active` still says true', () => {
  // Measured live: the automations cache bakes `active` in when it is built, so
  // an evicted deployment arrived as active:true with asleep_reason:"manual".
  // Reading only `active` would have shown it as "unknown" — and the stage it
  // belongs to as Healthy.
  const c = only(
    bpContainers(
      [rec({ active: true, state: null, container_id: null, asleep_reason: 'manual' })],
      COPY,
      BP,
    ),
  );
  assert.equal(c.status, 'asleep');
});

test('a RUNNING container never reads as asleep, whatever the flags say', () => {
  // Both signs of sleep can be stale: a yaml entry that predates
  // normalization carries no `active` key (and one reader defaulted that to
  // false), and a sleep marker can outlive the sleep it described. A live
  // container state overrules them — nothing that is running may be shown as
  // asleep, which is the same wrong claim as the reverse.
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
  // Worst-wins picks which record the row is about, so the deployment id has
  // to come from that same record — otherwise the dot describes one container
  // while Logs and Restart act on another.
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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  beginPending,
  dropPending,
  observePending,
  pendingFailed,
  pendingIssued,
  PENDING_BUDGET_MS,
  pendingSeq,
  pendingSnapshot,
  resetPendingActions,
  settle,
  stagePending,
  type PendingAction,
  type PendingKind,
} from './pendingActions.ts';
import type { DeployedAutomation } from '../types/automation.ts';

const T0 = '2026-09-10T18:26:13.744009Z';
const T1 = '2026-09-11T16:50:12.233568Z';
const EARLIER = '2026-09-09T08:00:00.000000Z';

function automation(over: Partial<DeployedAutomation> = {}): DeployedAutomation {
  return {
    container_id: 'c1',
    endpoint_name: 'svc',
    created_at: null,
    name: 'checkout',
    state: 'running',
    status: 'running',
    deployment_id: 'checkout-7622-production',
    active: true,
    automation_url: null,
    relative_path: 'copies/alice/shop/checkout',
    stage: 'production',
    automation_name: 'checkout',
    context: null,
    version_hash: null,
    replicas: 1,
    started_at: T0,
    ...over,
  };
}

function action(over: Partial<PendingAction> = {}): PendingAction {
  return {
    deploymentId: 'checkout-7622-production',
    kind: 'restart',
    name: 'checkout',
    confirmedAt: 1_000_000,
    timeoutMs: PENDING_BUDGET_MS.restart,
    baseline: { startedAt: T0, containerId: 'c1', status: 'running' },
    baselineSeq: 1,
    issued: true,
    ...over,
  };
}

test('a restart ends when the container reports a later start', () => {
  const done = settle(action(), automation({ started_at: T1 }), 2);
  assert.deepEqual(done, { done: true, how: 'observed' });
});

test('an up container reporting the SAME start keeps the restart pending', () => {
  assert.deepEqual(settle(action(), automation({ started_at: T0 }), 2), { done: false });
});

test('a start reading EARLIER than the baseline does not settle a restart', () => {
  assert.deepEqual(settle(action(), automation({ started_at: EARLIER }), 2), { done: false });
});

test('the observed start time is never compared against the browser clock', () => {
  const far = '2031-01-01T00:00:00.000Z';
  const p = action({ baseline: { startedAt: far, containerId: 'c1', status: 'running' } });
  const done = settle(p, automation({ started_at: '2031-01-02T00:00:00.000Z' }), 2);
  assert.deepEqual(done, { done: true, how: 'observed' });
  assert.deepEqual(settle(action(), automation({ started_at: EARLIER }), 2), { done: false });
});

test('a restart whose container was replaced settles on the new container id', () => {
  const done = settle(action(), automation({ container_id: 'c2', started_at: null }), 2);
  assert.deepEqual(done, { done: true, how: 'observed' });
});

test('a restart is unwitnessable where the field was never readable', () => {
  const p = action({ baseline: { containerId: 'c1', status: 'running' } });
  const done = settle(p, automation({ started_at: null }), 2);
  assert.deepEqual(done, { done: true, how: 'unwitnessable' });
});

test('an inspect that lost a race is waited for, not called unwitnessable', () => {
  assert.deepEqual(settle(action(), automation({ started_at: null }), 2), { done: false });
});

test('an unwitnessable restart is only reported once the request was accepted', () => {
  const p = action({ issued: false, baseline: { containerId: 'c1', status: 'running' } });
  assert.deepEqual(settle(p, automation({ started_at: null }), 2), { done: false });
});

test('a restart with no container behaves like a start: being up is the observation', () => {
  const p = action({ baseline: { status: 'asleep' } });
  assert.deepEqual(settle(p, automation({ started_at: null }), 2), {
    done: true,
    how: 'observed',
  });
});

test('the momentary exited reading in the middle of a restart is not a failure', () => {
  const mid = automation({ state: 'exited', started_at: T0 });
  assert.deepEqual(settle(action(), mid, 2), { done: false });
});

test('a restart that lands in a crash loop ends, and the crash loop stays visible', () => {
  const done = settle(action(), automation({ state: 'restarting', started_at: T1 }), 2);
  assert.deepEqual(done, { done: true, how: 'observed' });
});

test('nothing an observation says can fail an action', () => {
  for (const state of ['exited', 'dead', 'created', ''] as const) {
    const v = settle(action(), automation({ state, started_at: T0 }), 2);
    assert.equal(v.done, false, `state ${state} must not end a restart`);
  }
});

test('a stop ends when nothing is up, the reaped-and-asleep reading included', () => {
  const p = action({ kind: 'stop', timeoutMs: PENDING_BUDGET_MS.stop });
  assert.deepEqual(settle(p, automation({ state: 'exited' }), 2), {
    done: true,
    how: 'observed',
  });
  const reaped = automation({ state: null, container_id: null, active: false });
  assert.deepEqual(settle(p, reaped, 2), { done: true, how: 'observed' });
  assert.deepEqual(settle(p, automation(), 2), { done: false }, 'still running');
});

test('a stop ends when the record leaves the snapshot entirely', () => {
  const p = action({ kind: 'stop', timeoutMs: PENDING_BUDGET_MS.stop });
  assert.deepEqual(settle(p, undefined, 2), { done: true, how: 'observed' });
});

test('a sleep is not ended by a member that is still running', () => {
  const p = action({ kind: 'sleep', timeoutMs: PENDING_BUDGET_MS.sleep });
  assert.deepEqual(settle(p, automation(), 2), { done: false });
});

test('a start ends on being up, with no start time needed to witness it', () => {
  const p = action({
    kind: 'start',
    timeoutMs: PENDING_BUDGET_MS.start,
    baseline: { status: 'stopped', containerId: 'c1', startedAt: T0 },
  });
  assert.deepEqual(settle(p, automation({ started_at: T0 }), 2), {
    done: true,
    how: 'observed',
  });
});

test('the snapshot the baseline was read from is never evidence about the action', () => {
  const p = action({ baselineSeq: 5 });
  assert.deepEqual(settle(p, automation({ started_at: T1 }), 5), { done: false });
  assert.deepEqual(settle(p, automation({ started_at: T1 }), 6), {
    done: true,
    how: 'observed',
  });
});

test('each kind carries its own budget', () => {
  assert.ok(PENDING_BUDGET_MS.start > PENDING_BUDGET_MS.restart);
  assert.ok(PENDING_BUDGET_MS.restart > PENDING_BUDGET_MS.stop);
  const kinds: PendingKind[] = ['restart', 'stop', 'start', 'wake', 'sleep'];
  for (const kind of kinds) {
    assert.ok(PENDING_BUDGET_MS[kind] > 0, `${kind} needs a cap`);
  }
});

function begin(over: Partial<Parameters<typeof beginPending>[0]> = {}) {
  beginPending({
    deploymentId: 'checkout-7622-production',
    kind: 'restart',
    name: 'checkout',
    baseline: { startedAt: T0, containerId: 'c1', status: 'running' },
    ...over,
  });
}

test('an action is pending from the confirm frame, before any request is dispatched', () => {
  resetPendingActions();
  begin();
  const p = currentPending('checkout-7622-production');
  assert.equal(p?.kind, 'restart');
  assert.equal(p?.issued, false);
});

test('a second action on the same deployment replaces the first, with its own baseline', () => {
  resetPendingActions();
  begin();
  begin({ kind: 'stop', baseline: { startedAt: T1, containerId: 'c1', status: 'running' } });
  const p = currentPending('checkout-7622-production');
  assert.equal(p?.kind, 'stop');
  assert.equal(p?.baseline.startedAt, T1);
});

test('the resolver settles an entry on a snapshot, and only on a NEW one', () => {
  resetPendingActions();
  begin();
  pendingIssued('checkout-7622-production');
  const same = [automation({ started_at: T0 })];
  observePending(same);
  assert.ok(currentPending('checkout-7622-production'), 'unchanged start time: still waiting');
  const before = pendingSeq();
  observePending(same);
  assert.equal(pendingSeq(), before);
  observePending([automation({ started_at: T1 })]);
  assert.equal(currentPending('checkout-7622-production'), undefined, 'seen back up');
});

test('a rejected request ends the action', () => {
  resetPendingActions();
  begin();
  pendingFailed('checkout-7622-production', 'boom');
  assert.equal(currentPending('checkout-7622-production'), undefined);
});

test('a deployment with nothing in flight reads as nothing, not as a fresh action', () => {
  resetPendingActions();
  assert.equal(currentPending('checkout-7622-production'), undefined);
});

test('an empty store hands back one identity, so a subscriber cannot re-render forever', () => {
  resetPendingActions();
  const a = snapshot();
  begin();
  pendingFailed('checkout-7622-production', 'boom');
  assert.equal(snapshot(), a, 'back to the same empty map');
});

test("a stage's pending count comes from its own members and nobody else's", () => {
  resetPendingActions();
  begin();
  begin({ deploymentId: 'web-7622-production', name: 'web' });
  const s = stagePending(['checkout-7622-production', 'somebody-else'], snapshot());
  assert.equal(s.count, 1);
  assert.match(s.label, /You restarted 1 service/);
});

test('one stage Wake reads as one action, not one per member', () => {
  resetPendingActions();
  for (const id of ['a-prod', 'b-prod', 'c-prod']) {
    begin({ deploymentId: id, kind: 'wake', name: 'Production', groupId: 'g1', groupTotal: 3 });
  }
  const s = stagePending(['a-prod', 'b-prod', 'c-prod'], snapshot());
  assert.equal(s.count, 3);
  assert.equal(s.label, 'Waking Production — waiting for its containers');
});

test('a stage with different kinds in flight says how many, not which', () => {
  resetPendingActions();
  begin({ deploymentId: 'a-prod', name: 'a' });
  begin({ deploymentId: 'b-prod', kind: 'stop', name: 'b' });
  const s = stagePending(['a-prod', 'b-prod'], snapshot());
  assert.equal(s.count, 2);
  assert.equal(s.label, '2 actions of yours in flight on this stage');
});

test('the power row reads only power actions, so a member restart cannot lock Wake', () => {
  resetPendingActions();
  begin({ deploymentId: 'a-prod', name: 'a' });
  const s = stagePending(['a-prod'], snapshot(), { kinds: ['wake', 'sleep'] });
  assert.equal(s.count, 0);
  assert.equal(s.label, '');
});

test('a member the server never touched can be dropped without a verdict', () => {
  resetPendingActions();
  begin({ deploymentId: 'a-prod', kind: 'sleep', name: 'Production', groupId: 'g2', groupTotal: 2 });
  begin({ deploymentId: 'b-prod', kind: 'sleep', name: 'Production', groupId: 'g2', groupTotal: 2 });
  dropPending('b-prod');
  const s = stagePending(['a-prod', 'b-prod'], snapshot(), { kinds: ['sleep'] });
  assert.equal(s.count, 1);
});

test('a wake reads as in flight per member until the last one is up', () => {
  resetPendingActions();
  for (const id of ['a-prod', 'b-prod']) {
    begin({ deploymentId: id, kind: 'wake', name: 'Production', groupId: 'g3', groupTotal: 2 });
  }
  pendingIssued('a-prod');
  pendingIssued('b-prod');
  observePending([
    automation({ deployment_id: 'a-prod', state: 'running' }),
    automation({ deployment_id: 'b-prod', state: 'exited' }),
  ]);
  assert.equal(currentPending('a-prod'), undefined, 'this one is up');
  assert.ok(currentPending('b-prod'), 'that one is not');
  observePending([
    automation({ deployment_id: 'a-prod', state: 'running' }),
    automation({ deployment_id: 'b-prod', state: 'running' }),
  ]);
  assert.equal(currentPending('b-prod'), undefined);
});

function snapshot() {
  return pendingSnapshot();
}
function currentPending(id: string) {
  return pendingSnapshot().get(id);
}

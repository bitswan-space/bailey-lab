import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedForBp, deployReadiness } from './deployReadiness.ts';

const BP = 'test33';
const level = { ahead_bp: 0, behind_bp: 0 };

test('a copy level with main and with nothing uncommitted is up to date', () => {
  const r = deployReadiness({
    divergence: level,
    changed: [],
    changedUnknown: false,
    bpDir: BP,
  });
  assert.equal(r.known, true);
  assert.equal(r.upToDate, true);
  assert.equal(r.actionable, false);
});

test('a divergence that has not been read yet is NOT "up to date"', () => {
  // The bug this pins: a pending read rendered as a confident green badge, so
  // a copy with work to publish looked clean until the next git event.
  const r = deployReadiness({
    divergence: null,
    changed: [],
    changedUnknown: false,
    bpDir: BP,
  });
  assert.equal(r.known, false);
  assert.equal(r.upToDate, false);
  assert.equal(r.actionable, true);
});

test('an unread change list is NOT "up to date" either, even level with main', () => {
  // The same bug in the other half of the sentence, and the one users hit:
  // save the Description, open Deploy, get told there is nothing to publish
  // because the uncommitted-work list had not come back (or its read failed
  // and was swallowed into an empty list).
  const r = deployReadiness({
    divergence: level,
    changed: [],
    changedUnknown: true,
    bpDir: BP,
  });
  assert.equal(r.known, false);
  assert.equal(r.upToDate, false);
  assert.equal(r.actionable, true);
});

test('uncommitted work in THIS business process makes it actionable', () => {
  const r = deployReadiness({
    divergence: level,
    changed: [{ path: `${BP}/README.md` }],
    changedUnknown: false,
    bpDir: BP,
  });
  assert.equal(r.dirty, true);
  assert.equal(r.upToDate, false);
  assert.equal(r.actionable, true);
});

test('uncommitted work in ANOTHER business process does not', () => {
  // Each process is its own repository and Deploy publishes one of them.
  const r = deployReadiness({
    divergence: level,
    changed: [{ path: 'e2eflow1/README.md' }, { path: 'test33-other/x.txt' }],
    changedUnknown: false,
    bpDir: BP,
  });
  assert.equal(r.dirty, false);
  assert.equal(r.upToDate, true);
});

test('commits to publish make it actionable but not blocked', () => {
  const r = deployReadiness({
    divergence: { ahead_bp: 1, behind_bp: 0 },
    changed: [],
    changedUnknown: false,
    bpDir: BP,
  });
  assert.equal(r.upToDate, false);
  assert.equal(r.blockedByBehind, false);
});

test('being behind main blocks publishing, whatever else is true', () => {
  for (const ahead of [0, 1, 5]) {
    const r = deployReadiness({
      divergence: { ahead_bp: ahead, behind_bp: 2 },
      changed: [],
      changedUnknown: false,
      bpDir: BP,
    });
    assert.equal(r.blockedByBehind, true, `ahead=${ahead}`);
    assert.equal(r.upToDate, false, `ahead=${ahead}`);
  }
});

test('the BP filter matches the directory and its contents, not its prefix', () => {
  const rows = [
    { path: BP },
    { path: `${BP}/backend/main.go` },
    { path: `${BP}-archive/README.md` },
    { path: 'other/README.md' },
  ];
  assert.deepEqual(
    changedForBp(rows, BP).map((c) => c.path),
    [BP, `${BP}/backend/main.go`],
  );
});

test('a business process published to main but never successfully deployed still offers Deploy', () => {
  const r = deployReadiness({
    divergence: level,
    changed: [],
    changedUnknown: false,
    bpDir: BP,
    lastDeploy: { status: 'failed', cause: 'disk_full', error: 'No space left on device' },
  });
  assert.equal(r.upToDate, false);
  assert.equal(r.actionable, true);
  assert.equal(r.lastDeployFailed, true);
  assert.equal(r.retryOnly, true);
  assert.equal(r.blockedByBehind, false);
});

test('a failed deploy with commits still to publish is not retry-only', () => {
  const r = deployReadiness({
    divergence: { ahead_bp: 2, behind_bp: 0 },
    changed: [{ path: `${BP}/README.md` }],
    changedUnknown: false,
    bpDir: BP,
    lastDeploy: { status: 'failed', cause: 'disk_full' },
  });
  assert.equal(r.lastDeployFailed, true);
  assert.equal(r.retryOnly, false);
  assert.equal(r.actionable, true);
});

test('a last deploy that succeeded leaves the up-to-date reading alone', () => {
  const r = deployReadiness({
    divergence: level,
    changed: [],
    changedUnknown: false,
    bpDir: BP,
    lastDeploy: { status: 'completed' },
  });
  assert.equal(r.lastDeployFailed, false);
  assert.equal(r.upToDate, true);
  assert.equal(r.retryOnly, false);
});

test('a business process with no recorded deploy outcome is neither failed nor blocked', () => {
  for (const lastDeploy of [null, undefined]) {
    const r = deployReadiness({
      divergence: level,
      changed: [],
      changedUnknown: false,
      bpDir: BP,
      lastDeploy,
    });
    assert.equal(r.lastDeployFailed, false, String(lastDeploy));
    assert.equal(r.upToDate, true, String(lastDeploy));
  }
});

// --- the requirement-test gate ----------------------------------------------
//
// Deploy is blocked until the tests for the code being published pass. The
// rules that matter most are the ones about what does NOT block: a BP with no
// requirements, and a requirement nobody has written a test for.

const ahead = { ahead_bp: 1, behind_bp: 0 };

function testState(over: Partial<import('./api').TestState> = {}) {
  return {
    run_id: 'r1',
    copy: 'dev1',
    bp: BP,
    head_sha: 'abc1234',
    head_subject: 'wip',
    status: 'completed' as const,
    stale: false,
    green: true,
    error: null,
    counts: {
      queued: 0,
      running: 0,
      pass: 1,
      fail: 0,
      no_test: 0,
      blocked: 0,
    },
    requirements: [],
    started_at: '',
    completed_at: null,
    ...over,
  };
}

test('a business process with nothing testable is never gated on tests', () => {
  // "No tests" is not "failing tests". Gating here would stop every BP that
  // has not adopted the feature from ever deploying again.
  const r = deployReadiness({
    divergence: ahead,
    changed: [],
    changedUnknown: false,
    bpDir: BP,
    tests: null,
    hasTestedRequirements: false,
  });
  assert.equal(r.blockedByTests, false);
  assert.equal(r.actionable, true);
});

test('requirements that exist but have never been run block the deploy', () => {
  const r = deployReadiness({
    divergence: ahead,
    changed: [],
    changedUnknown: false,
    bpDir: BP,
    tests: null,
    hasTestedRequirements: true,
  });
  assert.equal(r.blockedByTests, true);
  assert.match(r.testsReason, /have not run/i);
});

test('a failing run blocks, and says how many', () => {
  const r = deployReadiness({
    divergence: ahead,
    changed: [],
    changedUnknown: false,
    bpDir: BP,
    hasTestedRequirements: true,
    tests: testState({
      green: false,
      counts: { queued: 0, running: 0, pass: 1, fail: 2, no_test: 0, blocked: 1 },
    }),
  });
  assert.equal(r.blockedByTests, true);
  assert.match(r.testsReason, /3 test\(s\) are not passing/);
});

test('a run in flight blocks, and is reported as running rather than failing', () => {
  const r = deployReadiness({
    divergence: ahead,
    changed: [],
    changedUnknown: false,
    bpDir: BP,
    hasTestedRequirements: true,
    tests: testState({
      status: 'running',
      green: false,
      counts: { queued: 2, running: 1, pass: 0, fail: 0, no_test: 0, blocked: 0 },
    }),
  });
  assert.equal(r.testsRunning, true);
  assert.equal(r.blockedByTests, true);
  assert.match(r.testsReason, /3 test\(s\) still running/);
});

test('a stale green run blocks — its verdicts describe code that changed since', () => {
  const r = deployReadiness({
    divergence: ahead,
    changed: [],
    changedUnknown: false,
    bpDir: BP,
    hasTestedRequirements: true,
    tests: testState({ stale: true, green: false }),
  });
  assert.equal(r.blockedByTests, true);
  assert.match(r.testsReason, /code changed/i);
});

test('requirements with no test do not block a green run', () => {
  const r = deployReadiness({
    divergence: ahead,
    changed: [],
    changedUnknown: false,
    bpDir: BP,
    hasTestedRequirements: true,
    tests: testState({
      counts: { queued: 0, running: 0, pass: 1, fail: 0, no_test: 4, blocked: 0 },
    }),
  });
  assert.equal(r.blockedByTests, false);
});

test('nothing to publish is never "blocked by tests"', () => {
  // There is no deploy to stop, so complaining about tests would be noise
  // about work that already shipped.
  const r = deployReadiness({
    divergence: level,
    changed: [],
    changedUnknown: false,
    bpDir: BP,
    hasTestedRequirements: true,
    tests: null,
  });
  assert.equal(r.upToDate, true);
  assert.equal(r.blockedByTests, false);
  assert.equal(r.testsReason, '');
});

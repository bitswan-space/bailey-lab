import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestState } from './api.ts';
import { SUMMARY_TONES, VERDICT_TONES, summarizeTests } from './testStatus.ts';

function state(over: Partial<TestState> = {}): TestState {
  return {
    run_id: 'r1',
    copy: 'dev1',
    bp: 'shop',
    head_sha: 'abc1234',
    head_subject: 'wip',
    status: 'completed',
    stale: false,
    green: true,
    error: null,
    counts: { queued: 0, running: 0, pass: 2, fail: 0, no_test: 0, blocked: 0 },
    requirements: [],
    started_at: '',
    completed_at: null,
    ...over,
  };
}

test('a clean completed run is passing', () => {
  assert.equal(summarizeTests(state()), 'passing');
});

test('failing beats running', () => {
  // A suite still working through the rest of the list has already told you
  // something is broken; hiding that behind a spinner until the run ends would
  // be the one moment the indicator misleads.
  const s = state({
    status: 'running',
    green: false,
    counts: { queued: 3, running: 1, pass: 1, fail: 1, no_test: 0, blocked: 0 },
  });
  assert.equal(summarizeTests(s), 'failing');
});

test('a blocked requirement counts as failing', () => {
  const s = state({
    green: false,
    counts: { queued: 0, running: 0, pass: 1, fail: 0, no_test: 0, blocked: 2 },
  });
  assert.equal(summarizeTests(s), 'failing');
});

test('a clean run in flight is running', () => {
  const s = state({
    status: 'running',
    green: false,
    counts: { queued: 2, running: 1, pass: 0, fail: 0, no_test: 0, blocked: 0 },
  });
  assert.equal(summarizeTests(s), 'running');
});

test('a stale run is neither passing nor failing', () => {
  assert.equal(summarizeTests(state({ stale: true, green: false })), 'unknown');
});

test('no run at all is unknown', () => {
  assert.equal(summarizeTests(null), 'unknown');
  assert.equal(summarizeTests(undefined), 'unknown');
});

test('requirements with no test do not make a run look failing', () => {
  const s = state({
    counts: { queued: 0, running: 0, pass: 1, fail: 0, no_test: 5, blocked: 0 },
  });
  assert.equal(summarizeTests(s), 'passing');
});

test('the indicator reuses the badge tones rather than its own palette', () => {
  // The point of the shared map: a green check in the nav and a green `pass`
  // pill in the table are the same claim, so they must be the same colour.
  assert.equal(SUMMARY_TONES.passing, VERDICT_TONES.pass.fg);
  assert.equal(SUMMARY_TONES.failing, VERDICT_TONES.fail.fg);
  assert.equal(SUMMARY_TONES.running, VERDICT_TONES.blocked.fg);
});

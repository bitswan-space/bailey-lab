import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReqVerdict, TestState } from './api.ts';
import {
  SUMMARY_TONES,
  VERDICT_TONES,
  rowVerdict,
  summarizeTests,
} from './testStatus.ts';

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

// --- what a row shows --------------------------------------------------------

function res(verdict: ReqVerdict, previous: ReqVerdict | '' = '') {
  return { verdict, previous_verdict: previous };
}

test('a freshly added requirement reads "no test", not "queued"', () => {
  // The reported bug: adding a requirement badged it `queued`, promising a run
  // nobody had started — and contradicting the group it was filed under.
  const shown = rowVerdict(null, undefined, false);
  assert.equal(shown.verdict, 'no_test');
  assert.equal(shown.stale, false);
});

test('a requirement that HAS a test but no verdict reads "not run"', () => {
  // Saying "no test" here would be just as wrong in the other direction.
  assert.equal(rowVerdict(null, true, false).verdict, 'unknown');
});

test('a judged requirement shows its verdict', () => {
  assert.equal(rowVerdict(res('pass'), true, false).verdict, 'pass');
  assert.equal(rowVerdict(res('fail'), true, false).verdict, 'fail');
});

test('a run in flight keeps the previous commit’s answer, greyed', () => {
  const shown = rowVerdict(res('running', 'pass'), true, false);
  assert.equal(shown.verdict, 'pass');
  assert.equal(shown.stale, true);
});

test('a queued row with no previous answer shows queued', () => {
  // It is genuinely queued — a run seeded it — so the word is honest here.
  assert.equal(rowVerdict(res('queued'), true, false).verdict, 'queued');
});

test('a stale run greys the verdicts it produced', () => {
  const shown = rowVerdict(res('pass'), true, true);
  assert.equal(shown.verdict, 'pass');
  assert.equal(shown.stale, true);
});

test('"not run" is not styled as a claim about passing or failing', () => {
  assert.equal(VERDICT_TONES.unknown.label, 'not run');
  assert.notEqual(VERDICT_TONES.unknown.fg, VERDICT_TONES.pass.fg);
  assert.notEqual(VERDICT_TONES.unknown.fg, VERDICT_TONES.fail.fg);
});

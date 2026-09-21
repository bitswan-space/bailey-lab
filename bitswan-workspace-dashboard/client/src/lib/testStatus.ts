import type { ReqVerdict, TestState } from '@/lib/api';

/**
 * The one place requirement-test status becomes a colour.
 *
 * The row badge, the nav indicator and the tab's summary counts all read from
 * here, so a verdict cannot be green in one surface and grey in another — the
 * kind of drift that makes a status display untrustworthy precisely when
 * someone is relying on it.
 */

/**
 * What a row can show, which is one more thing than a run can produce:
 * `unknown` means no run has judged this requirement yet.
 *
 * It is display-only and deliberately NOT part of `ReqVerdict` — that is the
 * wire type, and its `counts` record would then demand a key gitops never
 * sends.
 */
export type DisplayVerdict = ReqVerdict | 'unknown';

export interface VerdictTone {
  /** Badge background + text, for the pill form. */
  badge: string;
  /** Foreground only, for an icon or a count. */
  fg: string;
  label: string;
}

export const VERDICT_TONES: Record<DisplayVerdict, VerdictTone> = {
  // Not "queued": nothing is waiting to run. This is a requirement no run has
  // reached yet — after a restart, or before the first one.
  unknown: {
    badge: 'bg-slate-100 text-slate-600',
    fg: 'text-slate-600',
    label: 'not run',
  },
  pass: { badge: 'bg-green-100 text-green-700', fg: 'text-green-700', label: 'pass' },
  fail: { badge: 'bg-red-100 text-red-700', fg: 'text-red-700', label: 'fail' },
  // Amber, not red: a blocked child has not failed — it was never run, because
  // its parent is a precondition and that parent is broken.
  blocked: {
    badge: 'bg-amber-100 text-amber-700',
    fg: 'text-amber-700',
    label: 'blocked',
  },
  no_test: {
    badge: 'bg-slate-100 text-slate-600',
    fg: 'text-slate-600',
    label: 'no test',
  },
  queued: {
    badge: 'bg-slate-100 text-slate-600',
    fg: 'text-slate-600',
    label: 'queued',
  },
  running: { badge: 'bg-blue-100 text-blue-700', fg: 'text-blue-700', label: 'running' },
};

/** Tone for a verdict that belongs to an earlier commit than the code on disk. */
export const STALE_TONE: VerdictTone = {
  badge: 'bg-slate-100 text-slate-400',
  fg: 'text-slate-400',
  label: '',
};

/**
 * A whole BP's test state boiled down to the one thing a glance needs: is it
 * broken, is it working on it, or is it good?
 */
export type TestSummary = 'passing' | 'failing' | 'running' | 'unknown';

export const SUMMARY_TONES: Record<TestSummary, string> = {
  // Deliberately the same tones as the verdicts above: a green check in the nav
  // and a green `pass` pill in the table are the same claim.
  passing: VERDICT_TONES.pass.fg,
  failing: VERDICT_TONES.fail.fg,
  running: VERDICT_TONES.blocked.fg, // amber — work in progress, not a failure
  unknown: 'text-slate-400',
};

export const SUMMARY_LABELS: Record<TestSummary, string> = {
  passing: 'All tests passing',
  failing: 'Tests are not passing',
  running: 'Tests are running',
  unknown: 'Tests are out of date',
};

/**
 * Failing beats running: a suite that is still working through the rest of the
 * list has already told you something is broken, and hiding that behind a
 * spinner until the run ends would be the one moment the indicator misleads.
 */
export function summarizeTests(state: TestState | null | undefined): TestSummary {
  if (!state) return 'unknown';
  if (state.counts.fail + state.counts.blocked > 0) return 'failing';
  if (state.status === 'running') return 'running';
  if (state.green) return 'passing';
  return 'unknown';
}

/**
 * What one row shows: the verdict and whether it is stale.
 *
 * Three cases, and the point is that none of them overstates what is known:
 *
 *  - a run has judged it → its verdict, unless the run is still working on
 *    this row and the previous commit had an answer, which is shown greyed
 *    rather than blanking the table on every commit;
 *  - no run has judged it and no test carries its id → `no_test`;
 *  - no run has judged it but a test exists → `unknown`, i.e. "not run".
 *
 * That last split is why a freshly added requirement no longer claims to be
 * `queued` for a run nobody started.
 */
export function rowVerdict(
  result:
    | { verdict: ReqVerdict; previous_verdict: ReqVerdict | '' }
    | null
    | undefined,
  hasTest: boolean | undefined,
  runIsStale: boolean,
): { verdict: DisplayVerdict; stale: boolean } {
  if (!result) {
    return { verdict: hasTest ? 'unknown' : 'no_test', stale: false };
  }
  const pending = result.verdict === 'queued' || result.verdict === 'running';
  if (pending && result.previous_verdict) {
    return { verdict: result.previous_verdict, stale: true };
  }
  return { verdict: result.verdict, stale: runIsStale };
}

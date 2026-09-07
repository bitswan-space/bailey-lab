import type { ReqStatus } from '@/lib/api';

interface Props {
  status: ReqStatus;
}

/**
 * Pill badge for a requirement's status. Colours and geometry match the
 * design's requirements table (compact 9px/700 uppercase chips); `pass`,
 * `fail`, `retest` and `pending` map onto the design's pass/fail/review/todo
 * tones, and `proposed` uses violet so AI-proposed rows pop visually.
 *
 * DISPLAY ONLY (#448). It used to be a button that cycled through all five
 * states, which let a click assert `pass` or `fail` — claims only a test run
 * can honestly make, on a requirement that may have no test at all — and
 * `proposed`, which belongs to the agent and pairs with the `AI-` id prefix.
 * The two things a person legitimately does are actions on the row instead:
 * accept a proposal, or send a passing requirement back to be re-checked.
 */
export function StatusBadge({ status }: Props) {
  const styles: Record<ReqStatus, string> = {
    pass: 'bg-green-100 text-green-700',
    fail: 'bg-red-100 text-red-700',
    retest: 'bg-amber-100 text-amber-700',
    pending: 'bg-slate-100 text-slate-600',
    proposed: 'bg-violet-100 text-violet-700',
  };
  const className = `inline-flex items-center rounded-[3px] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${styles[status]}`;
  return <span className={className}>{status}</span>;
}

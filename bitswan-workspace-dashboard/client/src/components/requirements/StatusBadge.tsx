import type { ReqVerdict } from '@/lib/api';

interface Props {
  verdict: ReqVerdict;
  /**
   * True when this verdict belongs to an earlier commit than the code on disk.
   * Rendered muted rather than hidden: knowing what was true last time is
   * useful, as long as nothing pretends it is true now.
   */
  stale?: boolean;
}

const LABELS: Record<ReqVerdict, string> = {
  pass: 'pass',
  fail: 'fail',
  blocked: 'blocked',
  no_test: 'no test',
  queued: 'queued',
  running: 'running',
};

const STYLES: Record<ReqVerdict, string> = {
  pass: 'bg-green-100 text-green-700',
  fail: 'bg-red-100 text-red-700',
  // Amber, not red: a blocked child has not failed — it was never run, because
  // its parent is a precondition and that parent is broken.
  blocked: 'bg-amber-100 text-amber-700',
  no_test: 'bg-slate-100 text-slate-600',
  queued: 'bg-slate-100 text-slate-600',
  running: 'bg-blue-100 text-blue-700',
};

/**
 * Pill badge for a requirement's verdict.
 *
 * DISPLAY ONLY, and now structurally so: a verdict is produced by running a
 * test and there is no longer any code path — UI, API or file — by which a
 * person can assert one. This badge reports; it never offers.
 */
export function StatusBadge({ verdict, stale = false }: Props) {
  const tone = stale ? 'bg-slate-100 text-slate-400' : STYLES[verdict];
  return (
    <span
      className={`inline-flex items-center rounded-[3px] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${tone}`}
      title={stale ? 'From the previous commit — the code has changed since' : undefined}
    >
      {LABELS[verdict]}
    </span>
  );
}

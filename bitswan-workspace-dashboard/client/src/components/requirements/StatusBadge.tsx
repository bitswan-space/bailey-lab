import type { ReqStatus } from '@/lib/api';

interface Props {
  status: ReqStatus;
  /** Render as a button so consumers can wire `onClick` (cycle status). */
  onClick?: () => void;
  ariaLabel?: string;
}

/**
 * Pill badge for a requirement's status. Colours and geometry match the
 * design's requirements table (compact 9px/700 uppercase chips); `pass`,
 * `fail`, `retest` and `pending` map onto the design's pass/fail/review/todo
 * tones, and `proposed` uses violet so AI-proposed rows pop visually.
 */
export function StatusBadge({ status, onClick, ariaLabel }: Props) {
  const styles: Record<ReqStatus, string> = {
    pass: 'bg-green-100 text-green-700',
    fail: 'bg-red-100 text-red-700',
    retest: 'bg-amber-100 text-amber-700',
    pending: 'bg-slate-100 text-slate-600',
    proposed: 'bg-violet-100 text-violet-700',
  };
  const className = `inline-flex items-center rounded-[3px] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${styles[status]}`;
  if (onClick) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        className={`${className} cursor-pointer transition-colors hover:brightness-95`}
        aria-label={ariaLabel ?? `Cycle status (currently ${status})`}
      >
        {status}
      </button>
    );
  }
  return <span className={className}>{status}</span>;
}

/** Next status in the user-facing cycle. */
export function nextStatus(status: ReqStatus): ReqStatus {
  const order: ReqStatus[] = ['pending', 'pass', 'fail', 'retest', 'proposed'];
  const idx = order.indexOf(status);
  return order[(idx + 1) % order.length]!;
}

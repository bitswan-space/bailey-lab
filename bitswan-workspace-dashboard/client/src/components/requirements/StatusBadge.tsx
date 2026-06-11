import type { ReqStatus } from '@/lib/api';

interface Props {
  status: ReqStatus;
  /** Render as a button so consumers can wire `onClick` (cycle status). */
  onClick?: () => void;
  ariaLabel?: string;
}

/**
 * Pill badge for a requirement's status. Five colours from Tailwind's
 * standard palette to keep contrast against the dashboard's light bg.
 * `proposed` uses violet so AI-proposed rows pop visually.
 */
export function StatusBadge({ status, onClick, ariaLabel }: Props) {
  const styles: Record<ReqStatus, string> = {
    pass: 'bg-emerald-100 text-emerald-700',
    fail: 'bg-red-100 text-red-700',
    retest: 'bg-amber-100 text-amber-700',
    pending: 'bg-zinc-100 text-zinc-600',
    proposed: 'bg-violet-100 text-violet-700',
  };
  const className = `inline-flex h-5 items-center rounded px-1.5 text-[10px] font-semibold uppercase tracking-wide ${styles[status]}`;
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

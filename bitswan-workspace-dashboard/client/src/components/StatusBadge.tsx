import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { AutomationState } from '@/types';

export type DisplayStatus =
  | 'running'
  | 'restarting'
  | 'stopped'
  | 'failed'
  | 'not-deployed'
  | 'building'
  | 'deployed'
  | 'unknown';

const TONES: Record<DisplayStatus, { dot: string; label: string; className: string }> = {
  running: {
    dot: 'bg-emerald-500',
    label: 'Running',
    className: 'border-transparent bg-emerald-100 text-emerald-700',
  },
  deployed: {
    dot: 'bg-emerald-500',
    label: 'Deployed',
    className: 'border-transparent bg-emerald-100 text-emerald-700',
  },
  restarting: {
    dot: 'bg-violet-500',
    label: 'Restarting',
    className: 'border-transparent bg-violet-100 text-violet-700',
  },
  building: {
    dot: 'bg-primary',
    label: 'Building',
    className: 'border-transparent bg-blue-100 text-blue-700',
  },
  stopped: {
    dot: 'bg-red-500',
    label: 'Stopped',
    className: 'border-transparent bg-red-100 text-red-700',
  },
  failed: {
    dot: 'bg-red-500',
    label: 'Failed',
    className: 'border-transparent bg-red-100 text-red-700',
  },
  'not-deployed': {
    dot: 'bg-zinc-400',
    label: 'Not deployed',
    className: 'border-transparent bg-zinc-100 text-zinc-600',
  },
  unknown: {
    dot: 'bg-zinc-400',
    label: '—',
    className: 'border-transparent bg-zinc-100 text-zinc-600',
  },
};

interface StatusBadgeProps {
  status: DisplayStatus;
  className?: string;
  label?: string;
}

export function StatusBadge({ status, className, label }: StatusBadgeProps) {
  const t = TONES[status];
  return (
    <Badge
      variant="outline"
      className={cn(
        'gap-1 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide',
        t.className,
        className,
      )}
    >
      <span className={cn('size-1.5 rounded-full', t.dot)} aria-hidden />
      {label ?? t.label}
    </Badge>
  );
}

// Map an automation's container state (the raw `state` field from
// DeployedAutomation in bitswan-gitops) to our display status.
export function stateToDisplay(state: AutomationState | null | undefined): DisplayStatus {
  switch (state) {
    case 'running':
    case 'starting':
    case 'created':
      return 'running';
    case 'restarting':
      return 'restarting';
    case 'exited':
    case 'dead':
    case 'paused':
      return 'stopped';
    default:
      return 'unknown';
  }
}

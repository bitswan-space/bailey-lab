import { Loader2 } from 'lucide-react';

import { useNow } from '@/hooks/useNow';
import { cn } from '@/lib/utils';
import { pendingLabel, pendingSentence, type PendingAction } from '@/lib/pendingActions';

interface PendingActionMarkProps {
  pending?: PendingAction;
  density: 'dot' | 'chip' | 'line';
  className?: string;
}

export function PendingActionMark({ pending, density, className }: PendingActionMarkProps) {
  if (!pending) return null;
  return <Mark pending={pending} density={density} className={className} />;
}

function Mark({ pending, density, className }: PendingActionMarkProps & { pending: PendingAction }) {
  const now = useNow();
  const sentence = pendingSentence(pending, now);
  const size = density === 'dot' ? 'size-3' : 'size-3.5';
  return (
    <span
      className={cn('inline-flex shrink-0 items-center gap-1 text-primary', className)}
      title={sentence}
      aria-live="polite"
    >
      <Loader2 className={cn(size, 'animate-spin')} aria-hidden />
      {density === 'dot' ? (
        <span className="sr-only">{sentence}</span>
      ) : (
        <span className={density === 'line' ? 'text-[11px]' : 'text-[11px] font-medium'}>
          {density === 'line' ? sentence : pendingLabel(pending)}
        </span>
      )}
    </span>
  );
}

interface StagePendingMarkProps {
  label: string;
  density: 'dot' | 'line';
  className?: string;
}

export function StagePendingMark({ label, density, className }: StagePendingMarkProps) {
  if (!label) return null;
  return (
    <span
      className={cn('inline-flex shrink-0 items-center gap-1 text-primary', className)}
      title={label}
      aria-live="polite"
    >
      <Loader2 className={cn(density === 'dot' ? 'size-3' : 'size-3.5', 'animate-spin')} aria-hidden />
      {density === 'line' ? <span className="text-[11px]">{label}</span> : <span className="sr-only">{label}</span>}
    </span>
  );
}

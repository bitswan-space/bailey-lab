import { Loader2 } from 'lucide-react';

import { useNow } from '@/hooks/useNow';
import { cn } from '@/lib/utils';
import { pendingLabel, pendingSentence, type PendingAction } from '@/lib/pendingActions';

interface PendingActionMarkProps {
  /** Nothing in flight → renders nothing at all. */
  pending?: PendingAction;
  /**
   * `dot` for dense list rows (the spinner alone), `chip` for a card or panel
   * header (spinner + "Restarting…"), `line` for the stage card's own row (the
   * full sentence).
   */
  density: 'dot' | 'chip' | 'line';
  className?: string;
}

/**
 * "An action of yours is in flight here" — rendered BESIDE the observed
 * container state, never instead of it (bailey-lab #476).
 *
 * The four things that keep it from being mistaken for #465's violet ↻, which
 * means "this container keeps dying on its own":
 *
 *   * COLOUR — violet is spoken for, and so are emerald, red, sky, blue and
 *     zinc in STATUS_META. `text-primary` is already this dashboard's colour
 *     for an action of yours running (the Promote button, the stage card's
 *     deploy-progress line).
 *   * MOTION — every observed state is a static dot. Nothing merely observed
 *     spins.
 *   * GRAMMAR — observed states are third-person adjectives ("Restarting",
 *     "Stopped"); this is first person and names the actor ("You restarted this
 *     4 minutes ago — waiting for it to come back up").
 *   * POSITION — always added next to the dot, label or badge, which are left
 *     exactly as they were. That is also how the momentary "1 service not
 *     running" an operator's own restart can flash is answered: the fault text
 *     is not softened, it gains the context that explains it.
 */
export function PendingActionMark({ pending, density, className }: PendingActionMarkProps) {
  const now = useNow();
  if (!pending) return null;
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
  /** The stage's aggregate label; empty string → renders nothing. */
  label: string;
  density: 'dot' | 'line';
  className?: string;
}

/**
 * The same signal for a whole stage — the stage card's second line and the
 * pipeline node's second marker. It takes the already-computed aggregate label
 * (see `stagePending`) rather than a member's entry, because one stage Wake is
 * one action even though it has three members.
 */
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

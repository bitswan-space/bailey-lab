import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import type { TestState } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  SUMMARY_LABELS,
  SUMMARY_TONES,
  summarizeTests,
  type TestSummary,
} from '@/lib/testStatus';

interface Props {
  state: TestState | null | undefined;
  className?: string;
  /**
   * Decorative by default: inside a button (the nav tab) an accessible name
   * here would append the status to that button's name, renaming the control
   * every time a run moves.
   */
  decorative?: boolean;
}

const ICONS: Record<TestSummary, typeof CheckCircle2> = {
  passing: CheckCircle2,
  failing: XCircle,
  running: Loader2,
  unknown: Loader2,
};

/**
 * CI-style status icon for a business process's requirement tests: a green
 * check when everything passes, a red cross when something does not, an amber
 * spinner while a run is in flight — in the same tones the row badges use.
 *
 * Shape carries the meaning as well as colour, so the state survives a
 * colour-blind reader and a greyscale screenshot, which a coloured dot could
 * not. The tooltip lives on the wrapper because a `title` ATTRIBUTE on an
 * `<svg>` shows nothing — SVG needs a `<title>` child, and a span sidesteps it.
 */
export function TestStatusIcon({ state, className, decorative = true }: Props) {
  const summary = summarizeTests(state);
  if (!state) return null;
  const Icon = ICONS[summary];
  const label = SUMMARY_LABELS[summary];
  return (
    <span
      title={label}
      className="inline-flex shrink-0 items-center"
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
    >
      <Icon
        className={cn(
          'size-3.5 shrink-0',
          SUMMARY_TONES[summary],
          summary === 'running' && 'animate-spin',
          className,
        )}
        aria-hidden
      />
    </span>
  );
}

import { useNow } from '@/hooks/useNow';
import { formatAbsolute, formatRelative, NO_DATE, type WhenInput } from '@/lib/format-date';

interface RelativeTimeProps {
  value: WhenInput;
  className?: string;
  /** 'short' → "2m ago", for dense timelines that need a narrow column. */
  variant?: 'long' | 'short';
  /** Shown instead of the em-dash when there is no usable timestamp. */
  fallback?: string;
}

/**
 * A timestamp rendered the way the whole dashboard renders timestamps: a live
 * relative label ("2 minutes ago") that ages on screen, with the exact UTC
 * instant on hover.
 */
export function RelativeTime({ value, className, variant, fallback }: RelativeTimeProps) {
  const now = useNow();
  const title = formatAbsolute(value);
  const label = title ? formatRelative(value, { variant, now }) : (fallback ?? NO_DATE);
  return (
    <span className={className} title={title || undefined}>
      {label}
    </span>
  );
}

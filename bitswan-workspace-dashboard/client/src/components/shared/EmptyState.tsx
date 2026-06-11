import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  message: ReactNode;
  className?: string;
}

/**
 * Dashed-border placeholder used for empty / loading / not-deployed states.
 */
export function EmptyState({ message, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'rounded-xl border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground',
        className,
      )}
    >
      {message}
    </div>
  );
}

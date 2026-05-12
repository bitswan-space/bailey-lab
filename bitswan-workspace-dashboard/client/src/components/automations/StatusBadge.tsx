import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { STATUS_META, type DisplayStatus } from '@/lib/status';

interface StatusBadgeProps {
  status: DisplayStatus;
  className?: string;
  label?: string;
}

export function StatusBadge({ status, className, label }: StatusBadgeProps) {
  const meta = STATUS_META[status];
  return (
    <Badge
      variant="outline"
      className={cn(
        'gap-1 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide',
        meta.badge,
        className,
      )}
    >
      <span className={cn('size-1.5 rounded-full', meta.dot)} aria-hidden />
      {label ?? meta.label}
    </Badge>
  );
}

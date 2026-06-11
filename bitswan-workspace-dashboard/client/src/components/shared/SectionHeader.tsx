import type { ReactNode } from 'react';

interface SectionHeaderProps {
  eyebrow: string;
  title: string;
  helper?: ReactNode;
  right?: ReactNode;
}

/**
 * The "eyebrow + title + helper" header that prefaces each section in the
 * Deployments / Worktree / README views. Optional `right` slot for inline
 * actions.
 */
export function SectionHeader({ eyebrow, title, helper, right }: SectionHeaderProps) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {eyebrow}
        </div>
        <div className="text-lg font-semibold tracking-tight text-foreground">{title}</div>
        {helper && <div className="mt-0.5 text-sm text-muted-foreground">{helper}</div>}
      </div>
      {right}
    </div>
  );
}

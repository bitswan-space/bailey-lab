import { GitBranch, Rocket, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Scope, Worktree } from '@/types';

interface TopBarProps {
  scope: Scope;
  onScope: (s: Scope) => void;
  worktrees: Worktree[];
}

export function TopBar({ scope, onScope, worktrees }: TopBarProps) {
  const isDeployments = scope.type === 'deployments';

  return (
    <div className="flex items-stretch border-b border-border bg-background px-6 pt-3.5">
      <SwitchTab
        active={isDeployments}
        onClick={() => onScope({ type: 'deployments' })}
        Icon={Rocket}
        label="Deployments"
        sub="dev · staging · production"
      />
      {worktrees.length > 0 && (
        <div className="my-2 mx-3 w-px self-stretch bg-border" aria-hidden />
      )}
      {worktrees.map((wt) => {
        const active = scope.type === 'worktree' && scope.name === wt.name;
        return (
          <SwitchTab
            key={wt.name}
            active={active}
            onClick={() => onScope({ type: 'worktree', name: wt.name })}
            Icon={GitBranch}
            label={wt.name}
            sub={wt.synced ? 'synced' : 'unsynced'}
            tone={wt.synced ? 'success' : 'warning'}
          />
        );
      })}
    </div>
  );
}

interface SwitchTabProps {
  active: boolean;
  onClick: () => void;
  Icon: LucideIcon;
  label: string;
  sub?: string;
  tone?: 'default' | 'success' | 'warning';
}

function SwitchTab({ active, onClick, Icon, label, sub, tone = 'default' }: SwitchTabProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        // 2-col grid: icon column (auto) + label/sub column (1fr).
        // The sub-label lives in row 2 col 2 — naturally aligned under the
        // label without a hand-tuned padding offset.
        'grid min-w-32 grid-cols-[auto_1fr] items-center gap-x-1.5 gap-y-0.5 border-b-2 px-3.5 pb-2.5 pt-2 transition-colors',
        active
          ? 'border-primary bg-background'
          : 'border-transparent text-zinc-600 hover:bg-muted/40',
      )}
    >
      <Icon
        className={cn('size-3.5', active ? 'text-primary' : 'text-muted-foreground')}
        aria-hidden
      />
      <span
        className={cn(
          'text-left text-sm',
          active ? 'font-semibold text-foreground' : 'font-medium',
        )}
      >
        {label}
      </span>
      {sub && (
        <span
          className={cn(
            'col-start-2 text-left text-xs font-medium',
            tone === 'success'
              ? 'text-emerald-600'
              : tone === 'warning'
                ? 'text-amber-600'
                : 'text-muted-foreground',
          )}
        >
          {sub}
        </span>
      )}
    </button>
  );
}

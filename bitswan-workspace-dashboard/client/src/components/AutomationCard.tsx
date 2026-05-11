import { Cog } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { StatusBadge, stateToDisplay, type DisplayStatus } from './StatusBadge';
import type { DeployedAutomation } from '@/types';

interface StageRow {
  id: string;
  label: string;
  automation: DeployedAutomation | undefined;
}

interface AutomationCardProps {
  name: string;
  stages: StageRow[];
}

export function AutomationCard({ name, stages }: AutomationCardProps) {
  return (
    <Card className="flex flex-col overflow-hidden rounded-xl border border-border bg-background shadow-sm">
      <header className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
        <div className="inline-flex size-7 items-center justify-center rounded-md bg-muted">
          <Cog className="size-4 text-muted-foreground" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">{name}</div>
          <div className="text-xs text-muted-foreground">Automation</div>
        </div>
      </header>

      {stages.map((stage, i) => {
        const last = i === stages.length - 1;
        const aut = stage.automation;
        const display: DisplayStatus = aut ? stateToDisplay(aut.state) : 'not-deployed';
        const sha = aut?.version_hash?.slice(0, 7) ?? '';

        return (
          <div
            key={stage.id}
            className={cn(
              'px-4 py-3',
              !last && 'border-b border-border',
              i === 0 && 'bg-background',
              i === 1 && 'bg-zinc-50/60',
              i === 2 && 'bg-muted/30',
            )}
          >
            <div className="flex items-center gap-2">
              <span className="min-w-16 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {stage.label}
              </span>
              <StatusBadge status={display} />
              {sha && (
                <span className="ml-auto font-mono text-xs text-muted-foreground">
                  {sha}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </Card>
  );
}

import { Activity, Cog, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { stateToDisplay, type DisplayStatus } from './StatusBadge';
import type { AutomationStage, DeployedAutomation } from '@/types';

interface CardStage {
  id: AutomationStage;
  label: string;
  short: string;
  automation: DeployedAutomation | undefined;
}

interface AutomationCardProps {
  name: string;
  stages: CardStage[];
  onInspect: () => void;
}

const DOT_TONE: Record<DisplayStatus, string> = {
  running: 'bg-emerald-500',
  deployed: 'bg-emerald-500',
  restarting: 'bg-violet-500',
  building: 'bg-blue-500',
  stopped: 'bg-red-500',
  failed: 'bg-red-500',
  'not-deployed': 'bg-zinc-300',
  unknown: 'bg-zinc-300',
};

const LABEL_TONE: Record<DisplayStatus, string> = {
  running: 'text-emerald-600',
  deployed: 'text-emerald-600',
  restarting: 'text-violet-600',
  building: 'text-blue-600',
  stopped: 'text-red-600',
  failed: 'text-red-600',
  'not-deployed': 'text-muted-foreground',
  unknown: 'text-muted-foreground',
};

const LABEL_TEXT: Record<DisplayStatus, string> = {
  running: 'Running',
  deployed: 'Deployed',
  restarting: 'Restarting',
  building: 'Building',
  stopped: 'Stopped',
  failed: 'Failed',
  'not-deployed': 'Not deployed',
  unknown: '—',
};

export function AutomationCard({ name, stages, onInspect }: AutomationCardProps) {
  return (
    <Card className="overflow-hidden rounded-xl border border-border bg-background shadow-sm">
      <header className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
        <div className="inline-flex size-7 items-center justify-center rounded-md bg-muted">
          <Cog className="size-4 text-muted-foreground" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">{name}</div>
          <div className="text-xs text-muted-foreground">Automation</div>
        </div>
        <Button variant="outline" size="sm" onClick={onInspect}>
          <Activity />
          Inspect
        </Button>
      </header>

      <div
        className="grid"
        style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}
      >
        {stages.map((stage, i) => {
          const aut = stage.automation;
          const display: DisplayStatus = aut ? stateToDisplay(aut.state) : 'not-deployed';
          const sha = aut?.version_hash?.slice(0, 8) ?? '';
          const isRunning = display === 'running' || display === 'restarting';
          const openUrl = isRunning ? aut?.automation_url : null;
          const last = i === stages.length - 1;

          return (
            <div
              key={stage.id}
              className={cn('flex flex-col gap-2 justify-between p-3.5', !last && 'border-r border-border')}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-foreground">
                  {stage.short}
                </span>
                {openUrl && (
                  <Button variant="link" size="sm" asChild>
                    <a href={openUrl} target="_blank" rel="noreferrer">
                      <ExternalLink className="size-3.5 text-muted-foreground" />
                    </a>
                  </Button>
                )}
              </div>
              <div className="flex h-[18px] items-center font-mono text-xs text-muted-foreground">
                {sha === 'live-dev' ? '' : sha || '—'}
              </div>
              <div className="flex items-center gap-1">
                <span className={cn('size-2 rounded-full', DOT_TONE[display])} aria-hidden />
                <div className={cn('text-xs font-medium', LABEL_TONE[display])}>
                  {LABEL_TEXT[display]}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

import { useMemo } from 'react';
import { LayoutDashboard, TerminalSquare } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAutomations } from '@/hooks/useAutomations';
import type { BusinessProcess, DeployedAutomation, Worktree } from '@/types';
import { Terminal } from '@/Terminal';
import { AutomationCard } from './AutomationCard';

interface WorktreeViewProps {
  bp: BusinessProcess;
  wt: Worktree;
}

export function WorktreeView({ bp, wt }: WorktreeViewProps) {
  return (
    <Tabs defaultValue="overview" className="flex flex-1 flex-col overflow-hidden">
      <TabsList className="mx-7 mt-4 inline-flex w-fit shrink-0 gap-1 self-start bg-muted/40">
        <TabsTrigger value="overview" className="gap-1.5">
          <LayoutDashboard className="size-3.5" aria-hidden />
          Overview
        </TabsTrigger>
        <TabsTrigger value="agents" className="gap-1.5">
          <TerminalSquare className="size-3.5" aria-hidden />
          Agents
        </TabsTrigger>
      </TabsList>

      <TabsContent value="overview" className="flex-1 overflow-auto bg-background">
        <OverviewPane bp={bp} wt={wt} />
      </TabsContent>

      <TabsContent value="agents" className="flex-1 overflow-hidden bg-white">
        <Terminal />
      </TabsContent>
    </Tabs>
  );
}

function OverviewPane({ bp, wt }: { bp: BusinessProcess; wt: Worktree }) {
  const { data: raw, status } = useAutomations();
  const prefix = `worktrees/${wt.name}/${bp.name}`;

  const automations = useMemo(() => {
    const out: { name: string; aut: DeployedAutomation }[] = [];
    for (const a of raw) {
      const rel = a.relative_path ?? '';
      if (rel === prefix || rel.startsWith(`${prefix}/`)) {
        out.push({ name: a.automation_name ?? a.name, aut: a });
      }
    }
    return out.sort((x, y) => x.name.localeCompare(y.name));
  }, [raw, prefix]);

  return (
    <div className="flex flex-col gap-5 px-7 py-6">
      <div>
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Worktree
        </div>
        <div className="text-lg font-semibold tracking-tight text-foreground">
          {wt.name}
        </div>
        <div className="mt-0.5 text-sm text-muted-foreground">
          {wt.branch} ·{' '}
          {wt.synced ? (
            <span className="text-emerald-600">synced with main</span>
          ) : (
            <span className="text-amber-600">unsynced</span>
          )}
        </div>
      </div>

      {status === 'connecting' && automations.length === 0 ? (
        <EmptyState message="Loading automations…" />
      ) : automations.length === 0 ? (
        <EmptyState message="No live-dev automations for this worktree." />
      ) : (
        <div className="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
          {automations.map(({ name, aut }) => (
            <AutomationCard
              key={name + (aut.deployment_id ?? '')}
              name={name}
              stages={[{ id: 'live-dev', label: 'Live dev', automation: aut }]}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

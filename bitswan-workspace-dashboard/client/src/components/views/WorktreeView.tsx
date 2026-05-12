import { useCallback, useMemo, useState } from 'react';
import { LayoutDashboard, TerminalSquare } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAutomations } from '@/components/workspace/WorkspaceProvider';
import type { BusinessProcess, DeployedAutomation, Worktree } from '@/types';
import { Terminal } from '@/components/terminal/Terminal';
import { AutomationCard } from '@/components/automations/AutomationCard';
import { InspectModal, type InspectStage } from '@/components/automations/InspectModal';
import { ReadmeCard } from '@/components/workspace/ReadmeCard';
import { SectionHeader } from '@/components/shared/SectionHeader';
import { EmptyState } from '@/components/shared/EmptyState';

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
  const { automations: raw, status } = useAutomations();
  const prefix = `worktrees/${wt.name}/${bp.name}`;
  const [inspectName, setInspectName] = useState<string | null>(null);

  // Group worktree automations by name. Used by both the card grid and the
  // open-modal's live stage derivation.
  const byName = useMemo(() => {
    const out = new Map<string, DeployedAutomation>();
    for (const a of raw) {
      const rel = a.relative_path ?? '';
      if (rel === prefix || rel.startsWith(`${prefix}/`)) {
        out.set(a.automation_name ?? a.name, a);
      }
    }
    return out;
  }, [raw, prefix]);

  const sorted = useMemo(
    () => Array.from(byName.entries()).sort(([a], [b]) => a.localeCompare(b)),
    [byName],
  );

  const inspectStages: InspectStage[] = useMemo(() => {
    if (!inspectName) return [];
    return [{ id: 'live-dev', label: 'Live dev', automation: byName.get(inspectName) }];
  }, [byName, inspectName]);

  const handleClose = useCallback(() => setInspectName(null), []);

  return (
    <div className="flex flex-col gap-5 px-7 py-6">
      <SectionHeader
        eyebrow="Worktree"
        title={wt.name}
        helper={
          <>
            {wt.branch} ·{' '}
            {wt.synced ? (
              <span className="text-emerald-600">synced with main</span>
            ) : (
              <span className="text-amber-600">unsynced</span>
            )}
          </>
        }
      />

      {status === 'connecting' && sorted.length === 0 ? (
        <EmptyState message="Loading automations…" />
      ) : sorted.length === 0 ? (
        <EmptyState message="No live-dev automations for this worktree." />
      ) : (
        <div className="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]">
          {sorted.map(([name, aut]) => (
            <AutomationCard
              key={name}
              name={name}
              stages={[{
                id: 'live-dev',
                label: 'Live dev',
                short: 'Live dev',
                automation: aut,
              }]}
              onInspect={() => setInspectName(name)}
            />
          ))}
        </div>
      )}

      <ReadmeCard bpId={bp.id} />

      <InspectModal
        open={inspectName !== null}
        onClose={handleClose}
        name={inspectName ?? ''}
        stages={inspectStages}
        mode="liveDev"
      />
    </div>
  );
}

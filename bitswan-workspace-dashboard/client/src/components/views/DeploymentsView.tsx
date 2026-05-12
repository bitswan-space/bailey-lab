import { useMemo, useState } from 'react';
import { useAutomations } from '@/hooks/useAutomations';
import type { AutomationStage, BusinessProcess, DeployedAutomation } from '@/types';
import { AutomationCard } from '@/components/automations/AutomationCard';
import { InspectModal, type InspectStage } from '@/components/automations/InspectModal';
import { ReadmeCard } from '@/components/workspace/ReadmeCard';
import { SectionHeader } from '@/components/shared/SectionHeader';
import { EmptyState } from '@/components/shared/EmptyState';

const STAGES: { id: AutomationStage; label: string; short: string }[] = [
  { id: 'dev', label: 'Development', short: 'Dev' },
  { id: 'staging', label: 'Staging', short: 'Stg' },
  { id: 'production', label: 'Production', short: 'Prod' },
];

interface DeploymentsViewProps {
  bp: BusinessProcess;
}

export function DeploymentsView({ bp }: DeploymentsViewProps) {
  const { data: raw, status } = useAutomations();
  const [inspectTarget, setInspectTarget] = useState<{
    name: string;
    stages: InspectStage[];
  } | null>(null);

  const grouped = useMemo(() => {
    const byName = new Map<string, Partial<Record<AutomationStage, DeployedAutomation>>>();
    for (const a of raw) {
      const rel = a.relative_path ?? '';
      if (!rel.startsWith(bp.name)) continue;
      if (rel.includes('/worktrees/') || rel.startsWith('worktrees/')) continue;
      const stage = a.stage;
      if (stage !== 'dev' && stage !== 'staging' && stage !== 'production') continue;
      const key = a.automation_name ?? a.name;
      if (!byName.has(key)) byName.set(key, {});
      byName.get(key)![stage] = a;
    }
    return Array.from(byName.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [raw, bp.name]);

  return (
    <div className="flex-1 overflow-auto bg-background">
      <div className="flex flex-col gap-5 px-7 py-6">
        <SectionHeader
          eyebrow="Automations"
          title={`${grouped.length} ${grouped.length === 1 ? 'automation' : 'automations'} on main`}
          helper="Click Inspect to start / stop / restart and view logs."
        />

        {status === 'connecting' && grouped.length === 0 ? (
          <EmptyState message="Loading automations…" />
        ) : grouped.length === 0 ? (
          <EmptyState message="No automations found for this business process." />
        ) : (
          <div className="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(420px,1fr))]">
            {grouped.map(([name, stages]) => (
              <AutomationCard
                key={name}
                name={name}
                stages={STAGES.map((s) => ({
                  id: s.id,
                  label: s.label,
                  short: s.short,
                  automation: stages[s.id],
                }))}
                onInspect={() =>
                  setInspectTarget({
                    name,
                    stages: STAGES.map((s) => ({
                      id: s.id,
                      label: s.label,
                      automation: stages[s.id],
                    })),
                  })
                }
              />
            ))}
          </div>
        )}

        <ReadmeCard bpId={bp.id} />
      </div>

      <InspectModal
        open={inspectTarget !== null}
        onClose={() => setInspectTarget(null)}
        name={inspectTarget?.name ?? ''}
        stages={inspectTarget?.stages ?? []}
        mode="deployments"
      />
    </div>
  );
}

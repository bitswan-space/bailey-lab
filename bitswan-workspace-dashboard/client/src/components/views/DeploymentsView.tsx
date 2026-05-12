import { useCallback, useMemo, useState } from 'react';
import { useAutomations } from '@/components/workspace/WorkspaceProvider';
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
  const { automations: raw, status } = useAutomations();
  const [inspectName, setInspectName] = useState<string | null>(null);

  // Group automations by automation_name → { stage: automation }. Used both
  // to render the cards AND to derive the modal's live stages.
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
    return byName;
  }, [raw, bp.name]);

  const sorted = useMemo(
    () => Array.from(grouped.entries()).sort(([a], [b]) => a.localeCompare(b)),
    [grouped],
  );

  // Live stages for the open modal — derived from the same grouping the
  // cards use, so SSE updates flow through immediately.
  const inspectStages: InspectStage[] = useMemo(() => {
    if (!inspectName) return [];
    const stages = grouped.get(inspectName);
    return STAGES.map((s) => ({
      id: s.id,
      label: s.label,
      automation: stages?.[s.id],
    }));
  }, [grouped, inspectName]);

  const handleClose = useCallback(() => setInspectName(null), []);

  return (
    <div className="flex-1 overflow-auto bg-background">
      <div className="flex flex-col gap-5 px-7 py-6">
        <SectionHeader
          eyebrow="Automations"
          title={`${sorted.length} ${sorted.length === 1 ? 'automation' : 'automations'} on main`}
          helper="Click Inspect to start / stop / restart and view logs."
        />

        {status === 'connecting' && sorted.length === 0 ? (
          <EmptyState message="Loading automations…" />
        ) : sorted.length === 0 ? (
          <EmptyState message="No automations found for this business process." />
        ) : (
          <div className="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(420px,1fr))]">
            {sorted.map(([name, stages]) => (
              <AutomationCard
                key={name}
                name={name}
                stages={STAGES.map((s) => ({
                  id: s.id,
                  label: s.label,
                  short: s.short,
                  automation: stages[s.id],
                }))}
                onInspect={() => setInspectName(name)}
              />
            ))}
          </div>
        )}

        <ReadmeCard bpId={bp.id} />
      </div>

      <InspectModal
        open={inspectName !== null}
        onClose={handleClose}
        name={inspectName ?? ''}
        stages={inspectStages}
        mode="deployments"
      />
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useAutomations } from '@/components/workspace/WorkspaceProvider';
import type { AutomationStage, BusinessProcess, DeployedAutomation } from '@/types';
import { AutomationCard } from '@/components/automations/AutomationCard';
import { InspectModal, type InspectStage } from '@/components/automations/InspectModal';
import {
  RemoveConfirmDialog,
  type RemoveTarget,
} from '@/components/automations/RemoveConfirmDialog';
import { ReadmeCard } from '@/components/workspace/ReadmeCard';
import { SectionHeader } from '@/components/shared/SectionHeader';
import { EmptyState } from '@/components/shared/EmptyState';
import { api, isTransientNetworkError } from '@/lib/api';

const STAGES: { id: AutomationStage; label: string; short: string }[] = [
  { id: 'dev', label: 'Development', short: 'Dev' },
  { id: 'staging', label: 'Staging', short: 'Stg' },
  { id: 'production', label: 'Production', short: 'Prod' },
];

// Deploy from the dashboard is only wired for the dev stage in this iteration;
// staging / production happen via "promote" (out of scope).
const DEPLOYABLE_STAGES: AutomationStage[] = ['dev'];

interface DeploymentsViewProps {
  bp: BusinessProcess;
}

interface CardEntry {
  /** Per-stage deployed automations (if any). */
  stages: Partial<Record<AutomationStage, DeployedAutomation>>;
  /** workspace-relative source path used for Deploy. */
  relativePath: string;
}

// Safety net for the busy state: even if the SSE never delivers the expected
// state change (e.g. server-side failure mid-deploy), clear after this window
// so the buttons aren't permanently disabled.
const BUSY_TIMEOUT_MS = 15_000;

interface BusyEntry {
  stage: AutomationStage;
  /** What we expect the live snapshot to look like once the action lands. */
  expect: 'deployed' | 'undeployed';
  startedAt: number;
}

export function DeploymentsView({ bp }: DeploymentsViewProps) {
  const { automations: raw, status } = useAutomations();
  const [inspectName, setInspectName] = useState<string | null>(null);
  // Per-automation busy state. Kept set from the moment we fire the request
  // until either the SSE feed reflects the expected new state or
  // `BUSY_TIMEOUT_MS` elapses — this closes the race where the HTTP request
  // returns before the cell flips, leaving the button briefly clickable
  // again.
  const [busy, setBusy] = useState<Record<string, BusyEntry | null>>({});
  const [removeTarget, setRemoveTarget] = useState<
    (RemoveTarget & { stageId: AutomationStage; automationName: string }) | null
  >(null);

  // Group automations by automation_name. Both deployed entries (stage in
  // dev/staging/production) and discoverable entries (stage=null) contribute,
  // so cards show up even when nothing is deployed yet.
  const grouped = useMemo(() => {
    const byName = new Map<string, CardEntry>();
    const ensure = (name: string, relativePath: string): CardEntry => {
      const existing = byName.get(name);
      if (existing) {
        if (!existing.relativePath && relativePath) existing.relativePath = relativePath;
        return existing;
      }
      const entry: CardEntry = { stages: {}, relativePath };
      byName.set(name, entry);
      return entry;
    };
    for (const a of raw) {
      const rel = a.relative_path ?? '';
      if (!rel.startsWith(bp.name)) continue;
      if (rel.includes('/worktrees/') || rel.startsWith('worktrees/')) continue;
      const key = a.automation_name ?? a.name;
      const entry = ensure(key, rel);
      const stage = a.stage;
      if (stage === 'dev' || stage === 'staging' || stage === 'production') {
        entry.stages[stage] = a;
      }
      // stage === null is a discoverable entry — the ensure() call above
      // already registered the card; nothing more to do.
    }
    return byName;
  }, [raw, bp.name]);

  const sorted = useMemo(
    () => Array.from(grouped.entries()).sort(([a], [b]) => a.localeCompare(b)),
    [grouped],
  );

  // Live stages for the open modal, derived from the same grouping so SSE
  // updates flow into the modal in place.
  const inspectStages: InspectStage[] = useMemo(() => {
    if (!inspectName) return [];
    const entry = grouped.get(inspectName);
    return STAGES.map((s) => ({
      id: s.id,
      label: s.label,
      automation: entry?.stages?.[s.id],
    }));
  }, [grouped, inspectName]);

  const handleClose = useCallback(() => setInspectName(null), []);

  // Clear busy entries once the live snapshot reflects the expected state, or
  // after the safety timeout.
  useEffect(() => {
    setBusy((cur) => {
      let changed = false;
      const next = { ...cur };
      const now = Date.now();
      for (const [name, entry] of Object.entries(cur)) {
        if (!entry) continue;
        const aut = grouped.get(name)?.stages?.[entry.stage];
        const isDeployed = !!aut?.deployment_id;
        const satisfied =
          entry.expect === 'deployed' ? isDeployed : !isDeployed;
        if (satisfied || now - entry.startedAt > BUSY_TIMEOUT_MS) {
          next[name] = null;
          changed = true;
        }
      }
      return changed ? next : cur;
    });
  }, [grouped]);

  // Also drive a periodic clear so timeouts fire even when `grouped` is
  // stable (e.g. SSE disconnected and we never get a new snapshot).
  useEffect(() => {
    const anyBusy = Object.values(busy).some(Boolean);
    if (!anyBusy) return;
    const t = setTimeout(() => {
      setBusy((cur) => {
        let changed = false;
        const next = { ...cur };
        const now = Date.now();
        for (const [name, entry] of Object.entries(cur)) {
          if (entry && now - entry.startedAt > BUSY_TIMEOUT_MS) {
            next[name] = null;
            changed = true;
          }
        }
        return changed ? next : cur;
      });
    }, BUSY_TIMEOUT_MS + 200);
    return () => clearTimeout(t);
  }, [busy]);

  const runDeploy = useCallback(
    async (name: string, stage: 'dev', relativePath: string) => {
      setBusy((m) => ({
        ...m,
        [name]: { stage, expect: 'deployed', startedAt: Date.now() },
      }));
      const work = api.deployAutomation({ relative_path: relativePath, stage });
      toast.promise(work, {
        loading: `Deploying ${name} to ${stage}…`,
        success: `${name} deployed to ${stage}`,
        error: (err: unknown) =>
          isTransientNetworkError(err)
            ? `${name} deployed to ${stage}`
            : `Failed to deploy ${name}: ${String(err)}`,
      });
      try {
        await work;
        // Leave busy set — the SSE-watching effect will clear it when the
        // expected state lands (or the timeout fires).
      } catch (err) {
        // Real failure (not a transient network blip) — clear busy now so
        // the user can retry without waiting for the safety timeout.
        if (!isTransientNetworkError(err)) {
          setBusy((m) => ({ ...m, [name]: null }));
        }
      }
    },
    [],
  );

  const runRemove = useCallback(
    async (name: string, stage: AutomationStage, deploymentId: string) => {
      setBusy((m) => ({
        ...m,
        [name]: { stage, expect: 'undeployed', startedAt: Date.now() },
      }));
      const work = api.removeAutomation(deploymentId);
      toast.promise(work, {
        loading: `Removing ${name} (${stage})…`,
        success: `${name} removed from ${stage}`,
        error: (err: unknown) =>
          isTransientNetworkError(err)
            ? `${name} removed from ${stage}`
            : `Failed to remove ${name}: ${String(err)}`,
      });
      try {
        await work;
      } catch (err) {
        if (!isTransientNetworkError(err)) {
          setBusy((m) => ({ ...m, [name]: null }));
        }
      }
    },
    [],
  );

  return (
    <div className="flex-1 overflow-auto bg-background">
      <div className="flex flex-col gap-5 px-7 py-6">
        <SectionHeader
          eyebrow="Automations"
          title={`${sorted.length} ${sorted.length === 1 ? 'automation' : 'automations'} on main`}
          helper="Click Deploy to start an automation on dev, or Inspect to view logs."
        />

        {status === 'connecting' && sorted.length === 0 ? (
          <EmptyState message="Loading automations…" />
        ) : sorted.length === 0 ? (
          <EmptyState message="No automations found for this business process." />
        ) : (
          <div className="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(420px,1fr))]">
            {sorted.map(([name, entry]) => (
              <AutomationCard
                key={name}
                name={name}
                stages={STAGES.map((s) => ({
                  id: s.id,
                  label: s.label,
                  short: s.short,
                  automation: entry.stages[s.id],
                }))}
                deployableStages={DEPLOYABLE_STAGES}
                busyStage={busy[name]?.stage ?? null}
                onInspect={() => setInspectName(name)}
                onDeploy={(stage) => {
                  // Only "dev" is deployable in this view per
                  // DEPLOYABLE_STAGES; the card guarantees the narrow.
                  if (stage !== 'dev') return;
                  void runDeploy(name, stage, entry.relativePath);
                }}
                onRemove={(deploymentId, stage) => {
                  setRemoveTarget({
                    deploymentId,
                    name,
                    automationName: name,
                    stageId: stage,
                    stageLabel: STAGES.find((s) => s.id === stage)?.label ?? stage,
                  });
                }}
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

      <RemoveConfirmDialog
        target={removeTarget}
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => {
          if (!removeTarget) return;
          const { automationName, stageId, deploymentId } = removeTarget;
          setRemoveTarget(null);
          void runRemove(automationName, stageId, deploymentId);
        }}
      />
    </div>
  );
}

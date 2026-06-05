import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, Rocket } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import { api, isTransientNetworkError } from '@/lib/api';
import { deployBpWithToast, promoteBpWithToast } from '@/lib/deployBp';

const STAGES: { id: AutomationStage; label: string; short: string }[] = [
  { id: 'dev', label: 'Development', short: 'Dev' },
  { id: 'staging', label: 'Staging', short: 'Stg' },
  { id: 'production', label: 'Production', short: 'Prod' },
];

// Deploy happens at the business-process level (one button deploys every
// automation in the BP to dev), so cards expose no per-automation Deploy
// button — `deployableStages` is empty.
const DEPLOYABLE_STAGES: AutomationStage[] = [];
// Promote targets — order in STAGES determines what counts as "previous".
const PROMOTABLE_STAGES: AutomationStage[] = ['staging', 'production'];

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
  // Whole-BP deploy in flight — blocks the header Deploy button until the
  // polled deploy task reaches a terminal state.
  const [bpDeploying, setBpDeploying] = useState(false);
  // Whole-BP promotion in flight (target stage), same blocking semantics.
  const [bpPromoting, setBpPromoting] = useState<'staging' | 'production' | null>(
    null,
  );
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

  // Deploy the whole business process (every automation on dev) in one click.
  // The header button blocks for the duration; progress messages stream into
  // a single updating toast (driven by polling the deploy task's status).
  const runDeployBP = useCallback(async () => {
    const members = Array.from(grouped.keys());
    setBpDeploying(true);
    // Seed the per-member busy map (reusing the SSE-driven clear) so the
    // cards' action buttons also disable while the deploy is in flight.
    setBusy((m) => {
      const next = { ...m };
      for (const name of members) {
        next[name] = { stage: 'dev', expect: 'deployed', startedAt: Date.now() };
      }
      return next;
    });
    try {
      const outcome = await deployBpWithToast({
        bp: bp.name,
        stage: 'dev',
        loading: `Deploying ${bp.name}…`,
        success: `${bp.name} deployed`,
        failurePrefix: `Failed to deploy ${bp.name}`,
      });
      if (outcome !== 'completed') {
        // Clear member busy right away so the user can retry; on success the
        // SSE-watching effect clears each member as its dev deployment lands.
        setBusy((m) => {
          const next = { ...m };
          for (const name of members) next[name] = null;
          return next;
        });
      }
    } finally {
      setBpDeploying(false);
    }
  }, [grouped, bp.name]);

  // Promote every automation of the BP from the previous stage to `target`
  // as one unit (one task, one compose-up). Mirrors runDeployBP's busy/toast
  // handling; only members with a source-stage deployment participate.
  const runPromoteBP = useCallback(
    async (target: 'staging' | 'production') => {
      const source = target === 'staging' ? 'dev' : 'staging';
      const members = Array.from(grouped.entries())
        .filter(
          ([, e]) =>
            e.stages[source]?.deployment_id && e.stages[source]?.version_hash,
        )
        .map(([name]) => name);
      if (members.length === 0) return;
      setBpPromoting(target);
      setBusy((m) => {
        const next = { ...m };
        for (const name of members) {
          next[name] = { stage: target, expect: 'deployed', startedAt: Date.now() };
        }
        return next;
      });
      try {
        const outcome = await promoteBpWithToast({
          bp: bp.name,
          stage: target,
          loading: `Promoting ${bp.name} to ${target}…`,
          success: `${bp.name} promoted to ${target}`,
          failurePrefix: `Failed to promote ${bp.name} to ${target}`,
        });
        if (outcome !== 'completed') {
          setBusy((m) => {
            const next = { ...m };
            for (const name of members) next[name] = null;
            return next;
          });
        }
      } finally {
        setBpPromoting(null);
      }
    },
    [grouped, bp.name],
  );

  // A promote target is offered when at least one automation has a
  // deployment (with a checksum) at the source stage. The server enforces
  // the same rule, so these are purely presentational.
  const canPromoteToStaging = useMemo(
    () =>
      Array.from(grouped.values()).some(
        (e) => e.stages.dev?.deployment_id && e.stages.dev?.version_hash,
      ),
    [grouped],
  );
  const canPromoteToProduction = useMemo(
    () =>
      Array.from(grouped.values()).some(
        (e) => e.stages.staging?.deployment_id && e.stages.staging?.version_hash,
      ),
    [grouped],
  );

  const runPromote = useCallback(
    async (
      name: string,
      targetStage: 'staging' | 'production',
      checksum: string,
      relativePath: string,
    ) => {
      setBusy((m) => ({
        ...m,
        [name]: { stage: targetStage, expect: 'deployed', startedAt: Date.now() },
      }));
      const work = api.promoteAutomation({
        automation_name: name,
        context: bp.name,
        stage: targetStage,
        checksum,
        relative_path: relativePath,
      });
      toast.promise(work, {
        loading: `Promoting ${name} to ${targetStage}…`,
        success: `${name} promoted to ${targetStage}`,
        error: (err: unknown) =>
          isTransientNetworkError(err)
            ? `${name} promoted to ${targetStage}`
            : `Failed to promote ${name}: ${String(err)}`,
      });
      try {
        await work;
      } catch (err) {
        if (!isTransientNetworkError(err)) {
          setBusy((m) => ({ ...m, [name]: null }));
        }
      }
    },
    [bp.name],
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

  const bpBusy =
    bpDeploying || bpPromoting !== null || Object.values(busy).some(Boolean);

  return (
    <div className="flex-1 overflow-auto bg-background">
      <div className="flex flex-col gap-5 px-7 py-6">
        <SectionHeader
          eyebrow="Automations"
          title={`${sorted.length} ${sorted.length === 1 ? 'automation' : 'automations'} on main`}
          helper="Deploy runs every automation in this business process on dev. Inspect to view logs."
          right={
            sorted.length > 0 ? (
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => void runDeployBP()}
                  disabled={bpBusy}
                >
                  <Rocket className="size-3.5" />
                  {bpDeploying ? 'Deploying…' : 'Deploy'}
                </Button>
                {canPromoteToStaging && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void runPromoteBP('staging')}
                    disabled={bpBusy}
                  >
                    <ArrowRight className="size-3.5" />
                    {bpPromoting === 'staging'
                      ? 'Promoting…'
                      : 'Promote to staging'}
                  </Button>
                )}
                {canPromoteToProduction && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void runPromoteBP('production')}
                    disabled={bpBusy}
                  >
                    <ArrowRight className="size-3.5" />
                    {bpPromoting === 'production'
                      ? 'Promoting…'
                      : 'Promote to production'}
                  </Button>
                )}
              </div>
            ) : undefined
          }
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
                promotableStages={PROMOTABLE_STAGES}
                busyStage={busy[name]?.stage ?? null}
                onInspect={() => setInspectName(name)}
                onDeploy={() => {
                  // Per-automation deploy is disabled (deployableStages is
                  // empty); deploys happen at the BP level via "Deploy".
                }}
                onPromote={(stage) => {
                  if (stage !== 'staging' && stage !== 'production') return;
                  const prevId =
                    stage === 'staging' ? 'dev' : 'staging';
                  const checksum = entry.stages[prevId]?.version_hash;
                  if (!checksum) return;
                  // entry.relativePath is the source dir (e.g. "<bp>/<auto>")
                  // — gitops needs it to write the new bitswan.yaml entry
                  // with a relative_path so the dashboard's per-BP filter
                  // surfaces the new stage.
                  void runPromote(name, stage, checksum, entry.relativePath);
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

import { useCallback, useEffect, useMemo, useState } from 'react';
import { LayoutDashboard, TerminalSquare } from 'lucide-react';
import { toast } from 'sonner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAutomations } from '@/components/workspace/WorkspaceProvider';
import type {
  AutomationStage,
  BusinessProcess,
  DeployedAutomation,
  Worktree,
} from '@/types';
import { Terminal } from '@/components/terminal/Terminal';
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

const DEPLOYABLE_STAGES: AutomationStage[] = ['live-dev'];

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

// See DeploymentsView for the rationale on the busy-state lifecycle.
const BUSY_TIMEOUT_MS = 15_000;

interface BusyEntry {
  stage: AutomationStage;
  expect: 'deployed' | 'undeployed';
  startedAt: number;
}

interface CardEntry {
  automation: DeployedAutomation | undefined;
  relativePath: string;
}

function OverviewPane({ bp, wt }: { bp: BusinessProcess; wt: Worktree }) {
  const { automations: raw, status } = useAutomations();
  const prefix = `worktrees/${wt.name}/${bp.name}`;
  const [inspectName, setInspectName] = useState<string | null>(null);
  // Busy stays set from request fire until the SSE feed confirms the
  // expected state, or the safety timeout fires. Same shape as
  // DeploymentsView.
  const [busy, setBusy] = useState<Record<string, BusyEntry | null>>({});
  const [removeTarget, setRemoveTarget] = useState<
    (RemoveTarget & { automationName: string }) | null
  >(null);

  // Group worktree automations by name. Both deployed (stage='live-dev') and
  // discoverable (stage=null) entries contribute so the card grid shows
  // automations that exist on disk but haven't been started yet.
  const byName = useMemo(() => {
    const out = new Map<string, CardEntry>();
    for (const a of raw) {
      const rel = a.relative_path ?? '';
      if (rel !== prefix && !rel.startsWith(`${prefix}/`)) continue;
      const key = a.automation_name ?? a.name;
      const existing = out.get(key);
      const isDeployed = a.stage === 'live-dev' && a.deployment_id;
      if (existing) {
        if (isDeployed && !existing.automation) existing.automation = a;
        if (!existing.relativePath && rel) existing.relativePath = rel;
      } else {
        out.set(key, {
          automation: isDeployed ? a : undefined,
          relativePath: rel,
        });
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
    return [
      {
        id: 'live-dev',
        label: 'Live dev',
        automation: byName.get(inspectName)?.automation,
      },
    ];
  }, [byName, inspectName]);

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
        const aut = byName.get(name)?.automation;
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
  }, [byName]);

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
    async (name: string, relativePath: string) => {
      setBusy((m) => ({
        ...m,
        [name]: { stage: 'live-dev', expect: 'deployed', startedAt: Date.now() },
      }));
      const work = api.deployAutomation({
        relative_path: relativePath,
        stage: 'live-dev',
        worktree: wt.name,
      });
      toast.promise(work, {
        loading: `Starting ${name} live-dev…`,
        success: `${name} started in ${wt.name}`,
        error: (err: unknown) =>
          isTransientNetworkError(err)
            ? `${name} started in ${wt.name}`
            : `Failed to start ${name}: ${String(err)}`,
      });
      try {
        await work;
      } catch (err) {
        if (!isTransientNetworkError(err)) {
          setBusy((m) => ({ ...m, [name]: null }));
        }
      }
    },
    [wt.name],
  );

  const runRemove = useCallback(async (name: string, deploymentId: string) => {
    setBusy((m) => ({
      ...m,
      [name]: { stage: 'live-dev', expect: 'undeployed', startedAt: Date.now() },
    }));
    const work = api.removeAutomation(deploymentId);
    toast.promise(work, {
      loading: `Removing ${name} live-dev…`,
      success: `${name} live-dev removed`,
      error: (err: unknown) =>
        isTransientNetworkError(err)
          ? `${name} live-dev removed`
          : `Failed to remove ${name}: ${String(err)}`,
    });
    try {
      await work;
    } catch (err) {
      if (!isTransientNetworkError(err)) {
        setBusy((m) => ({ ...m, [name]: null }));
      }
    }
  }, []);

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
          {sorted.map(([name, entry]) => (
            <AutomationCard
              key={name}
              name={name}
              stages={[{
                id: 'live-dev',
                label: 'Live dev',
                short: 'Live dev',
                automation: entry.automation,
              }]}
              deployableStages={DEPLOYABLE_STAGES}
              busyStage={busy[name]?.stage ?? null}
              onInspect={() => setInspectName(name)}
              onDeploy={() => {
                void runDeploy(name, entry.relativePath);
              }}
              onRemove={(deploymentId) => {
                setRemoveTarget({
                  deploymentId,
                  name,
                  automationName: name,
                  stageLabel: 'Live dev',
                });
              }}
            />
          ))}
        </div>
      )}

      <ReadmeCard bpId={bp.id} worktree={wt.name} />

      <InspectModal
        open={inspectName !== null}
        onClose={handleClose}
        name={inspectName ?? ''}
        stages={inspectStages}
        mode="liveDev"
      />

      <RemoveConfirmDialog
        target={removeTarget}
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => {
          if (!removeTarget) return;
          const { automationName, deploymentId } = removeTarget;
          setRemoveTarget(null);
          void runRemove(automationName, deploymentId);
        }}
      />
    </div>
  );
}

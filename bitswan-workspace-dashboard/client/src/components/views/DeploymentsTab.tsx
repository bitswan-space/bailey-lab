import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowRight,
  Boxes,
  Check,
  Code2,
  Cog,
  ExternalLink,
  FlaskConical,
  Globe,
  Layers,
  Loader2,
  Play,
  RotateCcw,
  Rocket,
  Square,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { useAutomations } from '@/components/workspace/WorkspaceProvider';
import type { BusinessProcess, DeployedAutomation } from '@/types';
import {
  InspectModal,
  type InspectStage,
} from '@/components/automations/InspectModal';
import {
  RemoveConfirmDialog,
  type RemoveTarget,
} from '@/components/automations/RemoveConfirmDialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { EmptyState } from '@/components/shared/EmptyState';
import { Button } from '@/components/ui/button';
import { api, isTransientNetworkError } from '@/lib/api';
import { promoteBpWithToast } from '@/lib/deployBp';
import { STATUS_META, stateToDisplay, type DisplayStatus } from '@/lib/status';
import { cn } from '@/lib/utils';

// The three promotion stages, in pipeline order. Live-dev never appears here
// (its deployments live under `worktrees/` and are filtered out below).
const STAGES = [
  { id: 'dev', label: 'Development', icon: Code2 },
  { id: 'staging', label: 'Staging', icon: FlaskConical },
  { id: 'production', label: 'Production', icon: Rocket },
] as const;
type StageId = (typeof STAGES)[number]['id'];

interface CardEntry {
  stages: Partial<Record<StageId, DeployedAutomation>>;
  /** Workspace-relative source path used for per-automation Deploy. */
  relativePath: string;
}

type StageHealth = 'healthy' | 'partial' | 'failed' | 'building' | 'empty';

interface StageAgg {
  health: StageHealth;
  deployedCount: number;
  runningCount: number;
  failedCount: number;
  totalAutomations: number;
  replicasTotal: number;
  /** Most recent container creation across deployed members. */
  // eslint-disable-next-line no-restricted-syntax -- null = nothing deployed yet
  updated: Date | null;
}

const HEALTH_META: Record<
  StageHealth,
  { fill: string; text: string; dot: string; ring: string }
> = {
  healthy: {
    fill: 'bg-emerald-500',
    text: 'text-emerald-600',
    dot: 'bg-emerald-500',
    ring: 'ring-emerald-500/15',
  },
  partial: {
    fill: 'bg-amber-500',
    text: 'text-amber-600',
    dot: 'bg-amber-500',
    ring: 'ring-amber-500/15',
  },
  failed: {
    fill: 'bg-red-500',
    text: 'text-red-600',
    dot: 'bg-red-500',
    ring: 'ring-red-500/15',
  },
  building: {
    fill: 'bg-blue-500',
    text: 'text-blue-600',
    dot: 'bg-blue-500',
    ring: 'ring-blue-500/15',
  },
  empty: {
    fill: 'bg-background',
    text: 'text-muted-foreground',
    dot: 'bg-zinc-300',
    ring: 'ring-zinc-400/10',
  },
};

function timeAgo(d: Date): string {
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function healthLabel(agg: StageAgg): string {
  switch (agg.health) {
    case 'building':
      return 'Deploying…';
    case 'empty':
      return 'Nothing deployed yet';
    case 'failed':
      return `${agg.failedCount} service${agg.failedCount === 1 ? '' : 's'} failing`;
    case 'partial':
      return `${agg.runningCount} of ${agg.deployedCount} running`;
    case 'healthy':
      return 'Healthy';
  }
}

type LifecycleAction = 'start' | 'stop' | 'restart' | 'remove';

const ACTION_VERB: Record<LifecycleAction, { ing: string; past: string }> = {
  start: { ing: 'Starting', past: 'started' },
  stop: { ing: 'Stopping', past: 'stopped' },
  restart: { ing: 'Restarting', past: 'restarted' },
  remove: { ing: 'Removing', past: 'removed' },
};

// Dispatch a single deployment to its lifecycle endpoint. start/restart re-run
// gitops' post-deploy hooks (cert + oauth2-proxy re-injection) per container,
// so a bulk Restart here is the sidecar-safe way to bounce every container —
// unlike a raw `docker restart`, which strips the injected oauth2-proxy.
function callAction(action: LifecycleAction, id: string): Promise<unknown> {
  switch (action) {
    case 'start':
      return api.startAutomation(id);
    case 'stop':
      return api.stopAutomation(id);
    case 'restart':
      return api.restartAutomation(id);
    case 'remove':
      return api.removeAutomation(id);
  }
}

interface DeploymentsTabProps {
  bp: BusinessProcess;
}

/**
 * The per-BP Deployments tab: a horizontal promotion strip
 * (Development → PROMOTE → Staging → PROMOTE → Production), a detail panel
 * for the selected stage, and the stage's container list. Always
 * main-scoped — the shell gates this behind `bp.inMain`.
 *
 * The PROMOTE pills run the whole-BP union promote (gitops
 * `/automations/promote-bp`); per-automation Deploy/Remove live inside the
 * Inspect modal.
 */
export function DeploymentsTab({ bp }: DeploymentsTabProps) {
  const { automations: raw, status } = useAutomations();
  const [selectedStage, setSelectedStage] = useState<StageId>('dev');
  // eslint-disable-next-line no-restricted-syntax -- null = no promote in flight
  const [bpPromoting, setBpPromoting] = useState<'staging' | 'production' | null>(
    null,
  );
  // eslint-disable-next-line no-restricted-syntax -- null = modal closed
  const [inspectName, setInspectName] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<
    (RemoveTarget & { automationName: string }) | null
  >(null);
  // A confirmed Remove waiting for the SSE snapshot to drop the deployment —
  // keeps the modal's Remove button disabled so it can't be re-issued.
  // eslint-disable-next-line no-restricted-syntax -- null = no remove in flight
  const [removingId, setRemovingId] = useState<string | null>(null);
  // Bulk container action in flight (acts on every deployed member of the
  // selected stage), and per-row action in flight keyed by deployment id.
  // eslint-disable-next-line no-restricted-syntax -- null = no bulk op in flight
  const [bulkBusy, setBulkBusy] = useState<LifecycleAction | null>(null);
  const [bulkRemoveOpen, setBulkRemoveOpen] = useState(false);
  const [rowBusy, setRowBusy] = useState<Record<string, LifecycleAction>>({});

  // Group the BP's main-scoped automations by name. Deployed entries
  // (dev/staging/production) and discoverable ones (stage === null)
  // both contribute, so undeployed automations still get container rows
  // (and a reachable Inspect → Deploy).
  const grouped = useMemo(() => {
    const byName = new Map<string, CardEntry>();
    const ensure = (name: string, relativePath: string): CardEntry => {
      const existing = byName.get(name);
      if (existing) {
        if (!existing.relativePath && relativePath) {
          existing.relativePath = relativePath;
        }
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
    }
    return byName;
  }, [raw, bp.name]);

  const sorted = useMemo(
    () => Array.from(grouped.entries()).sort(([a], [b]) => a.localeCompare(b)),
    [grouped],
  );

  // Clear the in-flight remove once the deployment disappears from the
  // snapshot (or after a safety timeout, mirroring the old busy net).
  useEffect(() => {
    if (!removingId) return;
    const still = Array.from(grouped.values()).some((e) =>
      Object.values(e.stages).some((a) => a?.deployment_id === removingId),
    );
    if (!still) setRemovingId(null);
  }, [grouped, removingId]);
  useEffect(() => {
    if (!removingId) return;
    const t = setTimeout(() => setRemovingId(null), 15_000);
    return () => clearTimeout(t);
  }, [removingId]);

  // Per-stage aggregates driving the strip + detail panel.
  const aggs = useMemo(() => {
    const out = {} as Record<StageId, StageAgg>;
    for (const s of STAGES) {
      let deployedCount = 0;
      let runningCount = 0;
      let failedCount = 0;
      let replicasTotal = 0;
      // eslint-disable-next-line no-restricted-syntax -- null = none seen yet
      let updated: Date | null = null;
      for (const [, entry] of grouped) {
        const aut = entry.stages[s.id];
        if (!aut?.deployment_id) continue;
        deployedCount += 1;
        replicasTotal += aut.replicas || 1;
        const display = stateToDisplay(aut.state);
        if (display === 'running' || display === 'restarting') {
          runningCount += 1;
        } else {
          // A deployment whose container is stopped/missing reads as failing.
          failedCount += 1;
        }
        if (aut.created_at) {
          const d = new Date(aut.created_at);
          if (!Number.isNaN(d.getTime()) && (!updated || d > updated)) {
            updated = d;
          }
        }
      }
      const total = grouped.size;
      const busy =
        (s.id === 'staging' && bpPromoting === 'staging') ||
        (s.id === 'production' && bpPromoting === 'production');
      // Health is judged over DEPLOYED members only — automations that were
      // never promoted to this stage don't make a fully-running stage look
      // unhealthy (incremental promotion is normal).
      const health: StageHealth = busy
        ? 'building'
        : deployedCount === 0
          ? 'empty'
          : failedCount > 0
            ? 'failed'
            : runningCount < deployedCount
              ? 'partial'
              : 'healthy';
      out[s.id] = {
        health,
        deployedCount,
        runningCount,
        failedCount,
        totalAutomations: total,
        replicasTotal,
        updated,
      };
    }
    return out;
  }, [grouped, bpPromoting]);

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

  const runPromoteBP = useCallback(
    async (target: 'staging' | 'production') => {
      setBpPromoting(target);
      setSelectedStage(target);
      try {
        await promoteBpWithToast({
          bp: bp.name,
          stage: target,
          loading: `Promoting ${bp.name} to ${target}…`,
          success: `${bp.name} promoted to ${target}`,
          failurePrefix: `Failed to promote ${bp.name} to ${target}`,
        });
      } finally {
        setBpPromoting(null);
      }
    },
    [bp.name],
  );

  const runRemove = useCallback(
    async (name: string, stageLabel: string, deploymentId: string) => {
      const work = api.removeAutomation(deploymentId);
      toast.promise(work, {
        loading: `Removing ${name} (${stageLabel})…`,
        success: `${name} removed from ${stageLabel}`,
        error: (err: unknown) =>
          isTransientNetworkError(err)
            ? `${name} removed from ${stageLabel}`
            : `Failed to remove ${name}: ${String(err)}`,
      });
      try {
        await work;
      } catch {
        // toast handled it
      }
    },
    [],
  );

  const inspectStages: InspectStage[] = useMemo(() => {
    if (!inspectName) return [];
    const entry = grouped.get(inspectName);
    return STAGES.map((s) => ({
      id: s.id,
      label: s.label,
      automation: entry?.stages?.[s.id],
      relativePath: entry?.relativePath,
    }));
  }, [grouped, inspectName]);

  const agg = aggs[selectedStage];
  const meta = HEALTH_META[agg?.health ?? 'empty'];
  const bpBusy = bpPromoting !== null;

  // Container rows + Open-app links for the selected stage.
  const rows = useMemo(
    () =>
      sorted.map(([name, entry]) => {
        const aut = entry.stages[selectedStage];
        const display: DisplayStatus = aut?.deployment_id
          ? stateToDisplay(aut.state)
          : 'not-deployed';
        return {
          name,
          deploymentId: aut?.deployment_id ?? null,
          display,
          versionHash8: aut?.version_hash?.slice(0, 8) ?? null,
          automationUrl: aut?.automation_url ?? null,
        };
      }),
    [sorted, selectedStage],
  );
  const openApp = rows.filter((r) => r.automationUrl && r.display === 'running');

  const stageLabel =
    STAGES.find((s) => s.id === selectedStage)?.label ?? selectedStage;

  // Deployed members at the selected stage — the targets for bulk actions.
  const deployedMembers = useMemo(
    () =>
      rows.flatMap((r) =>
        r.deploymentId ? [{ name: r.name, deploymentId: r.deploymentId }] : [],
      ),
    [rows],
  );

  // Single-row start/stop/restart. Remove is routed through the shared
  // RemoveConfirmDialog (see the Remove button's onClick) so it can't fire
  // without confirmation.
  const runRowAction = useCallback(
    async (action: 'start' | 'stop' | 'restart', name: string, id: string) => {
      setRowBusy((b) => ({ ...b, [id]: action }));
      const v = ACTION_VERB[action];
      const work = callAction(action, id);
      toast.promise(work, {
        loading: `${v.ing} ${name}…`,
        success: `${name} ${v.past}`,
        error: (err: unknown) =>
          isTransientNetworkError(err)
            ? `${name} ${v.past}`
            : `Failed to ${action} ${name}: ${String(err)}`,
      });
      try {
        await work;
      } catch {
        // toast handled it
      } finally {
        setRowBusy((b) => {
          const next = { ...b };
          delete next[id];
          return next;
        });
      }
    },
    [],
  );

  // Apply an action to every deployed member of the selected stage in parallel.
  const runBulk = useCallback(
    async (action: LifecycleAction) => {
      const members = deployedMembers;
      if (members.length === 0) return;
      setBulkBusy(action);
      const v = ACTION_VERB[action];
      const n = members.length;
      const work = (async () => {
        const results = await Promise.allSettled(
          members.map((m) => callAction(action, m.deploymentId)),
        );
        const failed = results.filter(
          (r) =>
            r.status === 'rejected' &&
            !isTransientNetworkError((r as PromiseRejectedResult).reason),
        ).length;
        if (failed > 0) throw new Error(`${failed} of ${n} failed`);
        return n;
      })();
      toast.promise(work, {
        loading: `${v.ing} ${n} container${n === 1 ? '' : 's'}…`,
        success: (count: number) =>
          `${count} container${count === 1 ? '' : 's'} ${v.past}`,
        error: (err: unknown) =>
          `Could not ${action} every container: ${String(err)}`,
      });
      try {
        await work;
      } catch {
        // toast handled it
      } finally {
        setBulkBusy(null);
      }
    },
    [deployedMembers],
  );

  if (status === 'connecting' && sorted.length === 0) {
    return (
      <div className="flex-1 overflow-auto bg-background px-7 py-6">
        <EmptyState message="Loading automations…" />
      </div>
    );
  }
  if (sorted.length === 0) {
    return (
      <div className="flex-1 overflow-auto bg-background px-7 py-6">
        <EmptyState message="No automations found for this business process." />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto bg-background">
      <div className="mx-auto flex max-w-5xl flex-col gap-5 px-7 py-6">
        {/* Header */}
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Automation
          </div>
          <h1 className="text-xl font-bold tracking-tight">{bp.name}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {sorted.length} container{sorted.length === 1 ? '' : 's'} promote
            together. Pick a stage to manage its deployment.
          </p>
        </div>

        {/* Promotion strip */}
        <div className="flex items-center gap-2 px-11 pb-2 pt-8">
          {STAGES.map((s, i) => {
            const sAgg = aggs[s.id];
            const sMeta = HEALTH_META[sAgg.health];
            const active = s.id === selectedStage;
            const filled = sAgg.health !== 'empty';
            const Icon = s.icon;
            return (
              <div key={s.id} className="contents">
                <button
                  type="button"
                  onClick={() => setSelectedStage(s.id)}
                  className="relative flex shrink-0 flex-col items-center"
                >
                  <span
                    className={cn(
                      'absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2 whitespace-nowrap text-[11px] font-bold uppercase tracking-[0.8px]',
                      active ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {s.label}
                  </span>
                  <span
                    className={cn(
                      'inline-block rounded-full',
                      active && 'ring-4 ring-primary',
                    )}
                  >
                    {/* Stage node */}
                    <span className="relative inline-block">
                      <span
                        className={cn(
                          'flex h-[52px] w-[52px] items-center justify-center rounded-full',
                          filled
                            ? sMeta.fill
                            : 'border-[1.5px] border-dashed border-zinc-300 bg-background',
                        )}
                      >
                        <Icon
                          className={cn(
                            'size-[22px]',
                            filled ? 'text-white' : 'text-muted-foreground',
                          )}
                          aria-hidden
                        />
                      </span>
                      {/* Status badge */}
                      <span
                        title={healthLabel(sAgg)}
                        className="absolute -bottom-0.5 -right-0.5 flex size-[18px] items-center justify-center rounded-full border-2 border-background bg-background shadow"
                      >
                        {sAgg.health === 'building' ? (
                          <Loader2 className="size-3 animate-spin text-blue-500" />
                        ) : sAgg.health === 'failed' ? (
                          <X className="size-3 text-red-500" />
                        ) : sAgg.health === 'partial' ? (
                          <TriangleAlert className="size-3 text-amber-500" />
                        ) : sAgg.health === 'healthy' ? (
                          <Check className="size-3 text-emerald-500" />
                        ) : (
                          <span className="size-1.5 rounded-full bg-zinc-400" />
                        )}
                      </span>
                    </span>
                  </span>
                </button>
                {i < STAGES.length - 1 && (
                  <>
                    <div className="h-0.5 flex-1 bg-border" aria-hidden />
                    <PromotePill
                      enabled={
                        (i === 0 ? canPromoteToStaging : canPromoteToProduction) &&
                        !bpBusy
                      }
                      promoting={
                        bpPromoting === (i === 0 ? 'staging' : 'production')
                      }
                      title={
                        i === 0
                          ? canPromoteToStaging
                            ? 'Promote all containers from Development → Staging'
                            : 'Nothing to promote from Development'
                          : canPromoteToProduction
                            ? 'Promote all containers from Staging → Production'
                            : 'Nothing to promote from Staging'
                      }
                      onClick={() =>
                        void runPromoteBP(i === 0 ? 'staging' : 'production')
                      }
                    />
                    <div className="h-0.5 flex-1 bg-border" aria-hidden />
                  </>
                )}
              </div>
            );
          })}
        </div>

        {/* Selected-stage detail panel */}
        <div className="rounded-xl border border-border bg-background p-4 shadow-sm">
          <div className="flex items-center gap-3">
            <span
              className={cn('size-2.5 rounded-full ring-4', meta.dot, meta.ring)}
              aria-hidden
            />
            <div className="flex min-w-0 flex-col leading-tight">
              <span className={cn('text-sm font-semibold', meta.text)}>
                {healthLabel(agg)}
              </span>
              {agg.updated && (
                <span className="text-xs text-muted-foreground">
                  updated {timeAgo(agg.updated)}
                </span>
              )}
            </div>
            {agg.replicasTotal > 0 && (
              <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                <Layers className="size-3.5" aria-hidden />
                {agg.replicasTotal} replica{agg.replicasTotal === 1 ? '' : 's'}
              </span>
            )}
          </div>

          {agg.health === 'empty' ? (
            <p className="mt-3 border-t border-border pt-3 text-sm text-muted-foreground">
              {selectedStage === 'dev'
                ? 'Nothing deployed yet — deploy from a worktree via the Sync & Deploy tab.'
                : `Nothing deployed yet — promote from ${
                    selectedStage === 'staging' ? 'Development' : 'Staging'
                  }.`}
            </p>
          ) : (
            openApp.length > 0 && (
              <div className="mt-3 flex flex-col gap-1.5 border-t border-border pt-3">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Open app
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {openApp.map((r) => (
                    <a
                      key={r.name}
                      href={r.automationUrl ?? '#'}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 font-mono text-xs text-foreground transition-colors hover:bg-muted"
                    >
                      <Globe className="size-3 text-primary" aria-hidden />
                      {r.name}
                      <ExternalLink
                        className="size-3 text-muted-foreground"
                        aria-hidden
                      />
                    </a>
                  ))}
                </div>
              </div>
            )
          )}
        </div>

        {/* Containers */}
        <div>
          <div className="flex items-center justify-between border-b border-border">
            <span className="flex items-center gap-2 border-b-2 border-foreground px-1 pb-2 text-[13px] font-semibold text-foreground">
              <Boxes className="size-4" aria-hidden />
              Containers
              <span className="rounded-full bg-muted px-1.5 text-[11px] font-semibold text-muted-foreground">
                {rows.length}
              </span>
            </span>
            {deployedMembers.length > 0 && (
              <div className="flex items-center gap-1.5 pb-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={bulkBusy !== null || bpBusy}
                  title={`Start all ${deployedMembers.length} containers (${stageLabel})`}
                  onClick={() => void runBulk('start')}
                >
                  {bulkBusy === 'start' ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  ) : (
                    <Play className="size-3.5" aria-hidden />
                  )}
                  Start all
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={bulkBusy !== null || bpBusy}
                  title={`Stop all ${deployedMembers.length} containers (${stageLabel})`}
                  onClick={() => void runBulk('stop')}
                >
                  {bulkBusy === 'stop' ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  ) : (
                    <Square className="size-3.5" aria-hidden />
                  )}
                  Stop all
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={bulkBusy !== null || bpBusy}
                  title={`Restart all ${deployedMembers.length} containers (${stageLabel})`}
                  onClick={() => void runBulk('restart')}
                >
                  {bulkBusy === 'restart' ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  ) : (
                    <RotateCcw className="size-3.5" aria-hidden />
                  )}
                  Restart all
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-red-600 hover:text-red-700"
                  disabled={bulkBusy !== null || bpBusy}
                  title={`Remove all ${deployedMembers.length} containers (${stageLabel})`}
                  onClick={() => setBulkRemoveOpen(true)}
                >
                  {bulkBusy === 'remove' ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  ) : (
                    <Trash2 className="size-3.5" aria-hidden />
                  )}
                  Remove all
                </Button>
              </div>
            )}
          </div>
          <div className="mt-3 flex flex-col gap-2">
            {rows.map((r) => {
              const sMeta = STATUS_META[r.display];
              const id = r.deploymentId;
              const busy = id ? rowBusy[id] : undefined;
              const rowDisabled = bulkBusy !== null || bpBusy || busy !== undefined;
              return (
                <div
                  key={r.name}
                  className="flex items-center gap-3 rounded-lg border border-border bg-background px-4 py-3"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <Cog className="size-4 text-muted-foreground" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                    {r.name}
                  </span>
                  {r.versionHash8 && (
                    <span className="font-mono text-xs text-muted-foreground">
                      {r.versionHash8}
                    </span>
                  )}
                  <span className="flex w-28 items-center gap-1.5">
                    <span
                      className={cn('size-2 rounded-full', sMeta.dot)}
                      aria-hidden
                    />
                    <span className={cn('text-xs font-medium', sMeta.labelColor)}>
                      {sMeta.label}
                    </span>
                  </span>
                  {id && (
                    <div className="flex items-center gap-0.5">
                      <IconAction
                        title="Start"
                        icon={Play}
                        busy={busy === 'start'}
                        disabled={rowDisabled}
                        onClick={() => void runRowAction('start', r.name, id)}
                      />
                      <IconAction
                        title="Stop"
                        icon={Square}
                        busy={busy === 'stop'}
                        disabled={rowDisabled}
                        onClick={() => void runRowAction('stop', r.name, id)}
                      />
                      <IconAction
                        title="Restart"
                        icon={RotateCcw}
                        busy={busy === 'restart'}
                        disabled={rowDisabled}
                        onClick={() => void runRowAction('restart', r.name, id)}
                      />
                      <IconAction
                        title="Remove"
                        icon={Trash2}
                        danger
                        busy={removingId === id}
                        disabled={rowDisabled || removingId === id}
                        onClick={() =>
                          setRemoveTarget({
                            deploymentId: id,
                            name: r.name,
                            automationName: r.name,
                            stageLabel,
                          })
                        }
                      />
                    </div>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setInspectName(r.name)}
                  >
                    <Activity className="size-3.5" aria-hidden />
                    Inspect
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <InspectModal
        open={inspectName !== null}
        onClose={() => setInspectName(null)}
        name={inspectName ?? ''}
        stages={inspectStages}
        mode="deployments"
        initialStageId={selectedStage}
        actionBusy={removingId !== null}
        onRemove={(deploymentId, stage) => {
          if (!inspectName) return;
          setRemoveTarget({
            deploymentId,
            name: inspectName,
            automationName: inspectName,
            stageLabel: stage.label,
          });
        }}
      />

      <RemoveConfirmDialog
        target={removeTarget}
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => {
          if (!removeTarget) return;
          const { automationName, stageLabel, deploymentId } = removeTarget;
          setRemoveTarget(null);
          setRemovingId(deploymentId);
          void runRemove(automationName, stageLabel, deploymentId);
        }}
      />

      <AlertDialog
        open={bulkRemoveOpen}
        onOpenChange={(o) => !o && setBulkRemoveOpen(false)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove all containers?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops and removes all {deployedMembers.length} deployed
              container{deployedMembers.length === 1 ? '' : 's'} for {bp.name} (
              {stageLabel}) from bitswan.yaml. The source files on disk are kept;
              you can deploy again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setBulkRemoveOpen(false)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setBulkRemoveOpen(false);
                void runBulk('remove');
              }}
            >
              Remove all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Square icon-only button for per-container lifecycle actions. */
function IconAction({
  title,
  icon: Icon,
  busy,
  disabled,
  danger,
  onClick,
}: {
  title: string;
  icon: LucideIcon;
  busy: boolean;
  disabled: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn(
        'size-8',
        danger && 'text-red-600 hover:bg-red-50 hover:text-red-700',
      )}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      {busy ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
      ) : (
        <Icon className="size-3.5" aria-hidden />
      )}
    </Button>
  );
}

function PromotePill({
  enabled,
  promoting,
  title,
  onClick,
}: {
  enabled: boolean;
  promoting: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={enabled ? onClick : undefined}
      disabled={!enabled}
      title={title}
      className={cn(
        'inline-flex h-[30px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[11px] font-semibold uppercase tracking-[0.3px] transition-colors',
        enabled
          ? 'border-primary bg-primary text-primary-foreground shadow-sm hover:bg-primary/90'
          : 'cursor-not-allowed border-border bg-background text-muted-foreground',
      )}
    >
      {promoting ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
      ) : null}
      Promote
      <ArrowRight className="size-3.5" aria-hidden />
    </button>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  Copy,
  Database,
  HardDrive,
  History,
  Loader2,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  CloneDialog,
  CreateSnapshotDialog,
  RestoreDialog,
} from '@/components/snapshots/SnapshotDialogs';
import { STAGE_META } from '@/components/snapshots/StagePicker';
import { EmptyState } from '@/components/shared/EmptyState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
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
import { api } from '@/lib/api';
import {
  snapshotStepLabel,
  snapshotTaskProgress,
  watchSnapshotTask,
} from '@/lib/snapshotTask';
import { cn } from '@/lib/utils';
import { setUrlParams, useUrlParam } from '@/lib/urlState';
import {
  SNAPSHOT_STAGES,
  type BusinessProcess,
  type Snapshot,
  type SnapshotListResponse,
  type SnapshotStage,
  type SnapshotTask,
} from '@/types';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface SnapshotsTabProps {
  bp: BusinessProcess;
}

/**
 * The per-BP Snapshots tab: data snapshots per stage (Postgres + CouchDB +
 * MinIO), restorable into any stage, plus one-click stage→stage clone.
 * Always main-scoped — the shell gates this behind `bp.inMain`.
 *
 * Progress for the async operations is polled from the snapshot-task
 * endpoint (`lib/snapshotTask.ts`), mirroring the deploy flow's deliberate
 * SSE-avoidance; an in-flight task found on mount (page reload) is resumed.
 */
export function SnapshotsTab({ bp }: SnapshotsTabProps) {
  // eslint-disable-next-line no-restricted-syntax -- null = not loaded yet
  const [data, setData] = useState<SnapshotListResponse | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- null = no load error
  const [loadError, setLoadError] = useState<string | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- null = no task in flight
  const [task, setTask] = useState<SnapshotTask | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- null = no provision in flight
  const [provisioning, setProvisioning] = useState<SnapshotStage | null>(null);
  // The open dialog (and, for restore/delete, the targeted snapshot id) lives
  // in the URL so dialogs are deep-linkable (?dialog=create, or
  // ?dialog=delete&snap=<id>).
  const [dialog, setDialog] = useUrlParam('dialog');
  const [snapId] = useUrlParam('snap');
  // Task ids already being watched — survives re-renders, guards
  // double-watching the same task (mount + explicit spawn).
  const watched = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    try {
      const res = await api.snapshots.list(bp.name);
      setData(res);
      setLoadError(null);
      return res;
    } catch (err) {
      setLoadError(String(err));
       
      return null;
    }
  }, [bp.name]);

  const watchTask = useCallback(
    (taskId: string) => {
      if (watched.current.has(taskId)) return;
      watched.current.add(taskId);
      void (async () => {
        const { outcome, task: final } = await watchSnapshotTask(taskId, setTask);
        if (outcome === 'completed') {
          toast.success(final?.message || 'Snapshot operation completed');
        } else if (outcome === 'failed') {
          toast.error(final?.error || 'Snapshot operation failed', {
            duration: 10000,
          });
        } else {
          toast.error(
            'Lost track of the snapshot task — reload to see the real state',
          );
        }
        await refresh();
        setTask(null);
        watched.current.delete(taskId);
      })();
    },
    [refresh],
  );

  // Initial load; resume watching any in-flight task after a page reload.
  useEffect(() => {
    setData(null);
    setTask(null);
    void (async () => {
      const res = await refresh();
      const active = res?.active_tasks?.[0];
      if (active) {
        setTask(active);
        watchTask(active.task_id);
      }
    })();
  }, [refresh, watchTask]);

  const bpSlug = data?.bp ?? bp.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const eligibility = data?.eligibility;
  const enabledStages = useMemo(
    () =>
      SNAPSHOT_STAGES.filter((s) => eligibility?.stages?.[s]?.registered),
    [eligibility],
  );
  const snapshots = data?.snapshots ?? [];
  const busy = task !== null;

  // Resolve the URL-keyed dialog state back to the booleans / snapshot
  // targets the JSX consumes; the setters write `dialog`/`snap` into the URL.
  const createOpen = dialog === 'create';
  const cloneOpen = dialog === 'clone';
  const restoreTarget =
    dialog === 'restore' ? snapshots.find((s) => s.id === snapId) ?? null : null;
  const deleteTarget =
    dialog === 'delete' ? snapshots.find((s) => s.id === snapId) ?? null : null;
  const setCreateOpen = useCallback(
    (open: boolean) => setDialog(open ? 'create' : null),
    [setDialog],
  );
  const setCloneOpen = useCallback(
    (open: boolean) => setDialog(open ? 'clone' : null),
    [setDialog],
  );
  const setRestoreTarget = useCallback(
    (s: Snapshot | null) => setUrlParams({ dialog: s ? 'restore' : null, snap: s?.id ?? null }),
    [],
  );
  const setDeleteTarget = useCallback(
    (s: Snapshot | null) => setUrlParams({ dialog: s ? 'delete' : null, snap: s?.id ?? null }),
    [],
  );

  const runProvision = useCallback(
    async (stage: SnapshotStage) => {
      setProvisioning(stage);
      try {
        await api.snapshots.provision(bp.name, stage, bp.name);
        toast.success(
          `Snapshots enabled for ${STAGE_META[stage].label} — the per-BP databases start empty`,
        );
        await refresh();
      } catch (err) {
        toast.error(`Failed to enable snapshots: ${String(err)}`);
      } finally {
         
        setProvisioning(null);
      }
    },
    [bp.name, refresh],
  );

  const runCreate = useCallback(
    async (stage: SnapshotStage, label: string) => {
      setCreateOpen(false);
      try {
        const { task_id } = await api.snapshots.create(bp.name, stage, label);
        watchTask(task_id);
      } catch (err) {
        toast.error(`Failed to start snapshot: ${String(err)}`);
      }
    },
    [bp.name, watchTask],
  );

  const runRestore = useCallback(
    async (snapshot: Snapshot, target: SnapshotStage) => {
       
      setRestoreTarget(null);
      try {
        const { task_id } = await api.snapshots.restore(bp.name, {
          snapshot_id: snapshot.id,
          source_stage: snapshot.stage,
          target_stage: target,
        });
        watchTask(task_id);
      } catch (err) {
        toast.error(`Failed to start restore: ${String(err)}`);
      }
    },
    [bp.name, watchTask],
  );

  const runClone = useCallback(
    async (source: SnapshotStage, target: SnapshotStage) => {
      setCloneOpen(false);
      try {
        const { task_id } = await api.snapshots.clone(bp.name, {
          source_stage: source,
          target_stage: target,
        });
        watchTask(task_id);
      } catch (err) {
        toast.error(`Failed to start clone: ${String(err)}`);
      }
    },
    [bp.name, watchTask],
  );

  const runDelete = useCallback(
    async (snapshot: Snapshot) => {
       
      setDeleteTarget(null);
      try {
        await api.snapshots.remove(bp.name, snapshot.stage, snapshot.id);
        toast.success(`Snapshot ${snapshot.label || snapshot.id} deleted`);
        await refresh();
      } catch (err) {
        toast.error(`Failed to delete snapshot: ${String(err)}`);
      }
    },
    [bp.name, refresh],
  );

  if (data === null && loadError === null) {
    return (
      <div className="flex-1 overflow-auto bg-background px-7 py-6">
        <EmptyState message="Loading snapshots…" />
      </div>
    );
  }
  if (loadError !== null && data === null) {
    return (
      <div className="flex-1 overflow-auto bg-background px-7 py-6">
        <EmptyState message={`Failed to load snapshots: ${loadError}`} />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto bg-background">
      <div className="mx-auto flex max-w-5xl flex-col gap-5 px-7 py-6">
        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Data snapshots
            </div>
            <h1 className="text-xl font-bold tracking-tight">{bp.name}</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Snapshot this process&apos;s data (Postgres, CouchDB, MinIO) per
              stage and restore it into any stage. Code is never touched.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              disabled={busy || enabledStages.length < 2}
              title={
                enabledStages.length < 2
                  ? 'Enable snapshots on at least two stages to clone'
                  : 'Copy one stage’s data into another'
              }
              onClick={() => setCloneOpen(true)}
            >
              <Copy className="size-3.5" aria-hidden />
              Clone stage
            </Button>
            <Button
              size="sm"
              disabled={busy || enabledStages.length === 0}
              title={
                enabledStages.length === 0
                  ? 'Enable snapshots on a stage first'
                  : 'Create a snapshot'
              }
              onClick={() => setCreateOpen(true)}
            >
              <Camera className="size-3.5" aria-hidden />
              Create snapshot
            </Button>
          </div>
        </div>

        {/* Active task progress */}
        {task && <TaskProgressCard task={task} />}

        {/* Eligibility / enablement */}
        <div className="rounded-xl border border-border bg-background p-4 shadow-sm">
          <div className="flex items-center gap-2">
            <Database className="size-4 text-muted-foreground" aria-hidden />
            <span className="text-sm font-semibold">Per-stage snapshot status</span>
          </div>
          {enabledStages.length === 0 && (
            <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
              Snapshots need this process to use its own databases inside the
              shared Postgres/CouchDB/MinIO servers. New processes get them on
              their first deploy; existing ones opt in per stage below.{' '}
              <strong>Enabling starts with empty per-process databases</strong>{' '}
              — data already in the shared databases is not migrated.
            </p>
          )}
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
            {SNAPSHOT_STAGES.map((s) => {
              const st = eligibility?.stages?.[s];
              const registered = !!st?.registered;
              const meta = STAGE_META[s];
              return (
                <div
                  key={s}
                  className="flex items-center gap-2 rounded-lg border border-border px-3 py-2"
                >
                  <meta.Icon
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                    {meta.label}
                  </span>
                  {registered ? (
                    <Badge
                      variant="outline"
                      className="border-emerald-200 bg-emerald-50 text-emerald-700"
                    >
                      Enabled
                    </Badge>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={provisioning !== null || busy}
                      onClick={() => void runProvision(s)}
                    >
                      {provisioning === s ? (
                        <Loader2 className="size-3 animate-spin" aria-hidden />
                      ) : null}
                      Enable
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Snapshot history */}
        <div>
          <div className="flex items-center border-b border-border">
            <span className="flex items-center gap-2 border-b-2 border-foreground px-1 pb-2 text-[13px] font-semibold text-foreground">
              <History className="size-4" aria-hidden />
              Snapshots
              <span className="rounded-full bg-muted px-1.5 text-[11px] font-semibold text-muted-foreground">
                {snapshots.length}
              </span>
            </span>
            <span className="ml-auto flex items-center gap-1.5 pb-2 text-xs text-muted-foreground">
              <HardDrive className="size-3.5" aria-hidden />
              {formatBytes(data?.disk_usage_bytes ?? 0)} on disk
            </span>
          </div>

          {snapshots.length === 0 ? (
            <div className="py-8">
              <EmptyState
                message={
                  enabledStages.length === 0
                    ? 'Enable snapshots on a stage to get started.'
                    : 'No snapshots yet — create one with “Create snapshot”.'
                }
              />
            </div>
          ) : (
            <div className="mt-3 flex flex-col gap-2">
              {snapshots.map((s) => {
                const meta = STAGE_META[s.stage];
                return (
                  <div
                    key={`${s.stage}-${s.id}`}
                    className="flex items-center gap-3 rounded-lg border border-border bg-background px-4 py-3"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <Camera className="size-4 text-muted-foreground" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold">
                          {s.label || s.id}
                        </span>
                        <Badge variant="outline" className={cn('shrink-0', meta.badge)}>
                          {meta.label}
                        </Badge>
                        {s.kind === 'auto' && (
                          <Badge variant="secondary" className="shrink-0">
                            auto
                          </Badge>
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{formatWhen(s.created_at)}</span>
                        <span aria-hidden>·</span>
                        <span>{formatBytes(s.total_size_bytes)}</span>
                        {s.label && (
                          <>
                            <span aria-hidden>·</span>
                            <span className="font-mono">{s.id}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => setRestoreTarget(s)}
                    >
                      <RotateCcw className="size-3.5" aria-hidden />
                      Restore
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      title="Delete snapshot"
                      onClick={() => setDeleteTarget(s)}
                    >
                      <Trash2 className="size-3.5 text-muted-foreground" aria-hidden />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <CreateSnapshotDialog
        open={createOpen}
        enabledStages={enabledStages}
        onCancel={() => setCreateOpen(false)}
        onConfirm={(stage, label) => void runCreate(stage, label)}
      />

      <RestoreDialog
        snapshot={restoreTarget}
        bpSlug={bpSlug}
        enabledStages={SNAPSHOT_STAGES}
        onCancel={() => setRestoreTarget(null)}
        onConfirm={(snapshot, target) => void runRestore(snapshot, target)}
      />

      <CloneDialog
        open={cloneOpen}
        bpSlug={bpSlug}
        enabledStages={enabledStages}
        onCancel={() => setCloneOpen(false)}
        onConfirm={(source, target) => void runClone(source, target)}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete snapshot?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? `This permanently deletes “${deleteTarget.label || deleteTarget.id}” (${STAGE_META[deleteTarget.stage].label}, ${formatBytes(deleteTarget.total_size_bytes)}). The stage's live data is not affected.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteTarget(null)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && void runDelete(deleteTarget)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const OPERATION_LABEL: Record<SnapshotTask['operation'], string> = {
  create: 'Creating snapshot',
  restore: 'Restoring snapshot',
  clone: 'Cloning stage data',
};

function TaskProgressCard({ task }: { task: SnapshotTask }) {
  const pct = snapshotTaskProgress(task);
  const stages =
    task.source_stage && task.target_stage && task.source_stage !== task.target_stage
      ? `${STAGE_META[task.source_stage].label} → ${STAGE_META[task.target_stage].label}`
      : task.source_stage
        ? STAGE_META[task.source_stage].label
        : '';
  return (
    <div className="rounded-xl border border-border bg-background p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
        <span className="text-sm font-semibold">
          {OPERATION_LABEL[task.operation] ?? 'Snapshot operation'}
          {stages ? ` — ${stages}` : ''}
        </span>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {pct}%
        </span>
      </div>
      <Progress value={pct} className="mt-3" />
      <div className="mt-2 text-xs text-muted-foreground">
        {task.message || snapshotStepLabel(task.step)}
      </div>
    </div>
  );
}

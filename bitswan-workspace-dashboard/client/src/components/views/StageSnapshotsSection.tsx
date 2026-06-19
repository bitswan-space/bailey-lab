import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  Camera,
  Copy,
  Loader2,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  CloneDialog,
  CreateSnapshotDialog,
  RestoreDialog,
  type RestoreTarget,
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
import { api, type BackupState } from '@/lib/api';
import {
  snapshotStepLabel,
  snapshotTaskProgress,
  watchSnapshotTask,
} from '@/lib/snapshotTask';
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

/** The services captured in a snapshot, e.g. "Postgres + MinIO". */
function servicesLabel(s: Snapshot): string {
  const names: Record<string, string> = {
    postgres: 'Postgres',
    couchdb: 'CouchDB',
    minio: 'MinIO',
  };
  const included = Object.entries(s.services)
    .filter(([, meta]) => meta?.included)
    .map(([key]) => names[key] ?? key);
  return included.length ? included.join(' + ') : 'no services';
}

interface StageSnapshotsSectionProps {
  bp: BusinessProcess;
  stage: SnapshotStage;
}

/**
 * Per-stage data-snapshots panel, rendered inside the Deployments view's
 * stage detail (the "Snapshots" section tab). Scoped to the currently
 * selected stage: its snapshots, Create, Restore and Delete, plus a
 * cross-stage Clone when more than one stage is snapshot-enabled.
 *
 * Snapshot data (and in-flight tasks) are BP-wide, so the load is keyed on
 * the BP — switching stages just re-filters the same response. Progress for
 * the async operations is polled from the snapshot-task endpoint
 * (`lib/snapshotTask.ts`); an in-flight task found on mount is resumed.
 */
export function StageSnapshotsSection({ bp, stage }: StageSnapshotsSectionProps) {
  // eslint-disable-next-line no-restricted-syntax -- null = not loaded yet
  const [data, setData] = useState<SnapshotListResponse | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- null = no load error
  const [loadError, setLoadError] = useState<string | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- null = no task in flight
  const [task, setTask] = useState<SnapshotTask | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  // eslint-disable-next-line no-restricted-syntax -- null = dialog closed
  const [restoreTarget, setRestoreTarget] = useState<Snapshot | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- null = dialog closed
  const [deleteTarget, setDeleteTarget] = useState<Snapshot | null>(null);
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

  // Initial load (per BP); resume watching any in-flight task after a reload.
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
    () => SNAPSHOT_STAGES.filter((s) => eligibility?.stages?.[s]?.registered),
    [eligibility],
  );
  const stageEnabled = !!eligibility?.stages?.[stage]?.registered;
  const stageSnapshots = useMemo(
    () => (data?.snapshots ?? []).filter((s) => s.stage === stage),
    [data, stage],
  );
  const busy = task !== null;
  const meta = STAGE_META[stage];

  const runProvision = useCallback(async () => {
    setProvisioning(true);
    try {
      await api.snapshots.provision(bp.name, stage, bp.name);
      toast.success(
        `Snapshots enabled for ${STAGE_META[stage].label} — the per-BP databases start empty`,
      );
      await refresh();
    } catch (err) {
      toast.error(`Failed to enable snapshots: ${String(err)}`);
    } finally {
      setProvisioning(false);
    }
  }, [bp.name, stage, refresh]);

  const runCreate = useCallback(
    async (target: SnapshotStage, label: string) => {
      setCreateOpen(false);
      try {
        const { task_id } = await api.snapshots.create(bp.name, target, label);
        watchTask(task_id);
      } catch (err) {
        toast.error(`Failed to start snapshot: ${String(err)}`);
      }
    },
    [bp.name, watchTask],
  );

  const runRestore = useCallback(
    async (snapshot: Snapshot, target: RestoreTarget) => {
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
    return <EmptyState message="Loading snapshots…" />;
  }
  if (loadError !== null && data === null) {
    return <EmptyState message={`Failed to load snapshots: ${loadError}`} />;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Production: retention policy + live/standby slot + audit log. */}
      {stage === 'production' && <ProductionBackupCard bp={bp.name} />}

      {/* Intro + actions */}
      <div className="flex flex-wrap items-start gap-3">
        <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-muted-foreground">
          Point-in-time backups of <strong className="text-foreground">{meta.label}</strong>
          &apos;s data (Postgres, CouchDB, MinIO). To recover, restore one into the isolated{' '}
          <strong className="text-foreground">Disaster Recovery</strong> slot and verify it before
          going live — restoring directly onto live Production is not allowed. Code and deployments
          are never touched.
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {stageEnabled && enabledStages.length >= 2 && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              title={`Copy ${meta.label}’s data into another stage`}
              onClick={() => setCloneOpen(true)}
            >
              <Copy className="size-3.5" aria-hidden />
              Clone
            </Button>
          )}
          <Button
            size="sm"
            disabled={busy || !stageEnabled}
            title={
              stageEnabled
                ? `Create a snapshot of ${meta.label}`
                : `Enable snapshots for ${meta.label} first`
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

      {!stageEnabled ? (
        <div className="rounded-xl border border-border bg-background p-4 shadow-sm">
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Snapshots need <strong className="text-foreground">{meta.label}</strong> to
            use its own databases inside the shared Postgres/CouchDB/MinIO
            servers. New processes get them on their first deploy; existing ones
            opt in here.{' '}
            <strong>Enabling starts with empty per-process databases</strong> —
            data already in the shared databases is not migrated.
          </p>
          <Button
            size="sm"
            className="mt-3"
            disabled={provisioning || busy}
            onClick={() => void runProvision()}
          >
            {provisioning ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : null}
            Enable snapshots for {meta.label}
          </Button>
        </div>
      ) : stageSnapshots.length === 0 ? (
        <div className="py-6">
          <EmptyState message="No snapshots yet — create one with “Create snapshot”." />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {stageSnapshots.map((s) => (
            <div
              key={`${s.stage}-${s.id}`}
              className="flex items-center gap-3 rounded-lg border border-border bg-background px-4 py-3"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                <Archive className="size-4 text-muted-foreground" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold">
                    {s.label || s.id}
                  </span>
                  {s.kind === 'auto' ? (
                    <Badge variant="secondary" className="shrink-0">
                      auto
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="shrink-0 border-sky-200 bg-sky-50 text-sky-700"
                    >
                      manual
                    </Badge>
                  )}
                </div>
                <div className="mt-0.5 flex items-center gap-2 font-mono text-xs text-muted-foreground">
                  <span>{formatWhen(s.created_at)}</span>
                  <span aria-hidden>·</span>
                  <span>{formatBytes(s.total_size_bytes)}</span>
                  <span aria-hidden>·</span>
                  <span>{servicesLabel(s)}</span>
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
          ))}
        </div>
      )}

      <CreateSnapshotDialog
        open={createOpen}
        enabledStages={[stage]}
        fixedStage={stage}
        onCancel={() => setCreateOpen(false)}
        onConfirm={(target, label) => void runCreate(target, label)}
      />

      <RestoreDialog
        snapshot={restoreTarget}
        enabledStages={enabledStages}
        onCancel={() => setRestoreTarget(null)}
        onConfirm={(snapshot, target) => void runRestore(snapshot, target)}
      />

      <CloneDialog
        open={cloneOpen}
        enabledStages={enabledStages}
        fixedSource={stage}
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

/**
 * Production-only: the backup retention policy, the live/standby (Production/DR)
 * slot indicator, and the audit log of backup/restore/swap events — all from
 * the gitops `backups` model (versioned in bitswan.yaml). Per the wireframe's
 * BackupPolicyCard + AuditLogView.
 */
function ProductionBackupCard({ bp }: { bp: string }) {
  // eslint-disable-next-line no-restricted-syntax -- null = not loaded yet
  const [state, setState] = useState<BackupState | null>(null);
  const [draft, setDraft] = useState<{ daily: number; weekly: number; monthly: number } | null>(
    null,
  );
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    let alive = true;
    api
      .backups(bp)
      .then((s) => {
        if (!alive) return;
        setState(s);
        setDraft(s.retention);
      })
      .catch(() => alive && setState(null));
    return () => {
      alive = false;
    };
  }, [bp]);
  useEffect(() => load(), [load]);

  if (!state || !draft) return null;

  const dirty =
    draft.daily !== state.retention.daily ||
    draft.weekly !== state.retention.weekly ||
    draft.monthly !== state.retention.monthly;

  const save = () => {
    setSaving(true);
    const work = api.setBackupRetention(bp, draft);
    toast.promise(work, {
      loading: 'Saving retention policy…',
      success: 'Retention policy saved — versioned in bitswan.yaml',
      error: (e: unknown) => `Couldn't save: ${String(e)}`,
    });
    work
      .then((s) => {
        setState(s);
        setDraft(s.retention);
      })
      .catch(() => {})
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-background p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-[13px] font-bold text-foreground">
          Backup retention &amp; blue-green state
        </span>
        <div className="inline-flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-700">
            <span className="font-mono font-bold">slot {state.live_slot.toUpperCase()}</span>
            <span className="opacity-70">→ db{state.live_db}</span>
            <span className="rounded-full bg-emerald-600 px-1 text-[9px] font-bold uppercase text-white">
              live
            </span>
          </span>
          {state.dr_slot && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-700">
              <span className="font-mono font-bold">slot {state.dr_slot.toUpperCase()}</span>
              <span className="opacity-70">→ db{state.standby_db}</span>
              <span className="rounded-full bg-amber-500 px-1 text-[9px] font-bold uppercase text-white">
                DR
              </span>
            </span>
          )}
          {state.idle_slots.map((s) => (
            <span
              key={s}
              className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-mono font-medium text-muted-foreground"
              title="Idle — the zero-downtime promote buffer"
            >
              slot {s.toUpperCase()} · idle
            </span>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        {(['daily', 'weekly', 'monthly'] as const).map((k) => (
          <label key={k} className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {k}
            </span>
            <input
              type="number"
              min={0}
              value={draft[k]}
              onChange={(e) =>
                setDraft((d) => d && { ...d, [k]: Math.max(0, Number(e.target.value) || 0) })
              }
              className="h-8 w-20 rounded-md border border-border bg-background px-2 text-[13px] outline-none focus:border-primary"
            />
          </label>
        ))}
        <Button size="sm" disabled={!dirty || saving} onClick={save}>
          {saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
          Save policy
        </Button>
        <span className="text-[11px] text-muted-foreground">
          How many automatic backups to keep per cadence (0 disables). Manual backups are kept until
          deleted.
        </span>
      </div>

      {state.log.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-border pt-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Audit log
          </span>
          {state.log.slice(0, 8).map((e) => (
            <div key={e.id} className="flex items-baseline gap-2 text-[12px]">
              <span className="rounded bg-muted px-1.5 text-[10px] font-semibold uppercase text-muted-foreground">
                {e.action}
              </span>
              <span className="min-w-0 flex-1 truncate text-foreground">{e.detail}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {e.by} · {e.at}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

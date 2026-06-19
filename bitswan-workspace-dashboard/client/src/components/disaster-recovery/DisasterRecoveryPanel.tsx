import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ClipboardCheck,
  DatabaseBackup,
  ExternalLink,
  Globe,
  Loader2,
  Lock,
  Pencil,
  ShieldCheck,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, type BpSnapshot, type DrPolicy, type DrStatus } from '@/lib/api';
import type { SnapshotTask } from '@/types';
import { snapshotStepLabel, watchSnapshotTask } from '@/lib/snapshotTask';
import { cn } from '@/lib/utils';

/**
 * Disaster Recovery panel (Deployments → DR stage → Recovery & rehearsal).
 *
 * DR mirrors Production against its own isolated database. Recovery is
 * rehearsed by hand: restore a Production backup INTO DR (replacing the DR
 * standby db), open the DR app and verify the data, then mark that backup
 * recovery-tested. Only the backup currently restored into DR can be tested —
 * you can only verify what is actually loaded right now. Going live (the swap)
 * is the "Restore" action on the stage row; it never moves data here.
 *
 * The cadence policy (quarterly default) is admin/auditor-only and edited
 * behind a pencil so it can't be changed by accident. The signed-in role is
 * shown so it's clear why the controls differ.
 */

const POLICY_LABEL: Record<DrPolicy, string> = {
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  'semi-annually': 'Semi-annually',
  annually: 'Annually',
};
const POLICIES: DrPolicy[] = ['monthly', 'quarterly', 'semi-annually', 'annually'];

type Role = 'admin' | 'auditor' | 'member';
const ROLE_LABEL: Record<Role, string> = {
  admin: 'Admin',
  auditor: 'Auditor',
  member: 'Member',
};

interface Frontend {
  id: string;
  name: string;
  // eslint-disable-next-line no-restricted-syntax -- null = not deployed
  url: string | null;
}

function fmtSize(bytes: number): string {
  if (!bytes) return '—';
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

export function DisasterRecoveryPanel({
  bp,
  frontends,
}: {
  bp: string;
  frontends: Frontend[];
}) {
  const [dr, setDr] = useState<DrStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [snapshots, setSnapshots] = useState<BpSnapshot[]>([]);
  const [role, setRole] = useState<Role>('member');
  const [editingPolicy, setEditingPolicy] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);
  // eslint-disable-next-line no-restricted-syntax -- null = none being recorded
  const [testingId, setTestingId] = useState<string | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- null = no restore in flight
  const [restoringId, setRestoringId] = useState<string | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- null until first poll lands
  const [restoreTask, setRestoreTask] = useState<SnapshotTask | null>(null);

  // Refetch DR status + Production backups WITHOUT flashing the full-panel
  // loader (used after a restore/test so the list updates in place).
  const refresh = useCallback(() => {
    api
      .drStatus(bp)
      .then(setDr)
      .catch(() => {});
    api
      .bpSnapshots(bp)
      .then((r) => setSnapshots(r.snapshots.filter((s) => s.stage === 'production')))
      .catch(() => {});
  }, [bp]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.allSettled([api.drStatus(bp), api.bpSnapshots(bp)])
      .then(([d, s]) => {
        if (!alive) return;
        if (d.status === 'fulfilled') setDr(d.value);
        if (s.status === 'fulfilled')
          setSnapshots(s.value.snapshots.filter((x) => x.stage === 'production'));
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [bp]);

  // Cadence is admin/auditor-only (gated server-side too). The role is also
  // surfaced in the UI so it's clear why the controls differ per user.
  useEffect(() => {
    let alive = true;
    api
      .getMe()
      .then((m) => alive && setRole((m.role as Role) || 'member'))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const canEditPolicy = role === 'admin' || role === 'auditor';

  // The backup currently loaded into the DR standby db — the ONLY one that may
  // be recovery-tested.
  const restoredSnap = dr?.restored?.snapshot ?? null;
  // Newest recovery test per backup id — drives the "Tested" badge.
  const testBySnap = useMemo(() => {
    const m: Record<string, DrStatus['tests'][number]> = {};
    for (const t of dr?.tests ?? []) if (t.snapshot && !m[t.snapshot]) m[t.snapshot] = t;
    return m;
  }, [dr]);

  const setPolicy = (policy: DrPolicy) => {
    setSavingPolicy(true);
    api
      .setDrPolicy(bp, policy)
      .then((d) => {
        setDr(d);
        setEditingPolicy(false);
      })
      .catch((e: unknown) => toast.error(`Couldn't update policy: ${String(e)}`))
      .finally(() => setSavingPolicy(false));
  };

  const testSnapshot = useCallback(
    (snap: BpSnapshot) => {
      setTestingId(snap.id);
      const work = api.recordDrTest(bp, {
        snapshot: snap.id,
        note: `Recovery of "${snap.label || snap.id}" verified by hand.`,
      });
      toast.promise(work, {
        loading: 'Recording recovery test…',
        success: `Marked “${snap.label || snap.id}” recovery-tested`,
        error: (e: unknown) => `Couldn't record: ${String(e)}`,
      });
      work
        .then(setDr)
        .catch(() => {})
        .finally(() => setTestingId(null));
    },
    [bp],
  );

  const restoreToDr = useCallback(
    (snap: BpSnapshot) => {
      setRestoringId(snap.id);
      setRestoreTask(null);
      const start = api.snapshots.restore(bp, {
        snapshot_id: snap.id,
        source_stage: 'production',
        target_stage: 'dr',
      });
      const work = start.then(({ task_id }) =>
        watchSnapshotTask(task_id, setRestoreTask),
      );
      toast.promise(work, {
        loading: `Restoring “${snap.label || snap.id}” into Disaster Recovery…`,
        success: (res) =>
          res.outcome === 'completed'
            ? `Restored into DR — verify in the app, then mark it tested`
            : `Restore ${res.outcome}`,
        error: (e: unknown) => `Couldn't restore: ${String(e)}`,
      });
      work
        .then(() => refresh())
        .catch(() => {})
        .finally(() => {
          setRestoringId(null);
          setRestoreTask(null);
        });
    },
    [bp, refresh],
  );

  if (loading || !dr) {
    return (
      <div className="flex items-center justify-center gap-2 p-6 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading disaster recovery…
      </div>
    );
  }

  const overdue = dr.overdue;
  const lastTxt = dr.last ? `${dr.last.at} by ${dr.last.by}` : 'never';

  return (
    <div className="relative flex flex-col gap-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-[52rem] text-[12.5px] leading-relaxed text-muted-foreground">
          Disaster Recovery mirrors <strong className="text-foreground">Production</strong>{' '}
          against its <strong className="text-foreground">own isolated database</strong>. To
          rehearse recovery, <strong className="text-foreground">restore</strong> a Production
          backup into DR below, open the DR app and confirm the data by hand, then mark that
          backup <strong className="text-foreground">recovery-tested</strong>. Only the backup
          currently loaded into DR can be tested. Going live (swapping DR with Production) is the{' '}
          <strong className="text-foreground">Restore</strong> action on the stage row — rehearsal
          never swaps.
        </p>
        {/* Signed-in role — the panel's controls differ per role, so show it. */}
        <span
          title={
            canEditPolicy
              ? 'You can change the recovery-test cadence.'
              : 'Only admins and auditors can change the recovery-test cadence.'
          }
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2.5 py-1 text-[11.5px] font-medium text-muted-foreground"
        >
          <ShieldCheck className="size-3.5" aria-hidden />
          Signed in as <strong className="font-semibold text-foreground">{ROLE_LABEL[role]}</strong>
        </span>
      </div>

      {/* Status + cadence policy */}
      <div
        className={cn(
          'flex flex-wrap items-center gap-3.5 rounded-[10px] border px-4 py-3.5',
          overdue ? 'border-amber-300 bg-amber-50' : 'border-emerald-300 bg-emerald-50',
        )}
      >
        {overdue ? (
          <AlertTriangle className="size-5 shrink-0 text-amber-600" aria-hidden />
        ) : (
          <ShieldCheck className="size-5 shrink-0 text-emerald-600" aria-hidden />
        )}
        <div className="min-w-[200px] flex-1">
          <div className={cn('text-sm font-bold', overdue ? 'text-amber-800' : 'text-emerald-800')}>
            {overdue
              ? dr.days_since == null
                ? 'Never tested — recovery unverified'
                : `Recovery test overdue by ${dr.days_since - dr.window_days} days`
              : `Recovery verified · last tested ${dr.days_since} days ago`}
          </div>
          <div
            className={cn(
              'mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px]',
              overdue ? 'text-amber-800' : 'text-emerald-700',
            )}
          >
            <span>Last manual check: {lastTxt}</span>
            <span aria-hidden>·</span>
            {editingPolicy && canEditPolicy ? (
              <span className="inline-flex items-center gap-1.5">
                <span>cadence</span>
                <select
                  autoFocus
                  value={dr.policy}
                  disabled={savingPolicy}
                  onChange={(e) => setPolicy(e.target.value as DrPolicy)}
                  className="h-7 rounded-md border border-border bg-white px-2 text-[12px] font-medium text-foreground outline-none focus:border-primary"
                >
                  {POLICIES.map((p) => (
                    <option key={p} value={p}>
                      {POLICY_LABEL[p]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setEditingPolicy(false)}
                  className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
                >
                  Done
                </button>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <span>
                  tested{' '}
                  <strong className="font-semibold">
                    {POLICY_LABEL[dr.policy].toLowerCase()}
                  </strong>
                </span>
                {canEditPolicy ? (
                  <button
                    type="button"
                    onClick={() => setEditingPolicy(true)}
                    title="Change the recovery-test cadence (admin / auditor)"
                    className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-black/5 hover:text-foreground"
                  >
                    <Pencil className="size-3" aria-hidden />
                  </button>
                ) : (
                  <span
                    title="Only admins and auditors can change the cadence."
                    className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground/80"
                  >
                    <Lock className="size-3" aria-hidden />
                    <span>admins / auditors</span>
                  </span>
                )}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* DR app links — open these to verify the recovered data before marking tested. */}
      {frontends.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
          <span className="font-medium">Verify in the DR app:</span>
          {frontends.map((f) => (
            <a
              key={f.id}
              href={f.url ?? '#'}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-[28px] items-center gap-1.5 rounded-md border border-border bg-background px-2.5 font-medium text-foreground hover:border-primary/40"
            >
              <Globe className="size-3.5 text-muted-foreground" aria-hidden />
              {f.name}
              <ExternalLink className="size-3 text-muted-foreground" aria-hidden />
            </a>
          ))}
        </div>
      )}

      {/* Backups — restore one into DR, verify, then mark the restored one tested. */}
      <div className="overflow-hidden rounded-[10px] border border-border bg-background">
        <div className="flex items-center gap-1.5 border-b border-border bg-muted/40 px-3.5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <ClipboardCheck className="size-3" aria-hidden />
          Production backups — restore &amp; rehearse
          <span className="ml-auto text-[11px] font-medium normal-case tracking-normal text-muted-foreground">
            {Object.keys(testBySnap).length} of {snapshots.length} tested
          </span>
        </div>
        {snapshots.length === 0 ? (
          <div className="px-4 py-6 text-center text-[13px] text-muted-foreground">
            No Production backups yet — create one from the Backups tab, then restore it into DR
            here to rehearse recovery.
          </div>
        ) : (
          snapshots.map((s, i) => {
            const test = testBySnap[s.id];
            const isInDr = restoredSnap === s.id;
            const isRestoring = restoringId === s.id;
            return (
              <div
                key={s.id}
                className={cn(
                  'flex flex-wrap items-center gap-3 px-3.5 py-3',
                  isInDr && 'bg-primary/5',
                  i < snapshots.length - 1 && 'border-b border-border',
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-semibold text-foreground">
                      {s.label || s.id}
                    </span>
                    {isInDr && (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-primary">
                        <DatabaseBackup className="size-3" aria-hidden />
                        In DR now
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                    {s.created_at?.slice(0, 10)} · {fmtSize(s.total_size_bytes)}
                    {test && !isInDr && (
                      <span className="ml-2 font-sans text-emerald-700">
                        ✓ tested {test.at}
                      </span>
                    )}
                  </div>
                </div>

                {isRestoring ? (
                  <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    {restoreTask ? snapshotStepLabel(restoreTask.step) : 'Starting…'}
                  </span>
                ) : isInDr ? (
                  test ? (
                    <span
                      className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-1 text-[11.5px] font-semibold text-emerald-700"
                      title={test.note || undefined}
                    >
                      <Check className="size-3.5" aria-hidden />
                      Tested {test.at} · {test.by}
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={testingId === s.id}
                      onClick={() => testSnapshot(s)}
                      title="You restored this backup into DR and verified the data by hand"
                      className="inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-md border border-emerald-300 bg-emerald-50 px-3 text-[12.5px] font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                    >
                      {testingId === s.id ? (
                        <Loader2 className="size-3.5 animate-spin" aria-hidden />
                      ) : (
                        <ClipboardCheck className="size-3.5" aria-hidden />
                      )}
                      Mark recovery-tested
                    </button>
                  )
                ) : (
                  <button
                    type="button"
                    disabled={restoringId !== null}
                    onClick={() => restoreToDr(s)}
                    title="Restore this backup into the DR database (replaces DR's current data), then verify and mark it tested"
                    className="inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-[12.5px] font-semibold text-foreground hover:border-primary/40 hover:bg-muted disabled:opacity-50"
                  >
                    <DatabaseBackup className="size-3.5 text-muted-foreground" aria-hidden />
                    Restore into DR
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

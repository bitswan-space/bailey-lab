import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ClipboardCheck,
  ExternalLink,
  Globe,
  Loader2,
  Pencil,
  ShieldCheck,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, type BpSnapshot, type DrPolicy, type DrStatus, type DrTest } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Disaster Recovery panel (Deployments → DR stage → Recovery tests).
 *
 * DR mirrors Production against its own isolated database. Recovery is rehearsed
 * by hand: restore a Production backup into DR, open the DR app and verify the
 * data, then mark that backup recovery-tested. Tests are per-backup and shown
 * inline in the backup list — no modal. The cadence policy (quarterly default)
 * is admin/auditor-only and edited behind a pencil so it can't be changed by
 * accident. Going live (swap) is the "Restore" action on the stage row.
 */

const POLICY_LABEL: Record<DrPolicy, string> = {
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  'semi-annually': 'Semi-annually',
  annually: 'Annually',
};
const POLICIES: DrPolicy[] = ['monthly', 'quarterly', 'semi-annually', 'annually'];

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
  const [role, setRole] = useState('member');
  const [editingPolicy, setEditingPolicy] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);
  // eslint-disable-next-line no-restricted-syntax -- null = none being recorded
  const [testingId, setTestingId] = useState<string | null>(null);

  const reload = useCallback(() => {
    let alive = true;
    setLoading(true);
    api
      .drStatus(bp)
      .then((d) => alive && setDr(d))
      .catch(() => alive && setDr(null))
      .finally(() => alive && setLoading(false));
    api
      .bpSnapshots(bp)
      .then((r) => alive && setSnapshots(r.snapshots.filter((s) => s.stage === 'production')))
      .catch(() => alive && setSnapshots([]));
    return () => {
      alive = false;
    };
  }, [bp]);
  useEffect(() => reload(), [reload]);

  // Cadence is admin/auditor-only (gated server-side too).
  useEffect(() => {
    let alive = true;
    api
      .getMe()
      .then((m) => alive && setRole(m.role || 'member'))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const canEditPolicy = role === 'admin' || role === 'auditor';

  // Newest recovery test per backup id — drives the "Tested" badge in the list.
  const testBySnap = useMemo(() => {
    const m: Record<string, DrTest> = {};
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
      <p className="text-[12.5px] leading-relaxed text-muted-foreground">
        Disaster Recovery mirrors <strong className="text-foreground">Production</strong> against its{' '}
        <strong className="text-foreground">own isolated database</strong>. To rehearse recovery,
        restore a Production backup into DR, open the DR app and confirm the data by hand, then mark
        that backup <strong className="text-foreground">recovery-tested</strong> below. Going live
        (swapping DR with Production) is the <strong className="text-foreground">Restore</strong>{' '}
        action on the stage row — testing never swaps.
      </p>

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
                <span>test every</span>
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
                  tested every <strong className="font-semibold">{POLICY_LABEL[dr.policy]}</strong>
                </span>
                {canEditPolicy && (
                  <button
                    type="button"
                    onClick={() => setEditingPolicy(true)}
                    title="Change the recovery-test cadence (admin / auditor)"
                    className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-black/5 hover:text-foreground"
                  >
                    <Pencil className="size-3" aria-hidden />
                  </button>
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

      {/* Backups — pick one to recovery-test; tested ones are badged in place. */}
      <div className="overflow-hidden rounded-[10px] border border-border bg-background">
        <div className="flex items-center gap-1.5 border-b border-border bg-muted/40 px-3.5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <ClipboardCheck className="size-3" aria-hidden />
          Production backups — recovery tests
          <span className="ml-auto text-[11px] font-medium normal-case tracking-normal text-muted-foreground">
            {Object.keys(testBySnap).length} of {snapshots.length} tested
          </span>
        </div>
        {snapshots.length === 0 ? (
          <div className="px-4 py-6 text-center text-[13px] text-muted-foreground">
            No Production backups yet — create one from the Backups tab, then recovery-test it here.
          </div>
        ) : (
          snapshots.map((s, i) => {
            const test = testBySnap[s.id];
            return (
              <div
                key={s.id}
                className={cn(
                  'flex flex-wrap items-center gap-3 px-3.5 py-3',
                  i < snapshots.length - 1 && 'border-b border-border',
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold text-foreground">
                    {s.label || s.id}
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                    {s.created_at?.slice(0, 10)} · {fmtSize(s.total_size_bytes)}
                  </div>
                </div>
                {test ? (
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
                    title="Record that you restored this backup into DR and verified the data"
                    className="inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-[12.5px] font-semibold text-foreground hover:border-primary/40 hover:bg-muted disabled:opacity-50"
                  >
                    {testingId === s.id ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    ) : (
                      <ClipboardCheck className="size-3.5 text-muted-foreground" aria-hidden />
                    )}
                    Mark recovery-tested
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

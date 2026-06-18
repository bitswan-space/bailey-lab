import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  Check,
  ClipboardCheck,
  ExternalLink,
  Globe,
  LifeBuoy,
  Loader2,
  Play,
  ShieldCheck,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, type BpSnapshot, type DrPolicy, type DrStatus } from '@/lib/api';
import { cn } from '@/lib/utils';
import { DrArchitectureDoc } from './DrArchitectureDoc';

/**
 * Disaster Recovery panel (wireframe: Deployments → DR stage → Recovery tests).
 *
 * DR mirrors Production but runs against its own isolated database. Recovery is
 * rehearsed by hand — restore a Production snapshot, verify the data, and record
 * a verified test. We persist the cadence policy + the manual-test log
 * (versioned in bitswan.yaml); there is no automated failover backend, so the
 * "tested against" snapshot picker lists real Production snapshots and the swap
 * is gated behind an honest "not configured" notice rather than a fake success.
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
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [run, setRun] = useState<{ snapId: string; didVerify: boolean; note: string } | null>(
    null,
  );
  const [swap, setSwap] = useState<{ ack: boolean } | null>(null);
  const [swapping, setSwapping] = useState(false);
  const [snapshots, setSnapshots] = useState<BpSnapshot[]>([]);
  const [recording, setRecording] = useState(false);
  // 'recovery' = the live recovery panel; 'docs' = the architecture explainer.
  const [view, setView] = useState<'recovery' | 'docs'>('recovery');

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

  const setPolicy = (policy: DrPolicy) => {
    setSavingPolicy(true);
    api
      .setDrPolicy(bp, policy)
      .then(setDr)
      .catch((e: unknown) => toast.error(`Couldn't update policy: ${String(e)}`))
      .finally(() => setSavingPolicy(false));
  };

  const recordTest = useCallback(() => {
    if (!run) return;
    setRecording(true);
    const snap = snapshots.find((s) => s.id === run.snapId);
    const work = api.recordDrTest(bp, {
      note: run.note.trim(),
      snapshot: snap?.label || undefined,
    });
    toast.promise(work, {
      loading: 'Recording recovery test…',
      success: 'Recovery test recorded — versioned in bitswan.yaml',
      error: (e: unknown) => `Couldn't record test: ${String(e)}`,
    });
    work
      .then((d) => {
        setDr(d);
        setRun(null);
      })
      .catch(() => {})
      .finally(() => setRecording(false));
  }, [bp, run, snapshots]);

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
      {/* Recovery | How it works (architecture docs) */}
      <div className="flex items-center gap-4 border-b border-border">
        <DocTab active={view === 'recovery'} onClick={() => setView('recovery')}>
          Recovery
        </DocTab>
        <DocTab active={view === 'docs'} onClick={() => setView('docs')}>
          How it works
        </DocTab>
      </div>

      {view === 'docs' && <DrArchitectureDoc />}

      {view === 'recovery' && (
        <>
      {/* What DR is */}
      <p className="text-[12.5px] leading-relaxed text-muted-foreground">
        Disaster Recovery mirrors <strong className="text-foreground">Production</strong> — same
        code, secrets and firewall rules — but runs against its{' '}
        <strong className="text-foreground">own isolated database</strong>. Restoring copies
        Production&apos;s data <em>into DR</em> (Production is untouched) so you can rehearse
        recovery and confirm, by hand, that nothing is missing. Only if you ever need to go live do
        you then <strong className="text-foreground">swap DR with Production</strong>. Routine
        testing restores &amp; verifies — it does <strong className="text-foreground">not</strong>{' '}
        swap.
      </p>

      {/* Status + policy banner */}
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
          <div className={cn('mt-0.5 text-[12px]', overdue ? 'text-amber-800' : 'text-emerald-700')}>
            Last manual check: {lastTxt} · policy: {POLICY_LABEL[dr.policy]}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[11px] font-semibold text-muted-foreground">Check every</label>
          <select
            value={dr.policy}
            disabled={savingPolicy}
            onChange={(e) => setPolicy(e.target.value as DrPolicy)}
            className="h-8 rounded-md border border-border bg-white px-2 text-[12px] font-medium outline-none focus:border-primary"
          >
            {POLICIES.map((p) => (
              <option key={p} value={p}>
                {POLICY_LABEL[p]}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setRun({ snapId: snapshots[0]?.id ?? '', didVerify: false, note: '' })}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-md px-3.5 text-[12.5px] font-semibold text-white',
              overdue ? 'bg-amber-600 hover:bg-amber-700' : 'bg-primary hover:bg-primary/90',
            )}
          >
            <Play className="size-3.5" aria-hidden />
            Test recovery
          </button>
        </div>
      </div>

      {/* Swap with Production */}
      <div className="flex flex-wrap items-center gap-3.5 rounded-[10px] border border-border bg-background px-4 py-3.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-red-50">
          <ArrowLeftRight className="size-[18px] text-red-600" aria-hidden />
        </span>
        <div className="min-w-[220px] flex-1">
          <div className="text-[13.5px] font-bold text-foreground">Swap with Production</div>
          <div className="mt-0.5 text-[12px] leading-snug text-muted-foreground">
            Go live on the recovered environment — DR becomes Production and the old Production
            becomes the standby. Only do this in a real disaster, after verifying the data.
          </div>
        </div>
        <button
          type="button"
          onClick={() => setSwap({ ack: false })}
          className="inline-flex h-[34px] shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-3.5 text-[12.5px] font-semibold text-red-700 hover:bg-muted"
        >
          <ArrowLeftRight className="size-3.5 text-red-600" aria-hidden />
          Swap with Production
        </button>
      </div>

      {/* Manual-test log */}
      <div className="overflow-hidden rounded-[10px] border border-border bg-background">
        <div className="flex items-center gap-1.5 border-b border-border bg-muted/40 px-3.5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <ClipboardCheck className="size-3" aria-hidden />
          Manual recovery tests
          <span className="ml-auto text-[11px] font-medium normal-case tracking-normal text-muted-foreground">
            {dr.tests.length} recorded
          </span>
        </div>
        {dr.tests.length === 0 ? (
          <div className="px-4 py-6 text-center text-[13px] text-muted-foreground">
            No recovery tests recorded yet.
          </div>
        ) : (
          dr.tests.map((t, i) => (
            <div
              key={t.id}
              className={cn(
                'flex items-start gap-3 px-3.5 py-3',
                i < dr.tests.length - 1 && 'border-b border-border',
              )}
            >
              <span className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-emerald-100">
                <Check className="size-[15px] text-emerald-600" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] text-foreground">
                  <strong className="font-semibold">{t.by}</strong>
                  <span className="font-normal text-muted-foreground"> verified the recovery</span>
                </div>
                {t.note && (
                  <div className="mt-1 border-l-2 border-border pl-2.5 text-[12px] leading-relaxed text-zinc-600">
                    {t.note}
                  </div>
                )}
              </div>
              <span className="whitespace-nowrap text-[11px] text-muted-foreground">{t.at}</span>
            </div>
          ))
        )}
      </div>
        </>
      )}

      {/* Run-test wizard */}
      {run && (
        <Modal onClose={() => setRun(null)}>
          <div className="flex items-center gap-3 border-b border-border px-5 py-4">
            <span className="flex size-[34px] shrink-0 items-center justify-center rounded-lg bg-muted">
              <LifeBuoy className="size-[17px] text-foreground" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-bold text-foreground">Test disaster recovery</div>
              <div className="mt-0.5 text-[12px] text-muted-foreground">{bp} · DR environment</div>
            </div>
            <button
              type="button"
              onClick={() => setRun(null)}
              className="flex size-7 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>

          <div className="flex flex-col gap-3.5 px-5 py-4">
            {/* Step 1 — restore (manual, out of band) */}
            <div className="flex gap-3">
              <StepDot n={1} />
              <div className="flex-1">
                <div className="text-[13.5px] font-semibold text-foreground">
                  Restore the Production snapshot you tested
                </div>
                <div className="mt-0.5 text-[12px] leading-snug text-muted-foreground">
                  Restore a Production Postgres + MinIO snapshot into the isolated DR database, then
                  pick which one you used. Production is untouched.
                </div>
                <div className="mt-2.5 flex flex-col gap-1.5">
                  <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Snapshot tested
                  </label>
                  {snapshots.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border px-3 py-3 text-[12px] text-muted-foreground">
                      No Production snapshots found — create one from the Backups workflow, or record
                      the test with notes only.
                    </div>
                  ) : (
                    snapshots.map((s) => {
                      const sel = run.snapId === s.id;
                      return (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => setRun((r) => r && { ...r, snapId: s.id })}
                          className={cn(
                            'flex items-center gap-2.5 rounded-md border px-2.5 py-2 text-left',
                            sel ? 'border-primary bg-primary/5' : 'border-border bg-background',
                          )}
                        >
                          <span
                            className={cn(
                              'flex size-4 shrink-0 items-center justify-center rounded-full border-2',
                              sel ? 'border-primary' : 'border-border',
                            )}
                          >
                            {sel && <span className="size-[7px] rounded-full bg-primary" />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="text-[13px] font-semibold text-foreground">
                              {s.label || s.id}
                            </span>
                            <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                              {s.created_at?.slice(0, 10)} · {fmtSize(s.total_size_bytes)}
                            </span>
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            </div>

            {/* Step 2 — verify */}
            <div className="flex gap-3">
              <StepDot n={2} />
              <div className="flex-1">
                <div className="text-[13.5px] font-semibold text-foreground">
                  Verify the data by hand
                </div>
                <div className="mt-0.5 text-[12px] leading-snug text-muted-foreground">
                  Open each DR frontend and confirm the data that should be there really is.
                </div>
                {frontends.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {frontends.map((f) => (
                      <a
                        key={f.id}
                        href={f.url ?? '#'}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex h-[30px] items-center gap-1.5 rounded-md border border-border bg-background px-3 text-[12px] font-medium text-foreground hover:border-primary/40"
                      >
                        <Globe className="size-3.5 text-muted-foreground" aria-hidden />
                        {f.name}
                        <ExternalLink className="size-3 text-muted-foreground" aria-hidden />
                      </a>
                    ))}
                  </div>
                )}
                <label className="mt-2.5 flex cursor-pointer items-start gap-2.5">
                  <input
                    type="checkbox"
                    checked={run.didVerify}
                    onChange={(e) => setRun((r) => r && { ...r, didVerify: e.target.checked })}
                    className="mt-0.5 cursor-pointer"
                  />
                  <span className="text-[13px] leading-snug text-foreground">
                    I performed the recovery procedure and confirmed in the UI that the expected
                    data is present and correct.
                  </span>
                </label>
                <textarea
                  value={run.note}
                  onChange={(e) => setRun((r) => r && { ...r, note: e.target.value })}
                  placeholder="Optional notes — what you checked, anything unexpected…"
                  rows={2}
                  className="mt-2.5 w-full resize-y rounded-md border border-border px-2.5 py-2 text-[13px] leading-relaxed outline-none focus:border-primary"
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3">
            <button
              type="button"
              onClick={() => setRun(null)}
              className="inline-flex h-8 items-center rounded-md px-3 text-[13px] font-medium text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!run.didVerify || recording}
              onClick={recordTest}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-emerald-600 px-3.5 text-[13px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-40"
            >
              {recording ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <Check className="size-3.5" aria-hidden />
              )}
              Record verified test
            </button>
          </div>
        </Modal>
      )}

      {/* Swap confirm */}
      {swap && (
        <Modal onClose={() => setSwap(null)}>
          <div className="flex items-center gap-3 border-b border-border px-5 py-4">
            <span className="flex size-[34px] shrink-0 items-center justify-center rounded-lg bg-red-50">
              <ArrowLeftRight className="size-[17px] text-red-600" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-bold text-foreground">Swap DR with Production</div>
              <div className="mt-0.5 text-[12px] text-muted-foreground">
                {bp} · zero-downtime cutover
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSwap(null)}
              className="flex size-7 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
          <div className="flex flex-col gap-3 px-5 py-4">
            <p className="text-[13px] leading-relaxed text-zinc-600">
              Traffic would be flipped to the Disaster Recovery environment: DR becomes the live{' '}
              <strong className="text-foreground">Production</strong>, and today&apos;s Production is
              demoted to standby. Only proceed during an actual disaster, after verifying the data.
            </p>
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
              <AlertTriangle className="size-3.5 shrink-0 text-amber-600" aria-hidden />
              The swap flips which slot is live and is recorded in the audit log immediately. The
              actual ingress cutover lands once the two-slot blue-green production deploy is
              provisioned for this BP; until then the recorded live slot is authoritative.
            </div>
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={swap.ack}
                onChange={(e) => setSwap((s) => s && { ...s, ack: e.target.checked })}
                className="mt-0.5 cursor-pointer"
              />
              <span className="text-[13px] leading-snug text-foreground">
                I understand this makes Disaster Recovery the live Production environment.
              </span>
            </label>
          </div>
          <div className="flex justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3">
            <button
              type="button"
              onClick={() => setSwap(null)}
              className="inline-flex h-8 items-center rounded-md px-3 text-[13px] font-medium text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!swap.ack || swapping}
              onClick={() => {
                setSwapping(true);
                const work = api.swapProductionDr(bp);
                toast.promise(work, {
                  loading: 'Swapping DR ↔ Production…',
                  success: (s) =>
                    `Swapped — production is now slot ${s.live_slot.toUpperCase()} (versioned in bitswan.yaml)`,
                  error: (e: unknown) => `Swap failed: ${String(e)}`,
                });
                work
                  .then(() => {
                    setSwap(null);
                    reload();
                  })
                  .catch(() => {})
                  .finally(() => setSwapping(false));
              }}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-red-600 px-3.5 text-[13px] font-semibold text-white hover:bg-red-700 disabled:opacity-40"
            >
              {swapping ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <ArrowLeftRight className="size-3.5" aria-hidden />
              )}
              Swap now
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function DocTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        '-mb-px border-b-2 px-1 py-2 text-[13px] transition-colors',
        active
          ? 'border-foreground font-semibold text-foreground'
          : 'border-transparent font-medium text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function StepDot({ n }: { n: number }) {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[12px] font-bold text-muted-foreground">
      {n}
    </span>
  );
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/45 p-10"
      onClick={onClose}
    >
      <div
        className="w-[520px] max-w-[96%] overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

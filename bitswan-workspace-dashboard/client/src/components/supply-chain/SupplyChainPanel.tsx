import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, ExternalLink, EyeOff, Loader2, ShieldOff, Undo2 } from 'lucide-react';
import { toast } from '@/lib/notify';
import { api, type CveSeverity, type SupplyChainReport } from '@/lib/api';
import { useSupplyChainTick } from '@/components/workspace/WorkspaceProvider';
import { cn } from '@/lib/utils';

/**
 * Supply chain panel (wireframe `SupplyChain`): the SBOM packages + grype CVEs
 * for the image(s) deployed to a stage, a severity rollup, and a "mark CVE out
 * of scope" flow. Out-of-scope markings are stored in bitswan.yaml (versioned)
 * with who/when/why and shown in an audit log; they drop out of the rollup.
 *
 * Real images yield hundreds of packages, so we sort vulnerable-first and hide
 * clean packages behind a toggle (everything is still one click away).
 */

const SEV: Record<CveSeverity, { pill: string; dot: string; label: string }> = {
  critical: { pill: 'bg-red-100 text-red-700', dot: 'bg-red-600', label: 'Critical' },
  high: { pill: 'bg-orange-100 text-orange-700', dot: 'bg-orange-600', label: 'High' },
  medium: { pill: 'bg-yellow-100 text-yellow-700', dot: 'bg-yellow-600', label: 'Medium' },
  low: { pill: 'bg-sky-100 text-sky-700', dot: 'bg-sky-600', label: 'Low' },
};
const SEV_ORDER: CveSeverity[] = ['critical', 'high', 'medium', 'low'];

/** External advisory links for a vulnerability id — osv.dev covers everything;
 *  the others are added when the id namespace matches (CVE / GHSA / Go). */
function advisoryLinks(id: string): { label: string; href: string }[] {
  const links = [{ label: 'osv.dev', href: `https://osv.dev/vulnerability/${id}` }];
  if (id.startsWith('CVE-'))
    links.push({ label: 'NVD', href: `https://nvd.nist.gov/vuln/detail/${id}` });
  if (id.startsWith('GHSA-'))
    links.push({ label: 'GitHub advisory', href: `https://github.com/advisories/${id}` });
  if (id.startsWith('GO-'))
    links.push({ label: 'Go vuln DB', href: `https://pkg.go.dev/vuln/${id}` });
  return links;
}

export function SupplyChainPanel({
  bp,
  stage,
  stageLabel,
  readOnly = false,
  copy,
  fetcher,
  emptyHint,
  intro,
}: {
  bp: string;
  stage: string;
  stageLabel: string;
  readOnly?: boolean;
  /** Copy whose source tree out-of-scope markings are written to (Checks tab).
   *  Required for editing; the read-only Supply chain tab omits it. */
  copy?: string | null;
  /** Override how the report is loaded (defaults to the deployed-image scan).
   *  The Checks tab passes a preview fetch of the about-to-be-built image. */
  fetcher?: () => Promise<SupplyChainReport>;
  /** Message shown when there's nothing to scan (status not-deployed). */
  emptyHint?: string;
  /** Override the intro line above the rollup (e.g. the Checks tab explains
   *  it's the to-be-built image, not a deployed one). */
  intro?: React.ReactNode;
}) {
  const [report, setReport] = useState<SupplyChainReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [showClean, setShowClean] = useState(false);
  const [dialog, setDialog] = useState<{
    package: string;
    version: string;
    cve: string;
    severity: CveSeverity;
  } | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  const fetchReport = useCallback(
    () => (fetcher ? fetcher() : api.supplyChain(bp, stage)),
    [bp, stage, fetcher],
  );

  // Live mirror of the current status + in-flight bookkeeping, so the scan-done
  // handler reasons about the LATEST state (not a stale effect closure).
  const statusRef = useRef<SupplyChainReport['status'] | undefined>(undefined);
  statusRef.current = report?.status;
  const fetchingRef = useRef(false);
  const queuedRef = useRef(false); // a scan finished while a fetch was in flight
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Single fetch path. `showLoading` drives the big "Loading…" state for the
  // initial/target load; scan-driven refetches are quiet (they keep the
  // "Scanning…" view until results land). If a scan completes mid-fetch and
  // we're still pending afterwards, fetch once more — so the final result is
  // never missed. Event-driven; the bake is serialized server-side so repeats
  // are safe cache hits.
  const runFetch = useCallback(
    (showLoading: boolean) => {
      if (fetchingRef.current) {
        queuedRef.current = true;
        return;
      }
      fetchingRef.current = true;
      queuedRef.current = false;
      if (showLoading) setLoading(true);
      fetchReport()
        .then((r) => {
          if (!mountedRef.current) return;
          statusRef.current = r?.status;
          setReport(r);
        })
        .catch(() => {
          if (mountedRef.current && showLoading) setReport(null);
        })
        .finally(() => {
          fetchingRef.current = false;
          if (mountedRef.current && showLoading) setLoading(false);
          // A scan finished while we were fetching and we're still waiting —
          // pick up its result now (no fixed-interval polling).
          if (queuedRef.current && statusRef.current === 'pending') {
            runFetch(false);
          }
        });
    },
    [fetchReport],
  );

  // Initial load + reload when the scan target changes.
  useEffect(() => runFetch(true), [runFetch]);

  // A supply-chain scan finished somewhere (SSE `supply_chain` event). If we're
  // still waiting on ours — or our initial load hasn't resolved yet and may
  // have raced the scan — refetch quietly so "Scanning…" resolves on its own.
  const scanTick = useSupplyChainTick();
  useEffect(() => {
    const s = statusRef.current;
    if (s === undefined || s === 'pending') runFetch(false);
    // Only react to scanTick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanTick]);

  const waivedKeys = useMemo(
    () => new Set((report?.waivers ?? []).map((w) => `${w.package}|${w.cve}`)),
    [report],
  );
  const isWaived = (pkg: string, cve: string) => waivedKeys.has(`${pkg}|${cve}`);

  // Active (non-waived) CVEs drive the rollup.
  const counts = useMemo(() => {
    const c: Record<CveSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const p of report?.packages ?? [])
      for (const v of p.cves) if (!isWaived(p.name, v.id)) c[v.severity] += 1;
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, waivedKeys]);
  const totalActive = SEV_ORDER.reduce((a, k) => a + counts[k], 0);

  const sevRank = (s: CveSeverity) => SEV_ORDER.indexOf(s);
  const rows = useMemo(() => {
    const pkgs = [...(report?.packages ?? [])];
    const worst = (p: (typeof pkgs)[number]) =>
      p.cves.reduce((m, v) => Math.min(m, sevRank(v.severity)), 99);
    pkgs.sort((a, b) => worst(a) - worst(b) || b.cves.length - a.cves.length || a.name.localeCompare(b.name));
    return showClean ? pkgs : pkgs.filter((p) => p.cves.length > 0);
  }, [report, showClean]);

  const waive = useCallback(() => {
    if (!dialog || !comment.trim()) return;
    setBusy(true);
    const work = api.addCveWaiver(bp, { copy: copy ?? null, package: dialog.package, cve: dialog.cve, comment: comment.trim() });
    toast.promise(work, {
      loading: 'Recording…',
      success: `${dialog.cve} marked out of scope — logged in bitswan.yaml`,
      error: (e: unknown) => `Failed: ${String(e)}`,
    });
    work.then((r) => { setReport(r); setDialog(null); setComment(''); }).catch(() => {}).finally(() => setBusy(false));
  }, [bp, copy, dialog, comment]);

  const restore = useCallback(
    (pkg: string, cve: string) => {
      const work = api.removeCveWaiver(bp, { copy: copy ?? null, package: pkg, cve });
      toast.promise(work, { loading: 'Restoring…', success: `${cve} restored to in-scope`, error: (e: unknown) => `Failed: ${String(e)}` });
      work.then(setReport).catch(() => {});
    },
    [bp, copy],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 p-6 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading supply chain…
      </div>
    );
  }
  if (!report || report.status === 'not-deployed') {
    return (
      <Notice
        icon={ShieldOff}
        text={emptyHint ?? `Nothing deployed to ${stageLabel} yet — no image to scan.`}
      />
    );
  }
  if (report.status === 'pending') {
    return (
      <Notice
        icon={Loader2}
        spinning
        text="Scanning the image for vulnerabilities… results appear here automatically when it finishes."
      />
    );
  }
  if (report.status === 'unavailable') {
    return <Notice icon={AlertTriangle} text="Vulnerability scan unavailable (syft/grype or the vuln DB couldn't run on this image)." />;
  }

  const waivers = report.waivers ?? [];
  const scannedAt = report.scanned_at ? new Date(report.scanned_at).toLocaleString() : 'unknown';
  const dialogWaiver = dialog
    ? waivers.find((w) => w.package === dialog.package && w.cve === dialog.cve)
    : undefined;

  return (
    <div className="relative flex flex-col gap-3">
      {/* Intro + rollup */}
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-muted-foreground">
          {intro ?? (
            <>
              Packages in the image{report.image_count > 1 ? 's' : ''} deployed to {stageLabel} and
              known vulnerabilities (CVEs) against them.{' '}
              {readOnly
                ? 'Out-of-scope decisions are made from Sync & Deploy → Checks and ship with the code.'
                : 'Click a CVE to view it or mark it out of scope.'}
            </>
          )}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {waivers.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
              <EyeOff className="size-3" aria-hidden /> {waivers.length} out of scope
            </span>
          )}
          {SEV_ORDER.map((k) =>
            counts[k] ? (
              <span key={k} className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', SEV[k].pill)}>
                {counts[k]} {SEV[k].label}
              </span>
            ) : null,
          )}
          {totalActive === 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
              <Check className="size-3" aria-hidden /> No active CVEs
            </span>
          )}
        </div>
      </div>

      {/* Package table */}
      <div className="overflow-hidden rounded-[10px] border border-border bg-background">
        <div className="grid grid-cols-[1fr_120px_1.4fr] gap-3 border-b border-border bg-muted/40 px-3.5 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          <span>Package</span>
          <span>Version</span>
          <span>Vulnerabilities</span>
        </div>
        <div className="max-h-[460px] overflow-auto">
          {rows.map((p) => (
            <div
              key={`${p.name}@${p.version}`}
              className="grid grid-cols-[1fr_120px_1.4fr] items-center gap-3 border-b border-border px-3.5 py-2.5 last:border-b-0"
            >
              <span className="truncate font-mono text-[13px] font-medium text-foreground">{p.name}</span>
              <span className="truncate font-mono text-[12px] text-muted-foreground">{p.version}</span>
              <span className="flex flex-wrap gap-1.5">
                {p.cves.length === 0 ? (
                  <span className="inline-flex items-center gap-1 text-[12px] text-emerald-600">
                    <Check className="size-3" aria-hidden /> Clean
                  </span>
                ) : (
                  p.cves.map((c) => {
                    const waived = isWaived(p.name, c.id);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        title={`${c.id} — view details${waived ? ' (out of scope)' : ''}`}
                        onClick={() => {
                          setDialog({
                            package: p.name,
                            version: p.version,
                            cve: c.id,
                            severity: c.severity,
                          });
                          setComment('');
                        }}
                        className={cn(
                          'inline-flex cursor-pointer items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold',
                          waived ? 'border border-dashed border-border text-muted-foreground line-through' : SEV[c.severity].pill,
                        )}
                      >
                        <span className={cn('size-1.5 rounded-full', waived ? 'bg-muted-foreground' : SEV[c.severity].dot)} />
                        {c.id}
                        {waived && <EyeOff className="size-3" aria-hidden />}
                      </button>
                    );
                  })
                )}
              </span>
            </div>
          ))}
          {rows.length === 0 && (
            <div className="px-3.5 py-6 text-center text-[12px] text-muted-foreground">
              No vulnerable packages. 🎉
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>
          {report.packages.length} packages · {totalActive} in-scope {totalActive === 1 ? 'CVE' : 'CVEs'}
          {waivers.length > 0 && <> · {waivers.length} out of scope</>} · scanned {scannedAt}
        </span>
        <button type="button" onClick={() => setShowClean((v) => !v)} className="text-primary hover:underline">
          {showClean ? 'Hide clean packages' : `Show all ${report.packages.length} packages`}
        </button>
      </div>

      {/* Out-of-scope audit log */}
      {waivers.length > 0 && (
        <div className="overflow-hidden rounded-[10px] border border-border bg-background">
          <div className="flex items-center gap-1.5 border-b border-border bg-muted/40 px-3.5 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <EyeOff className="size-3" aria-hidden /> Out of scope — audit log
          </div>
          {waivers.map((w, i) => (
            <div key={`${w.package}|${w.cve}|${i}`} className="flex items-start gap-2.5 border-b border-border px-3.5 py-2.5 last:border-b-0">
              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] font-semibold text-muted-foreground">{w.cve}</span>
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] leading-snug text-zinc-700">
                  <span className="font-mono text-muted-foreground">{w.package}</span> — {w.comment}
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  Marked out of scope by <strong className="font-semibold text-foreground">{w.by}</strong> · {w.at}
                </div>
              </div>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => restore(w.package, w.cve)}
                  className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-[11px] font-medium text-foreground hover:bg-muted"
                >
                  <Undo2 className="size-3" aria-hidden /> Restore
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Mark-out-of-scope dialog */}
      {dialog && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/45 p-10" onClick={() => setDialog(null)}>
          <div className="w-[520px] max-w-[96%] overflow-hidden rounded-xl border border-border bg-background shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 border-b border-border px-5 py-4">
              <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', SEV[dialog.severity].pill)}>
                <AlertTriangle className="size-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[15px] font-bold text-foreground">{dialog.cve}</div>
                <div className="mt-0.5 font-mono text-[12px] text-muted-foreground">
                  {dialog.package} @ {dialog.version}
                </div>
              </div>
              <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', SEV[dialog.severity].pill)}>
                {SEV[dialog.severity].label}
              </span>
            </div>
            <div className="flex flex-col gap-3 px-5 py-4">
              <div>
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Look up this vulnerability
                </div>
                <div className="flex flex-wrap gap-2">
                  {advisoryLinks(dialog.cve).map((l) => (
                    <a
                      key={l.label}
                      href={l.href}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[12px] font-medium text-foreground hover:bg-muted"
                    >
                      <ExternalLink className="size-3" aria-hidden />
                      {l.label}
                    </a>
                  ))}
                </div>
                <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
                  Affects <span className="font-mono">{dialog.package}</span> at the installed
                  version <span className="font-mono">{dialog.version}</span>. Open an advisory above
                  for the description, CVSS score and the version that fixes it.
                </p>
              </div>

              {dialogWaiver ? (
                <div className="flex flex-col gap-1 rounded-md border border-dashed border-border bg-muted/40 px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-[12px] font-semibold text-muted-foreground">
                    <EyeOff className="size-3.5" aria-hidden /> Marked out of scope
                  </div>
                  <div className="text-[12.5px] leading-snug text-zinc-700">{dialogWaiver.comment}</div>
                  <div className="text-[11px] text-muted-foreground">
                    by <strong className="font-semibold text-foreground">{dialogWaiver.by}</strong> · {dialogWaiver.at}
                  </div>
                </div>
              ) : !readOnly ? (
                <div className="flex flex-col gap-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Mark out of scope
                  </div>
                  <p className="text-[12px] leading-relaxed text-muted-foreground">
                    Excludes this CVE from the risk rollup. The decision is saved in the source tree
                    (<code>cve-waivers.yaml</code>) with your justification and name, and ships to all
                    stages on Sync &amp; Deploy.
                  </p>
                  <textarea
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    rows={3}
                    placeholder="Why is this not exploitable here? e.g. the vulnerable code path is never reached…"
                    className="w-full resize-y rounded-md border border-border px-3 py-2 text-[13px] leading-relaxed outline-none focus:border-primary"
                  />
                </div>
              ) : null}
            </div>
            <div className="flex justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3">
              <button type="button" onClick={() => setDialog(null)} className="inline-flex h-8 items-center rounded-md px-3 text-[13px] font-medium text-muted-foreground hover:text-foreground">
                Close
              </button>
              {dialogWaiver
                ? !readOnly && (
                    <button
                      type="button"
                      onClick={() => { restore(dialog.package, dialog.cve); setDialog(null); }}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3.5 text-[13px] font-semibold text-foreground hover:bg-muted"
                    >
                      <Undo2 className="size-3.5" aria-hidden /> Restore to in-scope
                    </button>
                  )
                : !readOnly && (
                    <button
                      type="button"
                      disabled={!comment.trim() || busy}
                      onClick={waive}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md bg-foreground px-3.5 text-[13px] font-semibold text-background hover:bg-foreground/90 disabled:opacity-40"
                    >
                      {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <EyeOff className="size-3.5" aria-hidden />}
                      Mark out of scope
                    </button>
                  )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Notice({
  icon: Icon,
  text,
  spinning = false,
}: {
  icon: typeof ShieldOff;
  text: string;
  spinning?: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-3 py-12 text-center">
      <Icon
        className={cn('size-7 text-muted-foreground', spinning && 'animate-spin')}
        aria-hidden
      />
      <div className="max-w-md text-[13px] text-muted-foreground">{text}</div>
    </div>
  );
}

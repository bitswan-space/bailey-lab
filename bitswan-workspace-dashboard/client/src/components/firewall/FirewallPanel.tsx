import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUpFromLine,
  Ban,
  Check,
  Download,
  FileText,
  Loader2,
  Lock,
  ShieldAlert,
  ShieldCheck,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import { toast } from '@/lib/notify';
import { api, type FirewallReport, type FirewallRule, type GdprRecord } from '@/lib/api';
import { cn } from '@/lib/utils';

const REALM_LABEL: Record<string, string> = {
  dev: 'Development',
  staging: 'Staging',
  production: 'Production',
};

const EMPTY_RECORD: GdprRecord = { noUserData: false, stored: 'no' };

// Re-poll the firewall feed this often so egress observed AFTER the panel
// mounts (the gateway logs it asynchronously) appears under "Needs review"
// without the operator having to take an action to force a refetch.
const FIREWALL_POLL_MS = 4000;

/**
 * Egress firewall panel (wireframe Firewall tab). Shows the outbound allow-list
 * for a BP stage: blocked/observed hosts that "need review" (approve/deny),
 * hosts ready to promote from the previous stage, allowed hosts (revoke), and
 * denied hosts (re-approve). Approving a host opens the GDPR data-processing
 * form (what data leaves, why, where it's stored, jurisdiction, signed DPA PDF);
 * the record is versioned in bitswan.yaml and viewable later. Rules + records
 * appear in the deployment history (audit log). Posture is monitor in dev and
 * enforce in staging/production. Production changes require admin/auditor.
 */
export function FirewallPanel({
  bp,
  stage,
  stageLabel,
  prevStage,
  readOnly = false,
  onChange,
}: {
  bp: string;
  stage: string;
  stageLabel: string;
  /** the realm to pull rules forward FROM (e.g. staging←dev, production←staging) */
  prevStage?: string;
  readOnly?: boolean;
  /** called after a rule change so the parent can refresh the deployment-history
   *  audit log (each firewall change is a new versioned entry there). */
  onChange?: () => void;
}) {
  const [fw, setFw] = useState<FirewallReport | null>(null);
  // The previous stage's rules — the source for the "Ready to promote" section.
  const [prevFw, setPrevFw] = useState<FirewallReport | null>(null);
  const [role, setRole] = useState<string>('member');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  // The GDPR form: `approve` opens it editable — mode 'approve' when allowing a
  // blocked/denied host, mode 'edit' to view/fill/update an allowed host's
  // record. `view` opens it read-only (for viewers who can't edit).
  const [approve, setApprove] = useState<{
    host: string;
    record?: GdprRecord;
    mode: 'approve' | 'edit';
  } | null>(null);
  const [view, setView] = useState<{ host: string; record: GdprRecord } | null>(null);

  // Observed egress is logged asynchronously by the per-BP gateway AFTER the BP
  // makes an outbound call — which can land seconds after this panel mounts (and
  // long after the operator opened the Firewall tab). A one-shot on-mount fetch
  // would therefore show an empty "Needs review" list forever, so the operator
  // never sees the Approve button. Poll the read endpoint (and refetch on tab
  // focus) so freshly observed hosts surface without a manual action — the same
  // pattern the agent-sessions / copy-status feeds use. Refetches are SILENT
  // (no loading spinner flash): only the very first fetch toggles `loading`.
  const aliveRef = useRef(true);
  const fetchNow = useCallback(
    (initial: boolean) => {
      if (initial) setLoading(true);
      api
        .firewall(bp, stage)
        .then((r) => aliveRef.current && setFw(r))
        .catch(() => aliveRef.current && initial && setFw(null))
        .finally(() => initial && aliveRef.current && setLoading(false));
      if (prevStage) {
        api
          .firewall(bp, prevStage)
          .then((r) => aliveRef.current && setPrevFw(r))
          .catch(() => aliveRef.current && initial && setPrevFw(null));
      } else if (initial) {
        setPrevFw(null);
      }
      if (initial) {
        api.getMe().then((m) => aliveRef.current && setRole(m.role || 'member')).catch(() => {});
      }
    },
    [bp, stage, prevStage],
  );
  useEffect(() => {
    aliveRef.current = true;
    fetchNow(true);
    const id = window.setInterval(() => fetchNow(false), FIREWALL_POLL_MS);
    const onFocus = () => fetchNow(false);
    window.addEventListener('focus', onFocus);
    return () => {
      aliveRef.current = false;
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [fetchNow]);

  // Production changes need admin/auditor; dev/staging are open. DR is read-only.
  const isProd = fw?.stage === 'production';
  const canEdit = !readOnly && (!isProd || role === 'admin' || role === 'auditor');

  const run = useCallback(
    (key: string, p: Promise<FirewallReport>, msg: string) => {
      setBusy(key);
      toast.promise(p, { loading: '…', success: msg, error: (e: unknown) => `Failed: ${String(e)}` });
      p.then((r) => {
        setFw(r);
        // Each rule change is a new versioned commit → refresh the audit log.
        onChange?.();
      })
        .catch(() => {})
        .finally(() => setBusy(null));
    },
    [onChange],
  );

  const setRule = (host: string, status: 'allowed' | 'denied') =>
    run(host, api.setFirewallRule(bp, { stage, host, status }),
      status === 'allowed' ? `Allowed ${host}` : `Denied ${host}`);
  const removeRule = (host: string) =>
    run(host, api.deleteFirewallRule(bp, { stage, host }), `Removed ${host}`);

  // Accept a host promoted from the previous stage — carry its purpose + GDPR
  // record (and DPA, which is keyed on the host) forward unchanged.
  const acceptPromote = (r: FirewallRule) =>
    run(
      r.host,
      api.setFirewallRule(bp, {
        stage,
        host: r.host,
        status: 'allowed',
        ...(r.purpose ? { purpose: r.purpose } : {}),
        ...(r.gdpr ? { gdpr: r.gdpr } : {}),
      }),
      `Accepted ${r.host}`,
    );

  // Approve via the GDPR form: upload the DPA PDF first (if one was attached),
  // then allow the host with the data-processing record.
  const saveApproval = useCallback(
    async (host: string, record: GdprRecord, file: File | null) => {
      setBusy(host);
      const work = (async () => {
        if (file) await api.uploadFirewallDpa(bp, { stage, host, file });
        return api.setFirewallRule(bp, {
          stage,
          host,
          status: 'allowed',
          ...(record.purpose ? { purpose: record.purpose } : {}),
          gdpr: record,
        });
      })();
      toast.promise(work, {
        loading: `Saving ${host}…`,
        success: `Saved data-processing record for ${host}`,
        error: (e: unknown) => `Failed: ${String(e)}`,
      });
      try {
        setFw(await work);
        onChange?.();
        setApprove(null);
      } catch {
        /* toast handled */
      } finally {
        setBusy(null);
      }
    },
    [bp, stage, onChange],
  );

  if (loading || !fw) {
    return (
      <div className="flex items-center justify-center gap-2 p-6 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading firewall…
      </div>
    );
  }

  const allowed = fw.rules.filter((r) => r.status === 'allowed');
  const denied = fw.rules.filter((r) => r.status === 'denied');

  // "Ready to promote from {prev}": hosts approved in the previous stage that
  // have no decision yet here. Accepting one carries its record forward and
  // records the approval in this stage's audit log.
  const decided = new Set(fw.rules.map((r) => r.host));
  const prevLabel = prevStage ? (REALM_LABEL[prevStage] ?? prevStage) : '';
  const promotable = (prevFw?.rules ?? []).filter(
    (r) => r.status === 'allowed' && !decided.has(r.host),
  );

  // Editors can always open a host's data-processing record — to view it, fill
  // it in for the first time, or update it (+ its DPA). Viewers see the button
  // only when a record already exists, opened read-only.
  const recordBtn = (r: FirewallRule) =>
    canEdit ? (
      <Btn
        onClick={() => setApprove({ host: r.host, record: r.gdpr ?? undefined, mode: 'edit' })}
        kind="record"
      >
        Data record
      </Btn>
    ) : r.gdpr ? (
      <Btn onClick={() => setView({ host: r.host, record: r.gdpr! })} kind="record">
        Data record
      </Btn>
    ) : null;

  return (
    <div className="relative flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-muted-foreground">
          {stageLabel} can only reach the external hosts on this allow-list. Any other outbound
          connection is{' '}
          {fw.posture === 'enforce' ? 'blocked and logged' : 'allowed but logged (monitor mode)'}{' '}
          here for you to approve or deny.
        </p>
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold',
            fw.posture === 'enforce' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700',
          )}
        >
          {fw.posture === 'enforce' ? <ShieldCheck className="size-3.5" /> : <ShieldAlert className="size-3.5" />}
          {fw.posture === 'enforce' ? 'Enforcing' : 'Monitoring'}
        </span>
      </div>

      {!canEdit && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          <Lock className="size-3.5 shrink-0" aria-hidden />
          {readOnly
            ? 'Mirrored from Production — read-only.'
            : 'Production firewall changes require an admin or auditor role. View-only.'}
        </div>
      )}

      {/* Needs review */}
      {fw.attempts.length > 0 && (
        <Section title="Needs review" badge={fw.attempts.length} danger>
          {fw.attempts.map((a) => (
            <Row key={a.host} host={a.host} sub={`${a.count} attempt${a.count === 1 ? '' : 's'} · last ${fmt(a.last)}`} blocked>
              {canEdit && (
                <>
                  <Btn onClick={() => setApprove({ host: a.host, mode: 'approve' })} kind="approve">Approve</Btn>
                  <Btn onClick={() => setRule(a.host, 'denied')} kind="deny" busy={busy === a.host}>Deny</Btn>
                </>
              )}
            </Row>
          ))}
        </Section>
      )}

      {/* Ready to promote from the previous stage */}
      {canEdit && promotable.length > 0 && (
        <Section title={`Ready to promote from ${prevLabel}`} badge={promotable.length} accent>
          {promotable.map((r) => (
            <Row
              key={r.host}
              host={r.host}
              sub={`Approved in ${prevLabel}${r.purpose ? ` · ${r.purpose}` : ''}`}
              promote
            >
              {recordBtn(r)}
              <Btn onClick={() => acceptPromote(r)} kind="approve" busy={busy === r.host}>
                Accept for {stageLabel}
              </Btn>
              {!isProd && (
                <Btn onClick={() => setRule(r.host, 'denied')} kind="deny">
                  Deny
                </Btn>
              )}
            </Row>
          ))}
        </Section>
      )}

      <Section title="Allowed">
        {allowed.length === 0 && <Empty>No hosts allowed yet.</Empty>}
        {allowed.map((r) => (
          <Row key={r.host} host={r.host} sub={r.purpose ? `${r.purpose} · by ${r.by} · ${r.at}` : `by ${r.by} · ${r.at}`}>
            {recordBtn(r)}
            {canEdit && <Btn onClick={() => removeRule(r.host)} kind="deny" busy={busy === r.host}>Revoke</Btn>}
          </Row>
        ))}
      </Section>

      {denied.length > 0 && (
        <Section title="Denied">
          {denied.map((r) => (
            <Row key={r.host} host={r.host} sub={`denied by ${r.by} · ${r.at}`} blocked>
              {recordBtn(r)}
              {canEdit && (
                <>
                  <Btn onClick={() => setApprove({ host: r.host, record: r.gdpr ?? undefined, mode: 'approve' })} kind="approve" busy={busy === r.host}>Approve</Btn>
                  <Btn onClick={() => removeRule(r.host)} kind="plain">Remove</Btn>
                </>
              )}
            </Row>
          ))}
        </Section>
      )}

      <div className="text-[11px] text-muted-foreground">
        {allowed.length} allowed · {denied.length} denied · {fw.attempts.length} need review · every
        change is versioned in bitswan.yaml and appears in the deployment history (audit log &amp;
        rollback).
      </div>

      {/* GDPR data-processing form — editable on approval */}
      {approve && (
        <GdprModal
          bp={bp}
          host={approve.host}
          stageLabel={stageLabel}
          initial={approve.record}
          mode={approve.mode}
          busy={busy === approve.host}
          onClose={() => setApprove(null)}
          onSave={(record, file) => void saveApproval(approve.host, record, file)}
        />
      )}

      {/* GDPR data-processing record — read-only viewer */}
      {view && (
        <GdprModal
          bp={bp}
          host={view.host}
          stageLabel={stageLabel}
          initial={view.record}
          readOnly
          onClose={() => setView(null)}
        />
      )}
    </div>
  );
}

function fmt(s: string | null) {
  if (!s) return 'unknown';
  try {
    return new Date(s).toLocaleString();
  } catch {
    return s;
  }
}

// GDPR data-processing record form / viewer for a 3rd-party host (wireframe
// FirewallGdprModal). Editable when approving; read-only when inspecting.
function GdprModal({
  bp,
  host,
  stageLabel,
  initial,
  mode = 'approve',
  readOnly = false,
  busy = false,
  onClose,
  onSave,
}: {
  bp: string;
  host: string;
  stageLabel: string;
  initial?: GdprRecord;
  mode?: 'approve' | 'edit';
  readOnly?: boolean;
  busy?: boolean;
  onClose: () => void;
  onSave?: (record: GdprRecord, file: File | null) => void;
}) {
  const [rec, setRec] = useState<GdprRecord>(initial ?? EMPTY_RECORD);
  const [file, setFile] = useState<File | null>(null);
  const set = <K extends keyof GdprRecord>(k: K, v: GdprRecord[K]) =>
    setRec((s) => ({ ...s, [k]: v }));
  const ro = readOnly;
  const title = ro || mode === 'edit' ? 'Data-processing record' : 'Approve 3rd-party access';
  const submitLabel = mode === 'edit' ? 'Save record' : 'Approve & record';
  const storedLabel =
    rec.stored === 'yes' ? 'Yes — stored' : rec.stored === 'transient' ? 'Transient only' : 'No';

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/45 p-8"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-[600px] max-w-[96vw] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <span className="flex size-8 items-center justify-center rounded-lg bg-muted">
            <ShieldCheck className="size-4 text-foreground" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-bold text-foreground">{title}</div>
            <div className="mt-0.5 truncate font-mono text-[12px] text-muted-foreground">{host}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
            aria-label="Close"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-5 py-4">
          {!ro && (
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              {mode === 'edit'
                ? 'GDPR requires documenting what data leaves the system and how the processor handles it. Changes are recorded in the audit log against your name.'
                : `${stageLabel} will be permitted to reach this host. GDPR requires documenting what data leaves the system and how the processor handles it — recorded in the audit log against your name.`}
            </p>
          )}

          <label
            className={cn(
              'flex items-center gap-3 rounded-lg border px-3 py-2.5',
              rec.noUserData ? 'border-emerald-300 bg-emerald-50' : 'border-border bg-background',
              ro ? 'cursor-default' : 'cursor-pointer',
            )}
          >
            <input
              type="checkbox"
              checked={!!rec.noUserData}
              disabled={ro}
              onChange={(e) => set('noUserData', e.target.checked)}
            />
            <span>
              <span className="block text-[13px] font-semibold text-foreground">
                No user data is sent to this service
              </span>
              <span className="block text-[11px] text-muted-foreground">
                Tick if only non-personal/operational data leaves the system.
              </span>
            </span>
          </label>

          {!rec.noUserData && (
            <>
              <Field label="1 · What data is sent to the 3rd party">
                <textarea
                  rows={2}
                  readOnly={ro}
                  value={rec.dataSent ?? ''}
                  onChange={(e) => set('dataSent', e.target.value)}
                  placeholder="e.g. employee email, error stack traces"
                  className={inputCls(ro)}
                />
              </Field>
              <Field label="2 · What is the data used for">
                <textarea
                  rows={2}
                  readOnly={ro}
                  value={rec.purpose ?? ''}
                  onChange={(e) => set('purpose', e.target.value)}
                  placeholder="e.g. crash diagnostics & alerting"
                  className={inputCls(ro)}
                />
              </Field>
              <Field label="3 · Is the data stored there?">
                {ro ? (
                  <div className={inputCls(true)}>{storedLabel}</div>
                ) : (
                  <div className="flex gap-1.5">
                    {(
                      [
                        ['no', 'No'],
                        ['transient', 'Transient'],
                        ['yes', 'Yes'],
                      ] as const
                    ).map(([v, l]) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => set('stored', v)}
                        className={cn(
                          'h-9 flex-1 rounded-md border text-[12px] font-semibold',
                          rec.stored === v
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border bg-background text-foreground hover:bg-muted',
                        )}
                      >
                        {l}
                      </button>
                    ))}
                  </div>
                )}
              </Field>
              <Field label="4 · Jurisdiction of the data processor">
                <input
                  readOnly={ro}
                  value={rec.jurisdiction ?? ''}
                  onChange={(e) => set('jurisdiction', e.target.value)}
                  placeholder="e.g. EU (Ireland) · USA (DPF certified)"
                  className={inputCls(ro)}
                />
              </Field>
              <Field label="5 · Data processing agreement (PDF)">
                {ro ? (
                  rec.dpaFile ? (
                    <a
                      href={api.firewallDpaUrl(bp, host)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-[13px] text-primary hover:bg-muted"
                    >
                      <Download className="size-3.5" aria-hidden />
                      {rec.dpaFile}
                    </a>
                  ) : (
                    <div className={cn(inputCls(true), 'flex items-center gap-2 text-muted-foreground')}>
                      <FileText className="size-3.5" aria-hidden /> None attached
                    </div>
                  )
                ) : (
                  <label className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-input px-3 py-2.5 text-[13px] text-muted-foreground hover:bg-muted">
                    <Upload className="size-3.5" aria-hidden />
                    {file?.name ?? rec.dpaFile ?? 'Upload DPA PDF'}
                    <input
                      type="file"
                      accept="application/pdf"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0] ?? null;
                        setFile(f);
                        if (f) set('dpaFile', f.name);
                      }}
                    />
                  </label>
                )}
              </Field>
            </>
          )}
        </div>

        {!ro && (
          <div className="flex justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 items-center rounded-md px-3 text-[13px] font-medium text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onSave?.(rec, file)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-emerald-600 px-3.5 text-[13px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" aria-hidden />}
              {submitLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function inputCls(ro: boolean) {
  return cn(
    'w-full resize-y rounded-md border border-border px-3 py-2 text-[13px] outline-none focus:border-primary',
    ro ? 'bg-muted/40 text-foreground' : 'bg-background',
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[12px] font-semibold text-foreground">{label}</label>
      {children}
    </div>
  );
}

function Section({
  title,
  badge,
  danger,
  accent,
  children,
}: {
  title: string;
  badge?: number;
  danger?: boolean;
  accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'text-[11px] font-semibold uppercase tracking-wide',
            danger ? 'text-red-700' : accent ? 'text-blue-700' : 'text-muted-foreground',
          )}
        >
          {title}
        </span>
        {typeof badge === 'number' && badge > 0 && (
          <span
            className={cn(
              'rounded-full px-1.5 text-[10px] font-bold text-white',
              accent ? 'bg-blue-600' : 'bg-red-600',
            )}
          >
            {badge}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

function Row({
  host,
  sub,
  blocked,
  promote,
  children,
}: {
  host: string;
  sub: string;
  blocked?: boolean;
  promote?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 rounded-[10px] border border-border bg-background px-3.5 py-2.5">
      <span
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-md',
          promote ? 'bg-blue-50' : blocked ? 'bg-red-50' : 'bg-emerald-50',
        )}
      >
        {promote ? (
          <ArrowUpFromLine className="size-4 text-blue-600" aria-hidden />
        ) : blocked ? (
          <ShieldAlert className="size-4 text-red-600" aria-hidden />
        ) : (
          <ShieldCheck className="size-4 text-emerald-600" aria-hidden />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[13px] font-medium text-foreground">{host}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{sub}</span>
      </span>
      {children && <div className="flex items-center gap-1.5">{children}</div>}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-dashed border-border py-4 text-center text-[12px] text-muted-foreground">{children}</div>;
}

function Btn({
  onClick,
  kind,
  busy,
  children,
}: {
  onClick: () => void;
  kind: 'approve' | 'deny' | 'plain' | 'record';
  busy?: boolean;
  children: React.ReactNode;
}) {
  const cls =
    kind === 'approve'
      ? 'border-emerald-300 text-emerald-700 hover:bg-emerald-50'
      : kind === 'deny'
        ? 'border-red-300 text-red-700 hover:bg-red-50'
        : 'border-border text-muted-foreground hover:bg-muted';
  return (
    <button type="button" disabled={busy} onClick={onClick} className={cn('inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2.5 text-[11px] font-medium disabled:opacity-50', cls)}>
      {busy ? (
        <Loader2 className="size-3 animate-spin" />
      ) : kind === 'approve' ? (
        <Check className="size-3" />
      ) : kind === 'deny' ? (
        <Ban className="size-3" />
      ) : kind === 'record' ? (
        <FileText className="size-3" />
      ) : (
        <Undo2 className="size-3" />
      )}
      {children}
    </button>
  );
}

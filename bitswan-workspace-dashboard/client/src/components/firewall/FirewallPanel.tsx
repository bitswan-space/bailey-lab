import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Ban, Check, Loader2, Lock, ShieldAlert, ShieldCheck, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, type FirewallReport } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Egress firewall panel (wireframe Firewall tab). Shows the outbound allow-list
 * for a BP stage: blocked/observed hosts that "need review" (approve/deny),
 * allowed hosts (revoke), and denied hosts (re-approve). Rules are versioned in
 * bitswan.yaml (the audit log — each row shows who/when). Posture is monitor in
 * dev (logs only) and enforce in staging/production (default-deny). Production
 * changes require an admin/auditor role; otherwise the controls are read-only.
 */
export function FirewallPanel({
  bp,
  stage,
  stageLabel,
  prevStage,
  readOnly = false,
}: {
  bp: string;
  stage: string;
  stageLabel: string;
  /** the realm to pull rules forward FROM (e.g. staging←dev, production←staging) */
  prevStage?: string;
  readOnly?: boolean;
}) {
  const [fw, setFw] = useState<FirewallReport | null>(null);
  const [role, setRole] = useState<string>('member');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [approve, setApprove] = useState<{ host: string } | null>(null);
  const [purpose, setPurpose] = useState('');

  const load = useCallback(() => {
    let alive = true;
    setLoading(true);
    api
      .firewall(bp, stage)
      .then((r) => alive && setFw(r))
      .catch(() => alive && setFw(null))
      .finally(() => alive && setLoading(false));
    api.getMe().then((m) => alive && setRole(m.role || 'member')).catch(() => {});
    return () => {
      alive = false;
    };
  }, [bp, stage]);
  useEffect(() => load(), [load]);

  // Production changes need admin/auditor; dev/staging are open. DR is read-only.
  const isProd = fw?.stage === 'production';
  const canEdit = !readOnly && (!isProd || role === 'admin' || role === 'auditor');

  const run = useCallback(
    (key: string, p: Promise<FirewallReport>, msg: string) => {
      setBusy(key);
      toast.promise(p, { loading: '…', success: msg, error: (e: unknown) => `Failed: ${String(e)}` });
      p.then(setFw).catch(() => {}).finally(() => setBusy(null));
    },
    [],
  );

  const setRule = (host: string, status: 'allowed' | 'denied', purposeText = '') =>
    run(host, api.setFirewallRule(bp, { stage, host, status, ...(purposeText ? { purpose: purposeText } : {}) }),
      status === 'allowed' ? `Allowed ${host}` : `Denied ${host}`);
  const removeRule = (host: string) =>
    run(host, api.deleteFirewallRule(bp, { stage, host }), `Removed ${host}`);

  if (loading || !fw) {
    return (
      <div className="flex items-center justify-center gap-2 p-6 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading firewall…
      </div>
    );
  }

  const allowed = fw.rules.filter((r) => r.status === 'allowed');
  const denied = fw.rules.filter((r) => r.status === 'denied');

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
                  <Btn onClick={() => { setApprove({ host: a.host }); setPurpose(''); }} kind="approve">Approve</Btn>
                  <Btn onClick={() => setRule(a.host, 'denied')} kind="deny" busy={busy === a.host}>Deny</Btn>
                </>
              )}
            </Row>
          ))}
        </Section>
      )}

      <Section title="Allowed">
        {allowed.length === 0 && <Empty>No hosts allowed yet.</Empty>}
        {allowed.map((r) => (
          <Row key={r.host} host={r.host} sub={r.purpose ? `${r.purpose} · by ${r.by} · ${r.at}` : `by ${r.by} · ${r.at}`}>
            {canEdit && <Btn onClick={() => removeRule(r.host)} kind="deny" busy={busy === r.host}>Revoke</Btn>}
          </Row>
        ))}
      </Section>

      {denied.length > 0 && (
        <Section title="Denied">
          {denied.map((r) => (
            <Row key={r.host} host={r.host} sub={`denied by ${r.by} · ${r.at}`} blocked>
              {canEdit && (
                <>
                  <Btn onClick={() => setRule(r.host, 'allowed')} kind="approve" busy={busy === r.host}>Approve</Btn>
                  <Btn onClick={() => removeRule(r.host)} kind="plain">Remove</Btn>
                </>
              )}
            </Row>
          ))}
        </Section>
      )}

      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>
          {allowed.length} allowed · {denied.length} denied · {fw.attempts.length} need review · changes
          are versioned in bitswan.yaml (audit log)
        </span>
        {canEdit && prevStage && (
          <button
            type="button"
            disabled={busy === '__promote'}
            onClick={() =>
              run('__promote', api.promoteFirewall(bp, { from_stage: prevStage, to_stage: stage }),
                `Pulled rules forward from ${prevStage}`)
            }
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            <ArrowRight className="size-3" aria-hidden /> Pull rules forward from {prevStage}
          </button>
        )}
      </div>

      {/* Approve dialog (captures a purpose for the audit log) */}
      {approve && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/45 p-10" onClick={() => setApprove(null)}>
          <div className="w-[460px] max-w-[96%] overflow-hidden rounded-xl border border-border bg-background shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 border-b border-border px-5 py-4">
              <span className="flex size-8 items-center justify-center rounded-lg bg-emerald-100">
                <ShieldCheck className="size-4 text-emerald-700" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-bold text-foreground">Allow outbound host</div>
                <div className="mt-0.5 font-mono text-[12px] text-muted-foreground">{approve.host}</div>
              </div>
            </div>
            <div className="flex flex-col gap-2.5 px-5 py-4">
              <p className="text-[13px] leading-relaxed text-zinc-600">
                {stageLabel} will be permitted to reach <span className="font-mono">{approve.host}</span>.
                Recorded in the audit log against your name. Note what data leaves the system / why
                (recommended for GDPR records).
              </p>
              <textarea
                autoFocus
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                rows={3}
                placeholder="Purpose — e.g. error reporting (Sentry); sends stack traces + user email…"
                className="w-full resize-y rounded-md border border-border px-3 py-2 text-[13px] outline-none focus:border-primary"
              />
            </div>
            <div className="flex justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3">
              <button type="button" onClick={() => setApprove(null)} className="inline-flex h-8 items-center rounded-md px-3 text-[13px] font-medium text-muted-foreground hover:text-foreground">Cancel</button>
              <button
                type="button"
                onClick={() => { setRule(approve.host, 'allowed', purpose.trim()); setApprove(null); }}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-emerald-600 px-3.5 text-[13px] font-semibold text-white hover:bg-emerald-700"
              >
                <Check className="size-3.5" aria-hidden /> Allow
              </button>
            </div>
          </div>
        </div>
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

function Section({ title, badge, danger, children }: { title: string; badge?: number; danger?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className={cn('text-[11px] font-semibold uppercase tracking-wide', danger ? 'text-red-700' : 'text-muted-foreground')}>{title}</span>
        {typeof badge === 'number' && badge > 0 && (
          <span className="rounded-full bg-red-600 px-1.5 text-[10px] font-bold text-white">{badge}</span>
        )}
      </div>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

function Row({ host, sub, blocked, children }: { host: string; sub: string; blocked?: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-[10px] border border-border bg-background px-3.5 py-2.5">
      <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-md', blocked ? 'bg-red-50' : 'bg-emerald-50')}>
        {blocked ? <ShieldAlert className="size-4 text-red-600" aria-hidden /> : <ShieldCheck className="size-4 text-emerald-600" aria-hidden />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[13px] font-medium text-foreground">{host}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{sub}</span>
      </span>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-dashed border-border py-4 text-center text-[12px] text-muted-foreground">{children}</div>;
}

function Btn({ onClick, kind, busy, children }: { onClick: () => void; kind: 'approve' | 'deny' | 'plain'; busy?: boolean; children: React.ReactNode }) {
  const cls =
    kind === 'approve'
      ? 'border-emerald-300 text-emerald-700 hover:bg-emerald-50'
      : kind === 'deny'
        ? 'border-red-300 text-red-700 hover:bg-red-50'
        : 'border-border text-muted-foreground hover:bg-muted';
  return (
    <button type="button" disabled={busy} onClick={onClick} className={cn('inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2.5 text-[11px] font-medium disabled:opacity-50', cls)}>
      {busy ? <Loader2 className="size-3 animate-spin" /> : kind === 'approve' ? <Check className="size-3" /> : kind === 'deny' ? <Ban className="size-3" /> : <Undo2 className="size-3" />}
      {children}
    </button>
  );
}

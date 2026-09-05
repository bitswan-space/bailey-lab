import { useEffect, useState } from 'react';
import {
  Check,
  FileText,
  Gavel,
  Lock,
  Minus,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Snowflake,
  User,
  X,
} from 'lucide-react';
import { api, type StagingGate } from '@/lib/api';
import { toast } from '@/lib/notify';
import { AuditWorkspace } from './AuditWorkspace';
import { formatRelative } from '@/lib/format-date';
import { cn } from '@/lib/utils';
import { RelativeTime } from '@/components/shared/RelativeTime';
import type { StagingLogEntry, StagingSignoff } from '@/lib/api';

/** Whether a role may freeze staging, edit the audit policy, and sign off. */
export function isAuditor(role: string | null): boolean {
  return role === 'admin' || role === 'auditor';
}

/**
 * The audit record of a frozen staging image: its policy, every verdict given
 * on it with the report that argued for it, and the door into an audit copy.
 * The verdict itself is given in that copy, on its Audit report tab, so that
 * signing off and the report being signed off are one action.
 */
export function AuditSignOff({
  bp,
  gate,
  role,
  meEmail,
  onChange,
  onEnterCopy,
}: {
  bp: string;
  // eslint-disable-next-line no-restricted-syntax -- null = not loaded yet
  gate: StagingGate | null;
  // eslint-disable-next-line no-restricted-syntax -- null = unknown role
  role: string | null;
  meEmail: string;
  onChange: () => void;
  onEnterCopy: (name: string, label: string) => void;
}) {
  const canAudit = isAuditor(role);
  const roleKnown = role !== null;
  const [busy, setBusy] = useState(false);
  const [editPolicy, setEditPolicy] = useState(false);
  const [draft, setDraft] = useState(gate?.required ?? 1);
  // The workspace's auditor/admin roster — shown to a member so they know who to
  // ask. null = loading; [] with error flag = load failed (honest, not faked).
  // eslint-disable-next-line no-restricted-syntax -- null = loading
  const [auditors, setAuditors] = useState<{ email: string; role: string }[] | null>(null);
  const [auditorsError, setAuditorsError] = useState(false);
  useEffect(() => {
    setDraft(gate?.required ?? 1);
  }, [gate?.required]);
  useEffect(() => {
    // Only a non-auditor needs the "ask one of these people" list.
    if (!roleKnown || canAudit) return;
    let alive = true;
    api
      .workspaceAuditors()
      .then((r) => {
        if (alive) setAuditors(r.users ?? []);
      })
      .catch(() => {
        if (alive) {
          setAuditors([]);
          setAuditorsError(true);
        }
      });
    return () => {
      alive = false;
    };
  }, [roleKnown, canAudit]);

  if (!gate) {
    return (
      <div className="px-3 py-12 text-center text-[13px] text-muted-foreground">Loading…</div>
    );
  }

  const savePolicy = async () => {
    setBusy(true);
    const work = api.setAuditPolicy(bp, draft);
    toast.promise(work, {
      loading: 'Saving audit policy…',
      success: 'Audit policy saved',
      error: (e: unknown) => `Save failed: ${String(e)}`,
    });
    try {
      await work;
      setEditPolicy(false);
      onChange();
    } catch {
      /* toast handled */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 px-1 py-1">
      {/* Policy + freeze status + sign-off are auditor/admin surface. A member
          sees only the audit log plus the "ask an auditor" coverage below. */}
      {canAudit ? (
      <>
      {/* Audit policy */}
      <div className="rounded-lg border border-border bg-muted/30 px-3.5 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            {gate.audits_met && gate.rejections === 0 ? (
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
            ) : (
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
            )}
            <div className="text-[13px] text-foreground">
              <strong>Audit policy:</strong> this image must be signed off by {gate.required}{' '}
              auditor{gate.required === 1 ? '' : 's'} before Staging can be promoted to Production.{' '}
              <strong>{gate.approvals}</strong> of {gate.required} complete.
            </div>
          </div>
          {!editPolicy ? (
            <button
              type="button"
              onClick={() => setEditPolicy(true)}
              className="shrink-0 rounded-md border border-border bg-background px-2 py-1 text-[11px] font-semibold text-muted-foreground hover:text-foreground"
            >
              Edit policy
            </button>
          ) : null}
        </div>
        {editPolicy ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-[12px] font-semibold text-foreground">Audits required</span>
            <div className="inline-flex items-center gap-1">
              <button
                type="button"
                aria-label="decrease"
                onClick={() => setDraft((n) => Math.max(1, n - 1))}
                className="inline-flex size-6 items-center justify-center rounded-md border border-border bg-background hover:bg-muted"
              >
                <Minus className="size-3" aria-hidden />
              </button>
              <span className="w-6 text-center text-[13px] font-semibold text-foreground">
                {draft}
              </span>
              <button
                type="button"
                aria-label="increase"
                onClick={() => setDraft((n) => Math.min(5, n + 1))}
                className="inline-flex size-6 items-center justify-center rounded-md border border-border bg-background hover:bg-muted"
              >
                <Plus className="size-3" aria-hidden />
              </button>
            </div>
            <span className="text-[11px] text-muted-foreground">at least 1 · up to 5</span>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setEditPolicy(false);
                  setDraft(gate.required);
                }}
                className="rounded-md border border-border bg-background px-2.5 py-1 text-[12px] font-semibold text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void savePolicy()}
                className="rounded-md border border-primary bg-primary px-2.5 py-1 text-[12px] font-semibold text-primary-foreground hover:bg-primary/90"
              >
                Save policy
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/* Freeze status */}
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        {gate.frozen ? (
          <>
            <Snowflake className="size-3.5 text-sky-600" aria-hidden />
            <span>
              Staging is <strong className="text-foreground">frozen</strong>
              {gate.frozen_by ? ` by ${gate.frozen_by}` : ''}
              {gate.frozen_at ? ` · ${formatRelative(gate.frozen_at)}` : ''}. Audits below apply to the frozen
              image
              {gate.frozen_sha ? ` (${gate.frozen_sha.slice(0, 12)})` : ''}.
            </span>
          </>
        ) : (
          <>
            <Snowflake className="size-3.5" aria-hidden />
            <span>
              Staging is not frozen. Freeze it (on the Staging node) to lock the image and collect
              audits before promoting to Production.
            </span>
          </>
        )}
      </div>
      </>
      ) : null}

      {/* The way in. An audit is done in a copy of the audited version, so the
          only thing needed here is the door to it. */}
      {gate.frozen && canAudit ? (
        <AuditWorkspace bp={bp} onEnterCopy={onEnterCopy} />
      ) : null}

      {/* Audit sign-offs on the staging image (from the content-hash-keyed
          store — these travel with the image into Production). */}
      <div>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Audit sign-offs {gate.frozen_sha ? `· image ${gate.frozen_sha.slice(0, 12)}` : ''}
        </div>
        {gate.signoffs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[13px] text-muted-foreground">
            No sign-offs on this image yet.
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-background px-3.5">
            {gate.signoffs.map((a) => (
              <SignoffRow key={a.id} a={a} mine={Boolean(meEmail) && a.who === meEmail} />
            ))}
          </div>
        )}
      </div>

      {/* Freeze & policy governance history. */}
      {gate.log.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Freeze &amp; policy history
          </div>
          <div className="rounded-lg border border-border bg-background px-3.5">
            {gate.log.map((e) => (
              <LogRow key={e.id} e={e} />
            ))}
          </div>
        </div>
      )}

      {/* Action area: member coverage / freeze-first / sign-off form */}
      {!roleKnown ? null : !canAudit ? (
        // A normal member: everything but the log is covered by an explainer +
        // the list of auditors/admins they can ask.
        <div className="order-first rounded-lg border border-border bg-muted/30 px-3.5 py-3">
          <div className="flex items-start gap-2">
            <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="text-[13px] text-foreground">
              Only <strong>admins and auditors</strong> can freeze staging, set the audit policy and
              sign off. You can promote to Staging, but promoting to Production must be done by an
              auditor. Ask one of them to review this image:
            </div>
          </div>
          <div className="mt-2.5 pl-6">
            {auditors === null ? (
              <div className="text-[12px] text-muted-foreground">Loading auditors…</div>
            ) : auditorsError ? (
              <div className="text-[12px] text-amber-700">
                Couldn’t load the auditor list. Please try again.
              </div>
            ) : auditors.length === 0 ? (
              <div className="text-[12px] text-muted-foreground">
                No auditors or admins are configured in this workspace yet.
              </div>
            ) : (
              <ul className="space-y-1">
                {auditors.map((a) => (
                  <li key={a.email} className="flex items-center gap-2 text-[13px] text-foreground">
                    <User className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="font-medium">{a.email}</span>
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {a.role}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : !gate.frozen ? (
        // Auditor/admin, but nothing to audit yet — must freeze first.
        <div className="order-first flex items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-3.5 py-3 text-[13px] text-foreground">
          <Snowflake className="size-4 shrink-0 text-sky-600" aria-hidden />
          <span>
            You must <strong>freeze staging</strong> before auditing — freeze it on the Staging node
            above to lock the image, then open it for auditing here.
          </span>
        </div>
      ) : null}
    </div>
  );
}

function LogRow({ e }: { e: StagingLogEntry }) {
  const icon =
    e.event === 'policy' ? (
      <Gavel className="size-3.5" aria-hidden />
    ) : (
      <Snowflake className="size-3.5" aria-hidden />
    );
  const tone = e.event === 'policy' ? 'bg-violet-100 text-violet-700' : 'bg-sky-100 text-sky-700';
  return (
    <div className="flex items-start gap-3 border-b border-border/60 py-2.5 last:border-b-0">
      <span
        className={cn('mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full', tone)}
        aria-hidden
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[13px] font-semibold text-foreground">{e.who}</span>
          {e.role ? <span className="text-[12px] text-muted-foreground">· {e.role}</span> : null}
          <span className="text-[12px] text-muted-foreground">
            {'· '}
            <RelativeTime value={e.at} />
          </span>
        </div>
        <div className="mt-0.5 text-[13px] text-foreground">{e.detail}</div>
      </div>
    </div>
  );
}

function SignoffRow({ a, mine }: { a: StagingSignoff; mine: boolean }) {
  const ok = a.verdict === 'approve';
  return (
    <div className="flex items-start gap-3 border-b border-border/60 py-2.5 last:border-b-0">
      <span
        className={cn(
          'mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full',
          ok ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700',
        )}
        aria-hidden
      >
        {ok ? <Check className="size-3.5" aria-hidden /> : <X className="size-3.5" aria-hidden />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[13px] font-semibold text-foreground">{a.who}</span>
          {mine ? (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              you
            </span>
          ) : null}
          {a.role ? <span className="text-[12px] text-muted-foreground">· {a.role}</span> : null}
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
              ok ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700',
            )}
          >
            {ok ? 'Approved' : 'Changes requested'}
          </span>
          <span className="text-[12px] text-muted-foreground">
            {'· '}
            <RelativeTime value={a.at} />
          </span>
        </div>
        {a.note ? (
          <div className="mt-1 rounded-md border-l-2 border-border bg-muted/40 px-2.5 py-1.5 text-[12px] text-muted-foreground">
            {a.note}
          </div>
        ) : null}
        {a.report ? (
          <details className="mt-1.5 rounded-md border border-border bg-muted/30">
            <summary className="cursor-pointer select-none px-2.5 py-1.5 text-[12px] font-semibold text-foreground">
              <FileText className="mr-1.5 inline size-3.5 align-[-2px]" aria-hidden />
              The report as it was signed off
            </summary>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words border-t border-border px-2.5 py-2 font-mono text-[12px] leading-relaxed text-muted-foreground">
              {a.report}
            </pre>
          </details>
        ) : (
          <div className="mt-1.5 text-[12px] text-muted-foreground">
            No report was recorded with this verdict.
          </div>
        )}
      </div>
    </div>
  );
}

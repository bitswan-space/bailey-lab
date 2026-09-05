import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, FileText, Loader2, Rocket, X } from 'lucide-react';
import { api, errorMessage, type AuditState, type StagingGate } from '@/lib/api';
import { toast } from '@/lib/notify';
import { SpecificationTab } from '@/components/workspace/SpecificationTab';
import { SyncDeployTab } from '@/components/views/SyncDeployTab';
import { useCopyStatus } from '@/hooks/useCopyStatus';
import { cn } from '@/lib/utils';
import type { BusinessProcess, Copy } from '@/types';
import type { BpDivergence } from '@/lib/api';

export interface AuditReportTabProps {
  bp: BusinessProcess;
  /** The audit copy in view. */
  copy: string;
  /** The copy record itself — the deploy flow works on it. */
  wt: Copy;
  // eslint-disable-next-line no-restricted-syntax -- null = not read yet
  divergence: BpDivergence | null;
  // eslint-disable-next-line no-restricted-syntax -- null = no error
  divergenceError: string | null;
  divergenceStale: boolean;
  /** After a proposal is deployed: the workspace shows Deployments. */
  onDeployed: () => void;
  // eslint-disable-next-line no-restricted-syntax -- null = unknown role
  role: string | null;
  meEmail: string;
  /** Flips to the Coding Agent tab — the agent edits this report like any file. */
  onShowAgents: () => void;
  /** Bumped by the shell when the copy's contents change. */
  editNonce?: number;
  onEdited?: () => void;
}

type Pane = 'report' | 'propose';

/**
 * What an auditor does, in the place a copy normally offers Deploy.
 *
 * Deploy is not the auditor's next step — signing off is, and the report is the
 * thing they write to get there. Both live here. The third option is still a
 * deploy, but it is named for what it means: proposing a new version, which
 * goes to Development and needs its own audit.
 *
 * The report is edited with the Description editor. It is the same kind of
 * document — prose, headings, diagrams, attachments — and it is an ordinary
 * file in the business process, so the coding agent reads and writes it too.
 */
export function AuditReportTab({
  bp,
  copy,
  wt,
  divergence,
  divergenceError,
  divergenceStale,
  onDeployed,
  role,
  meEmail,
  onShowAgents,
  editNonce = 0,
  onEdited,
}: AuditReportTabProps) {
  const [pane, setPane] = useState<Pane>('report');
  const [signing, setSigning] = useState(false);
  const saveRef = useRef<(() => Promise<void>) | undefined>(undefined);
  const registerSave = useCallback((fn: () => Promise<void>) => {
    saveRef.current = fn;
  }, []);
  const [audit, setAudit] = useState<AuditState | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- null = not loaded yet
  const [gate, setGate] = useState<StagingGate | null>(null);
  const { changed } = useCopyStatus(copy, editNonce);

  const load = useCallback(async () => {
    const [state, staging] = await Promise.allSettled([
      api.audits.state(bp.name),
      api.stagingGate(bp.name),
    ]);
    if (state.status === 'fulfilled') setAudit(state.value);
    if (staging.status === 'fulfilled') setGate(staging.value);
  }, [bp.name]);

  useEffect(() => {
    void load();
  }, [load]);

  const reportPath = audit?.report_path ?? `${bp.name}/AUDIT.md`;
  const canAudit = role === 'admin' || role === 'auditor';
  const myVerdict = meEmail
    ? gate?.signoffs?.find((a) => a.who === meEmail)?.verdict
    : undefined;

  // Signing off records the REPORT, so the report has to be on disk first —
  // and it is the report that is stored, not a note about it.
  const sign = async (verdict: 'approve' | 'reject') => {
    setSigning(true);
    const work = (async () => {
      await saveRef.current?.();
      const file = await api.copyFiles.content(copy, reportPath);
      const report = 'content' in file ? file.content : '';
      await api.recordAudit(bp.name, verdict, undefined, report);
      await load();
    })();
    toast.promise(work, {
      loading: verdict === 'approve' ? 'Recording your approval…' : 'Requesting changes…',
      success:
        verdict === 'approve'
          ? 'Approved, with your report'
          : 'Changes requested, with your report',
      error: (e: unknown) => `Couldn’t record the audit: ${errorMessage(e)}`,
    });
    try {
      await work;
    } catch {
      /* toast handled */
    } finally {
      setSigning(false);
    }
  };
  const proposals = changed.filter((c) => !c.path.endsWith('/AUDIT.md')).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <div className="flex items-center">
          {(
            [
              { id: 'report' as Pane, label: 'Report', Icon: FileText },
              { id: 'propose' as Pane, label: 'Propose a new version', Icon: Rocket },
            ]
          ).map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setPane(id)}
              className={cn(
                'inline-flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[12px]',
                pane === id
                  ? 'border-foreground font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="size-3.5" aria-hidden /> {label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {proposals > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded border border-violet-300 bg-violet-50 px-2 py-1 text-[11px] text-violet-900">
              <Rocket className="size-3.5" aria-hidden />
              {proposals} changed file{proposals === 1 ? '' : 's'} — deploying proposes a new
              version
            </span>
          )}
          {pane === 'report' && canAudit && (
            <>
            {myVerdict && (
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded px-2 py-1 text-[11px]',
                  myVerdict === 'approve'
                    ? 'bg-emerald-100 text-emerald-700'
                    : 'bg-red-100 text-red-700',
                )}
              >
                You {myVerdict === 'approve' ? 'approved' : 'requested changes on'} this image —
                signing again replaces it
              </span>
            )}
            <button
              type="button"
              onClick={() => void sign('approve')}
              disabled={signing}
              className="inline-flex h-7 items-center gap-1.5 rounded border border-emerald-300 bg-emerald-50 px-2 text-[11px] text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
              title="Record this report as an approval of the frozen image"
            >
              {signing ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Check className="size-3.5" aria-hidden />}
              Approve
            </button>
            <button
              type="button"
              onClick={() => void sign('reject')}
              disabled={signing}
              className="inline-flex h-7 items-center gap-1.5 rounded border border-red-300 bg-red-50 px-2 text-[11px] text-red-800 hover:bg-red-100 disabled:opacity-50"
              title="Record this report as a request for changes"
            >
              <X className="size-3.5" aria-hidden /> Request changes
            </button>
            </>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {pane === 'report' ? (
          <SpecificationTab
            bp={bp}
            copy={copy}
            path={reportPath}
            agentCta={{
              label: 'Write it with the agent',
              title:
                'Open the coding agent on this copy — the report is a file in it, so the agent reads and writes it like any other',
              prompt: [
                `Write the audit report for ${bp.name} in ${reportPath}.`,
                audit?.audited_sha
                  ? `The version under audit is the frozen staging image ${audit.audited_sha}, checked out in this copy.`
                  : 'The version under audit is the frozen staging image, checked out in this copy.',
                'Read the source, compare it with what is deployed in production, and fill in the headings that are already in the file: what this version changes, risk, verified, not verified.',
                'Write only what you actually checked — say plainly what you could not verify. Edit the file directly; do not change anything else.',
              ].join(' '),
            }}
            registerSave={registerSave}
            onShowAgents={onShowAgents}
            {...(onEdited ? { onSaved: onEdited } : {})}
          />
        ) : (
          <SyncDeployTab
            bp={bp}
            wt={wt}
            divergence={divergence}
            divergenceError={divergenceError}
            divergenceStale={divergenceStale}
            editNonce={editNonce}
            onDeployed={onDeployed}
            onManageDeployments={onDeployed}
          />
        )}
      </div>
    </div>
  );
}

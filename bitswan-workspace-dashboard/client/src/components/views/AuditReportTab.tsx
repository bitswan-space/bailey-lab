import { useCallback, useEffect, useState } from 'react';
import { FileText, Gavel, Rocket } from 'lucide-react';
import { api, errorMessage, type AuditState, type StagingGate } from '@/lib/api';
import { AuditSignOff } from '@/components/audits/AuditSignOff';
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

type Pane = 'report' | 'signoff' | 'propose';

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
  }, [bp.id, bp.name]);

  useEffect(() => {
    void load();
  }, [load]);

  const reportPath = audit?.report_path ?? `${bp.name}/AUDIT.md`;
  const proposals = changed.filter((c) => !c.path.endsWith('/AUDIT.md')).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <div className="flex items-center">
          {(
            [
              { id: 'report' as Pane, label: 'Report', Icon: FileText },
              { id: 'signoff' as Pane, label: 'Sign off', Icon: Gavel },
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
        <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
          {proposals > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded border border-violet-300 bg-violet-50 px-2 py-1 text-violet-900">
              <Rocket className="size-3.5" aria-hidden />
              {proposals} changed file{proposals === 1 ? '' : 's'} — deploying proposes a new
              version
            </span>
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
            }}
            onShowAgents={onShowAgents}
            {...(onEdited ? { onSaved: onEdited } : {})}
          />
        ) : pane === 'propose' ? (
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
        ) : (
          <div className="px-4 py-3">
            <AuditSignOff
              bp={bp.name}
              gate={gate}
              role={role}
              meEmail={meEmail}
              onChange={() => void load()}
              onEnterCopy={() => undefined}
              signOffHere
            />
          </div>
        )}
      </div>
    </div>
  );
}

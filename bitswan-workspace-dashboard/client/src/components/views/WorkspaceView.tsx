import { GitBranch, GitMerge, Loader2, Plus, Rocket } from 'lucide-react';
import { AgentFilesTab } from '@/components/views/AgentFilesTab';
import { EnvironmentPanel } from '@/components/agents/EnvironmentPanel';
import { DeploymentsTab } from '@/components/views/DeploymentsTab';
import { SyncDeployTab } from '@/components/views/SyncDeployTab';
import { RequirementsTab } from '@/components/requirements/RequirementsTab';
import { ReadmeCard } from '@/components/workspace/ReadmeCard';
import { SpecificationTab } from '@/components/workspace/SpecificationTab';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { BusinessProcess, FlowTab, Copy } from '@/types';

interface WorkspaceViewProps {
  // eslint-disable-next-line no-restricted-syntax -- null = no BP selected
  bp: BusinessProcess | null;
  // eslint-disable-next-line no-restricted-syntax -- null = no copy selected
  wt: Copy | null;
  /** A copy is selected but hasn't arrived in the copies snapshot yet — it's
   *  still being created (first-login personal copy, or one just created via
   *  the dialog). Copy-scoped empty states show "Creating copy…" instead of
   *  "No copy yet" while this is true (#160). */
  copyCreating?: boolean;
  tab: FlowTab;
  onTab: (t: FlowTab) => void;
  /** Open the "new business process" flow (the dialog lives in TopNav). */
  onNewBp: () => void;
}

/**
 * The body router below the TopNav. Description and Deployments work
 * without a copy (Deployments is always main-scoped); Coding Agent,
 * Requirements and Sync & Deploy follow the selected copy.
 */
export function WorkspaceView({
  bp,
  wt,
  copyCreating = false,
  tab,
  onTab,
  onNewBp,
}: WorkspaceViewProps) {
  const bpInWt = !!(wt && bp && bp.copies.includes(wt.name));

  if (!bp) {
    return (
      <CenteredNote
        icon={<Rocket className="size-5 text-primary" aria-hidden />}
        title="No business process"
        body="Create your first business process to get started."
        action={
          <Button size="sm" onClick={onNewBp}>
            <Plus className="size-3.5" aria-hidden />
            New business process
          </Button>
        }
      />
    );
  }

  // The Coding Agent pane stays mounted (hidden) across tab switches so a
  // running agent session isn't visually torn down when the user peeks at
  // another tab — mirroring the old WorktreeView's forceMount behaviour.
  const agentMounted = !!(wt && bpInWt);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {agentMounted && (
        <div
          className={cn('flex min-h-0 flex-1 flex-row', tab !== 'agent' && 'hidden')}
        >
          <div className="flex min-h-0 flex-1 flex-col">
            <AgentFilesTab
              copy={wt.name}
              bp={bp.name}
              branch={wt.branch || wt.name}
              tabVisible={tab === 'agent'}
            />
          </div>
          <EnvironmentPanel bp={bp.name} copy={wt.name} />
        </div>
      )}

      {tab === 'agent' && !agentMounted && (
        <CopyGate bp={bp} wt={wt} creating={copyCreating} what="run coding agents" />
      )}

      {tab === 'description' &&
        (bpInWt && wt ? (
          // Copy scope: the spec is editable — writes the copy's
          // README.md. Main scope below stays read-only (no write path).
          <SpecificationTab bp={bp} copy={wt.name} onShowAgents={() => onTab('agent')} />
        ) : (
          <div className="flex-1 overflow-auto bg-background">
            <div className="mx-auto max-w-4xl px-7 py-6">
              <ReadmeCard bpId={bp.id} />
            </div>
          </div>
        ))}

      {tab === 'requirements' &&
        (wt && bpInWt ? (
          <RequirementsTab
            copy={wt.name}
            bp={bp.name}
            onShowAgents={() => onTab('agent')}
          />
        ) : (
          <CopyGate bp={bp} wt={wt} creating={copyCreating} what="manage requirements" />
        ))}

      {tab === 'sync-deploy' &&
        (wt && bpInWt ? (
          <SyncDeployTab
            bp={bp}
            wt={wt}
            onShowAgents={() => onTab('agent')}
            onDeployed={() => onTab('deployments')}
            onManageDeployments={() => onTab('deployments')}
          />
        ) : (
          <CopyGate bp={bp} wt={wt} creating={copyCreating} what="sync and deploy" />
        ))}

      {tab === 'deployments' &&
        (bp.inMain ? (
          <DeploymentsTab bp={bp} />
        ) : (
          <CenteredNote
            icon={<GitMerge className="size-5 text-primary" aria-hidden />}
            title="Not in main yet"
            body={`“${bp.displayName}” only exists in copies. Sync a copy to main first — then its deployments show up here.`}
            action={
              wt && bpInWt ? (
                <Button size="sm" onClick={() => onTab('sync-deploy')}>
                  <Rocket className="size-3.5" aria-hidden />
                  Go to Sync &amp; Deploy
                </Button>
              ) : undefined
            }
          />
        ))}
    </div>
  );
}

/** Empty state for copy-scoped tabs when no/wrong copy is selected. */
function CopyGate({
  bp,
  wt,
  creating,
  what,
}: {
  bp: BusinessProcess;
  // eslint-disable-next-line no-restricted-syntax -- null = no copy selected
  wt: Copy | null;
  /** The selected copy is still being created (not in the snapshot yet). */
  creating?: boolean;
  what: string;
}) {
  if (!wt) {
    // A copy IS on its way — it just hasn't landed in the copies snapshot
    // yet. Saying "No copy yet" here reads like the creation didn't take
    // (#160), so show an in-progress note instead.
    if (creating) {
      return (
        <CenteredNote
          icon={<Loader2 className="size-5 animate-spin text-primary" aria-hidden />}
          title="Creating copy…"
          body={`Your copy is being set up — you'll be able to ${what} in a moment.`}
        />
      );
    }
    return (
      <CenteredNote
        icon={<GitBranch className="size-5 text-primary" aria-hidden />}
        title="No copy yet"
        body={`Create a copy (top-right switcher) to ${what}.`}
      />
    );
  }
  return (
    <CenteredNote
      icon={<GitBranch className="size-5 text-primary" aria-hidden />}
      title={`“${bp.displayName}” isn't in copy “${wt.name}”`}
      body="Create it here with “+ New business process”, or pick another copy."
    />
  );
}

function CenteredNote({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 items-center justify-center bg-background p-8">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <div className="flex size-11 items-center justify-center rounded-[10px] bg-primary/10">
          {icon}
        </div>
        <div className="text-[15px] font-semibold text-foreground">{title}</div>
        <p className="text-sm leading-relaxed text-muted-foreground">{body}</p>
        {action}
      </div>
    </div>
  );
}

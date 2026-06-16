import { GitBranch, GitMerge, Rocket } from 'lucide-react';
import { AgentFilesTab } from '@/components/views/AgentFilesTab';
import { EnvironmentPanel } from '@/components/agents/EnvironmentPanel';
import { DeploymentsTab } from '@/components/views/DeploymentsTab';
import { SnapshotsTab } from '@/components/views/SnapshotsTab';
import { SyncDeployTab } from '@/components/views/SyncDeployTab';
import { RequirementsTab } from '@/components/requirements/RequirementsTab';
import { ReadmeCard } from '@/components/workspace/ReadmeCard';
import { SpecificationTab } from '@/components/workspace/SpecificationTab';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { BusinessProcess, FlowTab, Worktree } from '@/types';

interface WorkspaceViewProps {
  // eslint-disable-next-line no-restricted-syntax -- null = no BP selected
  bp: BusinessProcess | null;
  // eslint-disable-next-line no-restricted-syntax -- null = no worktree selected
  wt: Worktree | null;
  tab: FlowTab;
  onTab: (t: FlowTab) => void;
}

/**
 * The body router below the TopNav. Description and Deployments work
 * without a worktree (Deployments is always main-scoped); Coding Agent,
 * Requirements and Sync & Deploy follow the selected worktree.
 */
export function WorkspaceView({ bp, wt, tab, onTab }: WorkspaceViewProps) {
  const bpInWt = !!(wt && bp && bp.worktrees.includes(wt.name));

  if (!bp) {
    return (
      <CenteredNote
        icon={<Rocket className="size-5 text-primary" aria-hidden />}
        title="No business process"
        body="Create one with “+ New business process” in the switcher above."
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
              worktree={wt.name}
              bp={bp.name}
              branch={wt.branch || wt.name}
            />
          </div>
          <EnvironmentPanel bp={bp.name} worktree={wt.name} />
        </div>
      )}

      {tab === 'agent' && !agentMounted && (
        <WorktreeGate bp={bp} wt={wt} what="run coding agents" />
      )}

      {tab === 'description' &&
        (bpInWt && wt ? (
          // Worktree scope: the spec is editable — writes the worktree's
          // README.md. Main scope below stays read-only (no write path).
          <SpecificationTab bp={bp} worktree={wt.name} onShowAgents={() => onTab('agent')} />
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
            worktree={wt.name}
            bp={bp.name}
            onShowAgents={() => onTab('agent')}
          />
        ) : (
          <WorktreeGate bp={bp} wt={wt} what="manage requirements" />
        ))}

      {tab === 'sync-deploy' &&
        (wt && bpInWt ? (
          <SyncDeployTab bp={bp} wt={wt} onShowAgents={() => onTab('agent')} />
        ) : (
          <WorktreeGate bp={bp} wt={wt} what="sync and deploy" />
        ))}

      {tab === 'snapshots' &&
        (bp.inMain ? (
          <SnapshotsTab bp={bp} />
        ) : (
          <CenteredNote
            icon={<GitMerge className="size-5 text-primary" aria-hidden />}
            title="Not in main yet"
            body={`“${bp.name}” only exists in worktrees. Sync a worktree to main first — then its data snapshots show up here.`}
          />
        ))}

      {tab === 'deployments' &&
        (bp.inMain ? (
          <DeploymentsTab bp={bp} />
        ) : (
          <CenteredNote
            icon={<GitMerge className="size-5 text-primary" aria-hidden />}
            title="Not in main yet"
            body={`“${bp.name}” only exists in worktrees. Sync a worktree to main first — then its deployments show up here.`}
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

/** Empty state for worktree-scoped tabs when no/wrong worktree is selected. */
function WorktreeGate({
  bp,
  wt,
  what,
}: {
  bp: BusinessProcess;
  // eslint-disable-next-line no-restricted-syntax -- null = no worktree selected
  wt: Worktree | null;
  what: string;
}) {
  if (!wt) {
    return (
      <CenteredNote
        icon={<GitBranch className="size-5 text-primary" aria-hidden />}
        title="No worktree yet"
        body={`Create a worktree (top-right switcher) to ${what}.`}
      />
    );
  }
  return (
    <CenteredNote
      icon={<GitBranch className="size-5 text-primary" aria-hidden />}
      title={`“${bp.name}” isn't in worktree “${wt.name}”`}
      body="Create it here with “+ New business process”, or pick another worktree."
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

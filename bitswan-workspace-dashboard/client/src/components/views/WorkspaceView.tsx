import { GitBranch, GitMerge, Loader2, Plus, Rocket } from 'lucide-react';
import { AgentFilesTab } from '@/components/views/AgentFilesTab';
import { GetStartedTab } from '@/components/views/GetStartedTab';
import { EnvironmentPanel } from '@/components/agents/EnvironmentPanel';
import { DeploymentsTab } from '@/components/views/DeploymentsTab';
import { SyncTab } from '@/components/views/SyncTab';
import { SyncDeployTab } from '@/components/views/SyncDeployTab';
import { RequirementsTab } from '@/components/requirements/RequirementsTab';
import { ReadmeCard } from '@/components/workspace/ReadmeCard';
import { SpecificationTab } from '@/components/workspace/SpecificationTab';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { BpDivergence } from '@/lib/api';
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
  /** The business process currently being materialized into the copy in view,
   *  if any. An experiment carries only the process it was started on, so
   *  opening another one clones it in on demand — while that runs the copy
   *  gate says "adding…" rather than "it isn't in this copy". */
  // eslint-disable-next-line no-restricted-syntax -- null = nothing in flight
  addingBp?: string | null;
  tab: FlowTab;
  onTab: (t: FlowTab) => void;
  /** An editor save landed in the current copy (dirtiness changed). */
  onCopyEdited?: () => void;
  /** How many editor saves have landed. The Deploy screen re-reads the copy's
   *  uncommitted work off this, since a save moves no git ref. */
  editNonce: number;
  /** Open the "new business process" flow (the dialog lives in TopNav). */
  onNewBp: () => void;
  /** The copy in view is the signed-in user's own — the only copy that syncs
   *  with main in either direction. */
  isMyCopy: boolean;
  /** The copy in view is one of the user's own experiments: its work reaches
   *  main by being merged back into the parent copy first. */
  isMyExperiment: boolean;
  /** The shell's ONE divergence reading for (copy, business process) — the
   *  same object the Sync step's existence is derived from, so the Sync and
   *  Deploy screens can never disagree about how this process stands. */
  // eslint-disable-next-line no-restricted-syntax -- null = not known
  divergence: BpDivergence | null;
  /** The reading describes the copy BEFORE an action this user just took. The
   *  Deploy screen must not assert from it; the Sync step may still offer a
   *  pull from it. */
  divergenceStale: boolean;
  /** Why that reading failed. null = it is trustworthy. */
  // eslint-disable-next-line no-restricted-syntax -- null = no error
  divergenceError: string | null;
  /** Pull main into ONE business process (the Sync tab's one action). */
  onPullBp: (copy: string, bp: string, bpLabel: string) => Promise<void>;
  /** Merge the experiment in view back into its parent copy — the same action
   *  the experiment banner carries. */
  onMergeBack: () => void;
  /** Take MAIN wholesale into the copy for the business process on screen, as
   *  the alternative to pulling it. Absent unless this is the user's own copy
   *  (main only ever flows into a person's own copy). */
  onTakeMain?: () => void;
}

/**
 * The body router below the TopNav. Description and Deployments work
 * without a copy (Deployments is always main-scoped); Sync, Coding Agent,
 * Requirements and Deploy follow the selected copy.
 */
export function WorkspaceView({
  bp,
  wt,
  copyCreating = false,
  addingBp = null,
  tab,
  onTab,
  onCopyEdited,
  editNonce,
  onNewBp,
  isMyCopy,
  isMyExperiment,
  divergence,
  divergenceError,
  divergenceStale,
  onPullBp,
  onMergeBack,
  onTakeMain,
}: WorkspaceViewProps) {
  const bpInWt = !!(wt && bp && bp.copies.includes(wt.name));

  // Orientation page — always reachable, even before any business process
  // exists (a brand-new operator opens here), so it precedes the empty state.
  if (tab === 'get-started') {
    return <GetStartedTab onTab={onTab} onNewBp={onNewBp} />;
  }

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
        <CopyGate bp={bp} wt={wt} creating={copyCreating} adding={addingBp === bp.id} what="run coding agents" />
      )}

      {tab === 'description' &&
        (bpInWt && wt ? (
          // Copy scope: the spec is editable — writes the copy's
          // README.md. Main scope below stays read-only (no write path).
          <SpecificationTab bp={bp} copy={wt.name} onShowAgents={() => onTab('agent')} onSaved={onCopyEdited} />
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
          <CopyGate bp={bp} wt={wt} creating={copyCreating} adding={addingBp === bp.id} what="manage requirements" />
        ))}

      {/* Pulling main INTO one business process of the copy. Only ever your
          own copy: main flows main → your copy → your experiments, never
          sideways — and one process at a time, because each is its own repo. */}
      {tab === 'sync' &&
        (wt && isMyCopy && bpInWt ? (
          <SyncTab
            wt={wt}
            bp={bp}
            divergence={divergence}
            divergenceError={divergenceError}
            onPull={onPullBp}
            onNothingToPull={() => onTab('description')}
            {...(onTakeMain ? { onTakeMain } : {})}
          />
        ) : (
          <CopyGate bp={bp} wt={wt} creating={copyCreating} adding={addingBp === bp.id} what="sync with main" />
        ))}

      {tab === 'deploy' &&
        (wt && bpInWt ? (
          <SyncDeployTab
            bp={bp}
            wt={wt}
            divergence={divergence}
            divergenceError={divergenceError}
            divergenceStale={divergenceStale}
            editNonce={editNonce}
            onDeployed={() => onTab('deployments')}
            onManageDeployments={() => onTab('deployments')}
            {...(isMyCopy ? { onGoToSync: () => onTab('sync'), isMyCopy: true } : {})}
          />
        ) : (
          <CopyGate bp={bp} wt={wt} creating={copyCreating} adding={addingBp === bp.id} what="deploy" />
        ))}

      {tab === 'deployments' &&
        (bp.inMain ? (
          <DeploymentsTab bp={bp} />
        ) : (
          <CenteredNote
            icon={<GitMerge className="size-5 text-primary" aria-hidden />}
            title="Not in main yet"
            body={
              isMyExperiment
                ? `“${bp.displayName}” only exists in copies. Merge this experiment back into your copy, then deploy from there — deployments show up here afterwards.`
                : `“${bp.displayName}” only exists in copies. Deploy a copy to main first — then its deployments show up here.`
            }
            action={
              // In an experiment the way forward is the merge back into the
              // parent copy — the Deploy tab isn't even there.
              isMyExperiment ? (
                <Button size="sm" onClick={onMergeBack}>
                  <GitMerge className="size-3.5" aria-hidden />
                  Merge back into my copy
                </Button>
              ) : wt && bpInWt ? (
                <Button size="sm" onClick={() => onTab('deploy')}>
                  <Rocket className="size-3.5" aria-hidden />
                  Go to Deploy
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
  adding,
  what,
}: {
  bp: BusinessProcess;
  // eslint-disable-next-line no-restricted-syntax -- null = no copy selected
  wt: Copy | null;
  /** The selected copy is still being created (not in the snapshot yet). */
  creating?: boolean;
  /** This business process is being cloned into the copy right now. */
  adding?: boolean;
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
        body={`Your copy is created for you when you sign in — reload the page to ${what}.`}
      />
    );
  }
  // Being cloned in right now. This is the normal path inside an experiment
  // (which is created carrying ONLY the business process it was started on) and
  // whenever the copy predates a process someone else added, so it must not
  // read as "this doesn't exist here, go make it".
  if (adding) {
    return (
      <CenteredNote
        icon={<Loader2 className="size-5 animate-spin text-primary" aria-hidden />}
        title={`Adding “${bp.displayName}” to this copy…`}
        body={`It's being brought in as it currently stands, so you can ${what} on it here in a moment.`}
      />
    );
  }
  return (
    <CenteredNote
      icon={<GitBranch className="size-5 text-primary" aria-hidden />}
      title={`“${bp.displayName}” isn't in copy “${wt.name}”`}
      body="Pick it in the business-process selector to bring it in, create a new one with “+ New business process”, or switch copies."
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

import { useCallback, useState } from 'react';
import { Rocket } from 'lucide-react';
import { toast } from 'sonner';
import { useSessions } from '@/components/agents/SessionProvider';
import { useCopyStatus } from '@/hooks/useCopyStatus';
import { DiffTab } from '@/components/diff/DiffTab';
import type { BusinessProcess, Copy } from '@/types';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { deployBpWithToast } from '@/lib/deployBp';

interface SyncDeployTabProps {
  bp: BusinessProcess;
  wt: Copy;
  /** Flips the shell to the Coding Agent tab (the rebase session runs there). */
  onShowAgents: () => void;
}

/**
 * Sync & Deploy tab (design: worktree.jsx). An explainer header with the
 * ahead/behind + diff summary and a single primary action, over the copy's
 * line-by-line diff.
 *
 * The button does the cheap thing when it can: `POST /copies/{name}/sync`
 * commits work in progress and, when the copy is a pure fast-forward of main
 * (no rebase needed), fast-forwards main to it server-side and deploys to dev —
 * no coding agent. When main has diverged it returns `needs_rebase`, and we
 * open a coding-agent session to rebase the copy; the user returns and presses
 * Sync & Deploy again, which now fast-forwards. main is never advanced by a
 * direct push — only by this user-gated deploy.
 */
export function SyncDeployTab({ bp, wt, onShowAgents }: SyncDeployTabProps) {
  const { changed } = useCopyStatus(wt.name);
  const { startSyncSession, setSelectedFor, agentStatus, ensureAgent } =
    useSessions();
  const [busy, setBusy] = useState(false);

  const adds = changed.reduce((a, c) => a + c.adds, 0);
  const dels = changed.reduce((a, c) => a + c.dels, 0);

  const handoffToAgent = useCallback(async () => {
    if (agentStatus === 'idle' || agentStatus === 'failed') {
      try {
        await ensureAgent();
      } catch {
        // surfaces via agentStatus; the session will still attempt to spawn
      }
    }
    const id = startSyncSession(wt.name);
    // Pre-select for this BP scope so flipping to the Coding Agent tab lands on
    // the rebase terminal without an extra click.
    setSelectedFor({ copy: wt.name, bp: bp.name }, id);
    onShowAgents();
  }, [
    agentStatus,
    ensureAgent,
    startSyncSession,
    setSelectedFor,
    wt.name,
    bp.name,
    onShowAgents,
  ]);

  const runSyncDeploy = useCallback(async () => {
    setBusy(true);
    try {
      let result;
      try {
        result = await api.copies.sync(wt.name);
      } catch (err) {
        toast.error(`Sync failed: ${String(err)}`);
        return;
      }
      if (result.status === 'needs_rebase') {
        toast.info(
          'main has moved on — opening a coding-agent session to rebase this copy. ' +
            'When it finishes, come back and press Sync & Deploy again.',
        );
        await handoffToAgent();
        return;
      }
      // Fast-forwarded into main — now deploy the business process to dev.
      await deployBpWithToast({
        bp: bp.name,
        stage: 'live-dev',
        copy: wt.name,
        loading: `Synced — deploying ${bp.name}…`,
        success: `${bp.name} synced and deployed`,
        failurePrefix: `Synced into main, but deploy failed for ${bp.name}`,
      });
    } finally {
      setBusy(false);
    }
  }, [wt.name, bp.name, handoffToAgent]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-background">
      {/* Explainer header + the one primary action. */}
      <div className="flex items-start gap-4 border-b border-border bg-background px-7 py-6">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-[10px] bg-primary/10">
          <Rocket className="size-5 text-primary" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[17px] font-bold tracking-tight text-foreground">
            Sync &amp; Deploy
          </div>
          <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
            Rebases{' '}
            <strong className="font-mono font-semibold text-foreground">
              {wt.name}
            </strong>{' '}
            onto the <strong className="text-foreground">main code area</strong>,
            then builds and deploys every container in this business process to{' '}
            <strong className="text-foreground">dev</strong>. Your changes below
            become the new main once the deploy succeeds.
          </p>
          <div className="mt-3 flex items-center gap-3.5">
            {wt.synced ? (
              <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
                Up to date with main
              </span>
            ) : (
              <span className="inline-flex items-center gap-2.5 text-xs">
                <span className="font-semibold text-amber-600">
                  ↓ {wt.behind} behind
                </span>
                <span className="font-semibold text-emerald-600">
                  ↑ {wt.ahead} ahead
                </span>
              </span>
            )}
            <span className="font-mono text-xs text-muted-foreground">
              {changed.length} file{changed.length === 1 ? '' : 's'} ·{' '}
              <span className="text-emerald-600">+{adds}</span> ·{' '}
              <span className="text-red-600">−{dels}</span>
            </span>
          </div>
        </div>
        <Button
          size="lg"
          className="shrink-0"
          disabled={wt.synced || busy}
          title={
            wt.synced
              ? 'Already up to date with main'
              : 'Commit, fast-forward into main, and deploy to dev'
          }
          onClick={() => void runSyncDeploy()}
        >
          <Rocket className="size-4" aria-hidden />
          {busy ? 'Working…' : 'Sync & Deploy'}
        </Button>
      </div>

      {/* Line-by-line diff of what will become the new main. */}
      <div className="min-h-0 flex-1">
        <DiffTab copy={wt.name} />
      </div>
    </div>
  );
}

import { useCallback, useState } from 'react';
import { Rocket } from 'lucide-react';
import { toast } from 'sonner';
import { useSessions } from '@/components/agents/SessionProvider';
import { useCopyStatus } from '@/hooks/useCopyStatus';
import { DiffTab } from '@/components/diff/DiffTab';
import { CopyHistoryView } from '@/components/views/CopyHistoryView';
import { cn } from '@/lib/utils';
import type { BusinessProcess, Copy } from '@/types';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { deployBpWithToast } from '@/lib/deployBp';
import { useUrlEnum } from '@/lib/urlState';

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
  const [view, setView] = useUrlEnum('view', ['diff', 'history'] as const, 'diff');

  // Scope the change summary to this BP — only its changes get synced/deployed,
  // so the counts here match the BP-scoped diff below.
  const bpChanged = changed.filter(
    (c) => c.path === bp.name || c.path.startsWith(`${bp.name}/`),
  );
  const adds = bpChanged.reduce((a, c) => a + c.adds, 0);
  const dels = bpChanged.reduce((a, c) => a + c.dels, 0);
  // Uncommitted work is still deployable: Sync & Deploy auto-commits it. So the
  // copy counts as actionable when it has either un-merged commits (not synced)
  // OR uncommitted changes — only a clean, fully-merged copy disables the button.
  const dirty = bpChanged.length > 0;
  const actionable = !wt.synced || dirty;

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
        // Scope the sync to this BP: only its commits go to main, the copy's
        // other commits are auto-rebased (or handed to the agent on conflict).
        result = await api.copyFiles.sync(wt.name, bp.name);
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
      // Fast-forwarded into main — now deploy the business process to the
      // shared `dev` stage (scanned from main, NOT the copy's live-dev). This
      // is what the Deployments tab shows and what staging/production promote
      // from; the copy's own live-dev preview keeps running independently.
      await deployBpWithToast({
        bp: bp.name,
        stage: 'dev',
        loading: `Synced — deploying ${bp.name} to dev…`,
        success: `${bp.name} synced and deployed to dev`,
        failurePrefix: `Synced into main, but deploy to dev failed for ${bp.name}`,
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
            {wt.synced && !dirty ? (
              <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
                Up to date with main
              </span>
            ) : !wt.synced ? (
              <span className="inline-flex items-center gap-2.5 text-xs">
                <span className="font-semibold text-amber-600">
                  ↓ {wt.behind} behind
                </span>
                <span className="font-semibold text-emerald-600">
                  ↑ {wt.ahead} ahead
                </span>
              </span>
            ) : (
              <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700">
                Uncommitted changes
              </span>
            )}
            <span className="font-mono text-xs text-muted-foreground">
              {bpChanged.length} file{bpChanged.length === 1 ? '' : 's'} ·{' '}
              <span className="text-emerald-600">+{adds}</span> ·{' '}
              <span className="text-red-600">−{dels}</span>
            </span>
          </div>
        </div>
        <Button
          size="lg"
          className="shrink-0"
          disabled={!actionable || busy}
          title={
            !actionable
              ? 'Already up to date with main'
              : 'Commit, fast-forward into main, and deploy to dev'
          }
          onClick={() => void runSyncDeploy()}
        >
          <Rocket className="size-4" aria-hidden />
          {busy ? 'Working…' : 'Sync & Deploy'}
        </Button>
      </div>

      {/* Diff (what becomes main) / History (copy + main commits, deploy tags). */}
      <div className="flex shrink-0 items-center gap-4 border-b border-border bg-background px-7">
        {(['diff', 'history'] as const).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setView(id)}
            className={cn(
              '-mb-px border-b-2 py-2.5 text-[13px] font-medium capitalize transition-colors',
              view === id
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {id}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {view === 'diff' ? (
          <DiffTab copy={wt.name} pathPrefix={bp.name} />
        ) : (
          <CopyHistoryView copy={wt.name} />
        )}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { Rocket } from 'lucide-react';
import { toast } from 'sonner';
import { useSessions } from '@/components/agents/SessionProvider';
import { useCopyStatus } from '@/hooks/useCopyStatus';
import { DiffTab } from '@/components/diff/DiffTab';
import { CopyHistoryView } from '@/components/views/CopyHistoryView';
import { SupplyChainPanel } from '@/components/supply-chain/SupplyChainPanel';
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
  const [view, setView] = useUrlEnum('view', ['diff', 'history', 'checks'] as const, 'diff');

  // Checks: scan the image a deploy of this BP WOULD build from this copy's
  // source (built + scanned on demand). Memoised so the panel doesn't refetch
  // on every render.
  const checksFetcher = useCallback(
    () => api.supplyChainPreview(bp.name, wt.name),
    [bp.name, wt.name],
  );

  // Scope the change summary to this BP — only its changes get synced/deployed,
  // so the counts here match the BP-scoped diff below.
  const bpChanged = changed.filter(
    (c) => c.path === bp.name || c.path.startsWith(`${bp.name}/`),
  );
  const adds = bpChanged.reduce((a, c) => a + c.adds, 0);
  const dels = bpChanged.reduce((a, c) => a + c.dels, 0);
  const dirty = bpChanged.length > 0;

  // The copy as a whole can be far ahead/behind main purely from work on OTHER
  // business processes, while THIS one is identical to main. Split the
  // divergence so the screen reflects the BP you're actually on. Re-fetched
  // whenever the change list updates (i.e. after a sync).
  // eslint-disable-next-line no-restricted-syntax -- null = not loaded yet
  const [divergence, setDivergence] = useState<import('@/lib/api').BpDivergence | null>(
    null,
  );
  useEffect(() => {
    let alive = true;
    api.copyFiles
      .divergence(wt.name, bp.name)
      .then((d) => alive && setDivergence(d))
      .catch(() => alive && setDivergence(null));
    return () => {
      alive = false;
    };
  }, [wt.name, bp.name, changed]);

  const aheadBp = divergence?.ahead_bp ?? 0;
  const behindBp = divergence?.behind_bp ?? 0;
  const aheadOther = divergence?.ahead_other ?? 0;
  const behindOther = divergence?.behind_other ?? 0;
  // This BP is up to date with main when it has no un-merged commits, isn't
  // behind main, and has no uncommitted edits. Other BPs' divergence does NOT
  // count — they sync from their own Sync & Deploy. Uncommitted work is still
  // actionable (Sync & Deploy auto-commits it).
  const bpUpToDate = aheadBp === 0 && behindBp === 0 && !dirty;
  const actionable = !bpUpToDate;

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
          <div className="mt-3 flex flex-col gap-2">
            {/* THIS business process — the only thing this button syncs/deploys. */}
            <div className="flex flex-wrap items-center gap-2.5 text-xs">
              <span className="w-44 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                This business process
              </span>
              {bpUpToDate ? (
                <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
                  Up to date with main
                </span>
              ) : (
                <span className="inline-flex flex-wrap items-center gap-2.5">
                  {behindBp > 0 && (
                    <span className="font-semibold text-amber-600">↓ {behindBp} behind</span>
                  )}
                  {aheadBp > 0 && (
                    <span className="font-semibold text-emerald-600">↑ {aheadBp} ahead</span>
                  )}
                  {dirty && (
                    <span className="font-mono text-muted-foreground">
                      {bpChanged.length} uncommitted file{bpChanged.length === 1 ? '' : 's'} ·{' '}
                      <span className="text-emerald-600">+{adds}</span> ·{' '}
                      <span className="text-red-600">−{dels}</span>
                    </span>
                  )}
                </span>
              )}
            </div>
            {/* OTHER business processes — informational; each syncs from its own
                Sync & Deploy screen and is NOT touched by this button. */}
            {(aheadOther > 0 || behindOther > 0) && (
              <div className="flex flex-wrap items-center gap-2.5 text-xs">
                <span className="w-44 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Other business processes
                </span>
                <span className="inline-flex flex-wrap items-center gap-2.5 text-muted-foreground">
                  {behindOther > 0 && <span>↓ {behindOther} behind</span>}
                  {aheadOther > 0 && <span>↑ {aheadOther} ahead</span>}
                  <span className="text-[11px] italic">
                    not synced by this button — each deploys from its own screen
                  </span>
                </span>
              </div>
            )}
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
        {(['diff', 'history', 'checks'] as const).map((id) => (
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
        ) : view === 'history' ? (
          <CopyHistoryView copy={wt.name} />
        ) : (
          <div className="min-h-0 flex-1 overflow-auto px-7 py-5">
            <SupplyChainPanel
              bp={bp.name}
              stage="dev"
              stageLabel="this build"
              copy={wt.name}
              fetcher={checksFetcher}
              emptyHint={`No buildable automation source found for ${bp.name} in ${wt.name}.`}
              intro={
                <>
                  Vulnerabilities in the image this business process would build from{' '}
                  <strong className="font-mono font-semibold text-foreground">{wt.name}</strong>’s
                  current source — the same artifact{' '}
                  <strong className="text-foreground">Sync &amp; Deploy</strong> ships. Built and
                  scanned on demand. Click a CVE to view it or mark it out of scope — that decision
                  is saved with the code and ships on Sync &amp; Deploy.
                </>
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}

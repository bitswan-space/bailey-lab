import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Rocket,
  ArrowDownToLine,
  CheckCircle2,
  SlidersHorizontal,
  Terminal,
} from 'lucide-react';
import { toast } from '@/lib/notify';
import { useCopyStatus } from '@/hooks/useCopyStatus';
import { useCopies, useDeployDone } from '@/components/workspace/WorkspaceProvider';
import { DiffTab } from '@/components/diff/DiffTab';
import { CopyHistoryView } from '@/components/views/CopyHistoryView';
import { SupplyChainPanel } from '@/components/supply-chain/SupplyChainPanel';
import { cn } from '@/lib/utils';
import type { BusinessProcess, Copy } from '@/types';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api';
import { watchDeployTask } from '@/lib/deployBp';
import { useUrlEnum } from '@/lib/urlState';

interface SyncDeployTabProps {
  bp: BusinessProcess;
  wt: Copy;
  /** Called once the dev deploy finishes successfully — used to jump to the
   *  Deployments tab (Development stage) so the user sees the result. */
  onDeployed: () => void;
  /** Switches the shell to the Deployments tab. Surfaced as "Manage
   *  Deployments" when this BP is already up to date (nothing to sync). */
  onManageDeployments: () => void;
  /** Switches the shell to the Sync tab. Only passed when that tab exists for
   *  the copy in view (the user's own copy) — on a colleague's copy the
   *  "behind main" note stands on its own. */
  onGoToSync?: () => void;
}

/**
 * Deploy tab (design: worktree.jsx). An explainer header with the
 * ahead/behind + diff summary and a single primary action, over the copy's
 * line-by-line diff.
 *
 * Deploying is FAST-FORWARD ONLY: `POST /copies/{name}/sync` commits work in
 * progress and, when the copy is a pure fast-forward of main, fast-forwards
 * main to it server-side and deploys to dev. It is deliberately NOT the place
 * where divergence gets resolved — while main carries changes this copy
 * lacks, the button is replaced by a pointer at the Sync tab, which pulls
 * them in (and hands genuine conflicts to the coding agent). main is never
 * advanced by a direct push — only by this user-gated deploy.
 */
// Sub-tab display labels. The URL keeps the stable `checks` key (bookmarks don't
// break), but the tab reads "Supply Chain Security" — it's the pre-deploy CVE
// scan plus the out-of-scope audit log, so name it for what it is.
const SUBTAB_LABELS = {
  diff: 'Diff',
  history: 'History',
  checks: 'Supply Chain Security',
} as const;

export function SyncDeployTab({
  bp,
  wt,
  onDeployed,
  onManageDeployments,
  onGoToSync,
}: SyncDeployTabProps) {
  const { changed } = useCopyStatus(wt.name);
  const [busy, setBusy] = useState(false);
  // Append-only build log for the in-flight (or just-finished) deploy: every
  // line gitops emits — image build steps, build.sh output (vite/go build),
  // per-member "Prepared N/M" — not just the latest line the toast shows.
  const [deployLog, setDeployLog] = useState<string[]>([]);
  const logRef = useRef<HTMLPreElement>(null);
  const [view, setView] = useUrlEnum('view', ['diff', 'history', 'checks'] as const, 'diff');

  // Keep the log pinned to the newest line as it streams in.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [deployLog]);

  // Supply Chain Security: scan the image a deploy of this BP WOULD build from
  // this copy's source (built + scanned on demand). Memoised so the panel
  // doesn't refetch on every render.
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
  // divergence so the screen reflects the BP you're actually on.
  // eslint-disable-next-line no-restricted-syntax -- null = not loaded yet
  const [divergence, setDivergence] = useState<import('@/lib/api').BpDivergence | null>(
    null,
  );
  // eslint-disable-next-line no-restricted-syntax -- null = no error
  const [divergenceError, setDivergenceError] = useState<string | null>(null);

  // WHEN this is re-read is load-bearing, because the fast-forward-only rule is
  // enforced from it. Our own edits (`changed`) are not the only thing that
  // moves it: main moves when SOMEONE ELSE deploys, and nothing about this
  // component changes when they do. Watching only [copy, bp, changed] left the
  // screen showing "↑ 1 ahead" with a live Deploy button 45s after a colleague
  // had published — the behind-guard silently did not apply, and pressing
  // Deploy posted a non-fast-forward sync that came back `needs_rebase`.
  //
  // So take the same signals the shell's Sync-step check takes: the `copies`
  // SSE snapshot (its identity changes on every git event, including main's
  // refs moving) and the completion of any deploy.
  const { copies: copiesSnapshot } = useCopies();
  const deployDone = useDeployDone();
  useEffect(() => {
    let alive = true;
    api.copyFiles
      .divergence(wt.name, bp.name)
      .then((d) => {
        if (!alive) return;
        setDivergence(d);
        setDivergenceError(null);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        // Do NOT fall back to zeros: "we could not read it" must never render
        // as "up to date with main".
        setDivergence(null);
        setDivergenceError(errorMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [wt.name, bp.name, changed, copiesSnapshot, deployDone]);

  // `null` means NOT KNOWN — never 0. Everything derived from it is gated on
  // `divergenceKnown`, so a pending or failed read cannot masquerade as a clean
  // copy (the silent default this screen used to have: `?? 0` turned both into
  // "All deployed and up to date").
  const divergenceKnown = divergence !== null;
  const aheadBp = divergence?.ahead_bp ?? 0;
  const behindBp = divergence?.behind_bp ?? 0;
  const aheadOther = divergence?.ahead_other ?? 0;
  const behindOther = divergence?.behind_other ?? 0;
  // This BP is up to date with main when it has no un-merged commits, isn't
  // behind main, and has no uncommitted edits — and we have actually READ the
  // divergence. Other BPs' divergence does NOT count — they deploy from their
  // own Deploy screen. Uncommitted work is still actionable (Deploy
  // auto-commits it).
  const bpUpToDate = divergenceKnown && aheadBp === 0 && behindBp === 0 && !dirty;
  const actionable = !bpUpToDate;
  // Deploying is fast-forward only. Anything main has that this copy lacks is
  // pulled in on the Sync tab first — never repaired from here.
  const blockedByBehind = behindBp > 0;

  const runSyncDeploy = useCallback(async () => {
    setBusy(true);
    setDeployLog([]);
    try {
      let result;
      try {
        // Scope the sync to this BP: only its commits go to main, the copy's
        // other commits are auto-rebased (or handed to the agent on conflict).
        result = await api.copyFiles.sync(wt.name, bp.name);
      } catch (err) {
        // This IS the Deploy action — name it that, and show what the server
        // actually said (the api layer carries the server's own detail).
        toast.error(`Deploy failed: ${errorMessage(err)}`, { duration: 12000 });
        return;
      }
      if (result.status === 'needs_rebase') {
        // The button is only enabled when this BP is a pure fast-forward of
        // main, so getting here means main moved between that check and the
        // request. Fail loudly with what the server said — nothing was
        // deployed, and the fix is the Sync tab.
        toast.error(`Deploy failed: ${result.message}`);
        return;
      }
      // Fast-forwarded into main. The sync endpoint ALREADY spawned the
      // dev-stage redeploy (so the deployed dev stage tracks main) and returned
      // its task id — TRACK that task. Do NOT fire a second deploy: it would
      // collide with the one the sync just started and 409 ("already in
      // progress") every time.
      const toastId = `bp-deploy-main-${bp.name}`;
      if (result.deploy_task_id) {
        const outcome = await watchDeployTask(result.deploy_task_id, toastId, {
          loading: `Published to main — deploying ${bp.name} to dev…`,
          success: `${bp.name} published and deployed to dev`,
          failurePrefix: `Published into main, but deploy to dev failed for ${bp.name}`,
          onLog: setDeployLog,
        });
        // Once it's fully deployed, jump to the Deployments tab's Development
        // stage so the user lands on the result of what they just shipped.
        if (outcome === 'completed') onDeployed();
      } else {
        // Published, but nothing was deployed (no deployable containers in
        // this BP, or no net change to deploy).
        toast.success(`${bp.name} published to main`);
      }
    } finally {
      setBusy(false);
    }
  }, [wt.name, bp.name, onDeployed]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-background">
      {/* Explainer header + the one primary action. */}
      <div className="flex items-start gap-4 border-b border-border bg-background px-7 py-6">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-[10px] bg-primary/10">
          <Rocket className="size-5 text-primary" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[17px] font-bold tracking-tight text-foreground">
            Deploy
          </div>
          <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
            Publishes{' '}
            <strong className="font-mono font-semibold text-foreground">
              {wt.name}
            </strong>{' '}
            into the <strong className="text-foreground">main code area</strong>,
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
              {!divergenceKnown ? (
                // Say WHICH it is. Rendering this state as "up to date" is the
                // silent default that made a stale screen look authoritative.
                divergenceError !== null ? (
                  <span
                    className="font-medium text-destructive"
                    title={divergenceError}
                  >
                    {`Couldn't check this against main — ${divergenceError}`}
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    Checking this against main…
                  </span>
                )
              ) : bpUpToDate ? (
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
            {/* OTHER business processes — informational; each publishes from
                its own Deploy screen and is NOT touched by this button. */}
            {(aheadOther > 0 || behindOther > 0) && (
              <div className="flex flex-wrap items-center gap-2.5 text-xs">
                <span className="w-44 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Other business processes
                </span>
                <span className="inline-flex flex-wrap items-center gap-2.5 text-muted-foreground">
                  {behindOther > 0 && <span>↓ {behindOther} behind</span>}
                  {aheadOther > 0 && <span>↑ {aheadOther} ahead</span>}
                  <span className="text-[11px] italic">
                    not published by this button — each deploys from its own screen
                  </span>
                </span>
              </div>
            )}
          </div>
        </div>
        {actionable && blockedByBehind ? (
          // Fast-forward only: there is nothing to decide here, so no dead
          // greyed-out button — point at the one action that unblocks it.
          <div className="flex max-w-64 shrink-0 flex-col items-end gap-2 text-right">
            <span className="text-[13px] font-medium text-amber-700">
              Main has changes you don&apos;t have yet — sync first.
            </span>
            {onGoToSync && (
              <Button
                size="lg"
                variant="outline"
                className="shrink-0"
                onClick={onGoToSync}
              >
                <ArrowDownToLine className="size-4" aria-hidden />
                Go to Sync
              </Button>
            )}
          </div>
        ) : actionable ? (
          <Button
            size="lg"
            className="shrink-0"
            disabled={busy}
            title="Commit, fast-forward into main, and deploy to dev"
            onClick={() => void runSyncDeploy()}
          >
            <Rocket className="size-4" aria-hidden />
            {busy ? 'Working…' : 'Deploy'}
          </Button>
        ) : (
          // Nothing to sync — this BP already matches main and is deployed.
          // Point the user at the Deployments tab to manage what's live instead
          // of dangling a dead, greyed-out action.
          <div className="flex shrink-0 flex-col items-end gap-2">
            <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-emerald-600">
              <CheckCircle2 className="size-4" aria-hidden />
              All deployed and up to date
            </span>
            <Button
              size="lg"
              variant="outline"
              className="shrink-0"
              title="Manage this business process's deployments, secrets and history"
              onClick={onManageDeployments}
            >
              <SlidersHorizontal className="size-4" aria-hidden />
              Manage Deployments
            </Button>
          </div>
        )}
      </div>

      {/* Live build log — every line gitops emits during the deploy, appended
          (not overwritten like the toast), so the image build steps and
          build.sh output (vite build / go build) are all visible. Shown while a
          deploy is in flight and left in place afterwards so the user can read
          what happened. */}
      {deployLog.length > 0 && (
        <div className="shrink-0 border-b border-border bg-muted/30 px-7 py-3">
          <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <Terminal className="size-3.5" aria-hidden />
            Build log
            {busy && (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                running
              </span>
            )}
          </div>
          <pre
            ref={logRef}
            className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 font-mono text-[12px] leading-relaxed text-foreground/90"
          >
            {deployLog.join('\n')}
          </pre>
        </div>
      )}

      {/* Diff (what becomes main) / History (copy + main commits, deploy tags). */}
      <div className="flex shrink-0 items-center gap-4 border-b border-border bg-background px-7">
        {(['diff', 'history', 'checks'] as const).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setView(id)}
            className={cn(
              '-mb-px border-b-2 py-2.5 text-[13px] font-medium transition-colors',
              view === id
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {SUBTAB_LABELS[id]}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {view === 'diff' ? (
          <DiffTab copy={wt.name} pathPrefix={bp.name} />
        ) : view === 'history' ? (
          <CopyHistoryView copy={wt.name} bp={bp.name} />
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
                  <strong className="text-foreground">Deploy</strong> ships. Built and
                  scanned on demand. Click a CVE to view it or mark it out of scope — that decision
                  is saved with the code and ships on Deploy.
                </>
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}

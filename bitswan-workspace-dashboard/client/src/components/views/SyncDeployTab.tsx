import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Rocket,
  ArrowDownToLine,
  CheckCircle2,
  SlidersHorizontal,
  Terminal,
  TriangleAlert,
} from 'lucide-react';
import { toast } from '@/lib/notify';
import { useCopyStatus } from '@/hooks/useCopyStatus';
import { DiffTab } from '@/components/diff/DiffTab';
import { CopyHistoryView } from '@/components/views/CopyHistoryView';
import { SupplyChainPanel } from '@/components/supply-chain/SupplyChainPanel';
import { cn } from '@/lib/utils';
import type { BusinessProcess, Copy } from '@/types';
import { Button } from '@/components/ui/button';
import { api, errorMessage, type BpDivergence } from '@/lib/api';
import { watchDeployTask } from '@/lib/deployBp';
import { useUrlEnum } from '@/lib/urlState';
import { PublishOverMainDialog } from '@/components/workspace/PublishOverMainDialog';
import type { PublishMode } from '@/lib/publishOverMain';

interface SyncDeployTabProps {
  bp: BusinessProcess;
  wt: Copy;
  /** The shell's ONE divergence reading for (copy, business process). The Sync
   *  step's existence is derived from the SAME object, so the two screens
   *  cannot contradict each other — they used to, because Sync came off a
   *  copy-wide "behind" count and this screen off the per-process one. null =
   *  not read yet, or the read failed; never 0-as-unknown. */
  // eslint-disable-next-line no-restricted-syntax -- null = not known
  divergence: BpDivergence | null;
  /** Why that reading failed. null = it is trustworthy. */
  // eslint-disable-next-line no-restricted-syntax -- null = no error
  divergenceError: string | null;
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
  /** True when the copy in view is the signed-in user's own — the only case in
   *  which publishing over main is even offered (it publishes YOUR version). */
  isMyCopy?: boolean;
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
  divergence,
  divergenceError,
  onDeployed,
  onManageDeployments,
  onGoToSync,
  isMyCopy,
}: SyncDeployTabProps) {
  const { changed } = useCopyStatus(wt.name);
  const [busy, setBusy] = useState(false);
  // The Advanced way out of a blocked Deploy: publish this copy's version even
  // though main moved on. Confirmation lives in its own dialog, which reads
  // live whose commits it would supersede.
  const [publishOverOpen, setPublishOverOpen] = useState(false);
  const [publishingOver, setPublishingOver] = useState(false);
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
  // business processes, while THIS one is identical to main — so the reading
  // is per business process. It arrives as a PROP, from the one place the
  // shell reads it, because the Sync step's existence is derived from exactly
  // the same numbers: two readings meant two answers, and the user got a Sync
  // step on a process this screen called up to date.

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
          // Copy the user reads: the process's NAME. `bp.name` is the
          // directory, and it is only right in the toast id above.
          loading: `Published to main — deploying ${bp.displayName} to dev…`,
          success: `${bp.displayName} published and deployed to dev`,
          failurePrefix: `Published into main, but deploy to dev failed for ${bp.displayName}`,
          onLog: setDeployLog,
        });
        // Once it's fully deployed, jump to the Deployments tab's Development
        // stage so the user lands on the result of what they just shipped.
        if (outcome === 'completed') onDeployed();
      } else {
        // Published, but nothing was deployed (no deployable containers in
        // this BP, or no net change to deploy).
        toast.success(`${bp.displayName} published to main`);
      }
    } finally {
      setBusy(false);
    }
  }, [wt.name, bp.name, onDeployed]);

  // Publishing over main. `expectedMain` is the tip the dialog described: if
  // main moved in between, gitops 409s rather than superseding commits the
  // user was never shown. A conflict no rule can decide changes NOTHING and
  // comes back as `needs_rebase` — the coding-agent handoff, same as Sync.
  const runPublishOver = useCallback(
    async (mode: PublishMode, expectedMain: string) => {
      setPublishingOver(true);
      const id = `publish-over-main-${bp.name}`;
      toast.loading(`Publishing your version of ${bp.displayName} over main…`, {
        id,
        duration: Infinity,
      });
      try {
        const res = await api.copyFiles.deployOverMain(wt.name, {
          bp: bp.name,
          mode,
          expectedMain,
        });
        if (res.status === 'needs_rebase') {
          toast.error(res.message, { id, duration: 14000 });
          return;
        }
        setPublishOverOpen(false);
        toast.success(res.message, { id, duration: 10000 });
        if (res.deploy_task_id) {
          const outcome = await watchDeployTask(res.deploy_task_id, `${id}-deploy`, {
            loading: `Deploying ${bp.displayName} to dev…`,
            success: `${bp.displayName} published and deployed to dev`,
            failurePrefix: `Published into main, but deploy to dev failed for ${bp.displayName}`,
            onLog: setDeployLog,
          });
          if (outcome === 'completed') onDeployed();
        }
      } catch (err) {
        toast.error(`Publishing over main failed: ${errorMessage(err)}`, {
          id,
          duration: 14000,
        });
      } finally {
        setPublishingOver(false);
      }
    },
    [wt.name, bp.name, bp.displayName, onDeployed],
  );

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
            {/* The other way out, and it is deliberately not a peer of the
                first: syncing is how work normally travels, and this takes the
                decision away from whoever made the changes on main. It is
                offered because the alternative — a user who genuinely means
                "mine is the right one" having no move at all — is what sends
                people to force-push behind the product's back. */}
            {isMyCopy && (
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                title={`Publish your version of ${bp.displayName} over main, superseding what other people changed`}
                onClick={() => setPublishOverOpen(true)}
              >
                <TriangleAlert className="size-3.5" aria-hidden />
                Deploy this version, overwriting main…
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

      <PublishOverMainDialog
        open={publishOverOpen}
        copy={wt.name}
        bp={bp.name}
        bpLabel={bp.displayName}
        busy={publishingOver}
        onConfirm={(mode, expectedMain) => void runPublishOver(mode, expectedMain)}
        onCancel={() => !publishingOver && setPublishOverOpen(false)}
      />

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
              emptyHint={`No buildable automation source found for ${bp.displayName} in ${wt.name}.`}
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

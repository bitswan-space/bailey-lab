import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Check,
  Code2,
  ExternalLink,
  FlaskConical,
  GitCompare,
  History,
  Layers,
  Loader2,
  RotateCcw,
  Rocket,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api, type BpHistory, type BpHistoryEntry } from '@/lib/api';
import { useAutomations } from '@/components/workspace/WorkspaceProvider';
import { DiffView } from '@/components/diff/DiffView';
import { promoteBpWithToast } from '@/lib/deployBp';
import { STATUS_META, stateToDisplay } from '@/lib/status';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';

const STAGES: { id: 'dev' | 'staging' | 'production'; label: string; icon: LucideIcon }[] =
  [
    { id: 'dev', label: 'Development', icon: Code2 },
    { id: 'staging', label: 'Staging', icon: FlaskConical },
    { id: 'production', label: 'Production', icon: Rocket },
  ];
const STAGE_LABEL: Record<string, string> = Object.fromEntries(
  STAGES.map((s) => [s.id, s.label]),
);

function statusTone(status: string): { dot: string; label: string; text: string } {
  switch (status) {
    case 'rolled-back':
      return { dot: 'bg-amber-500', label: 'Rolled back', text: 'text-amber-700' };
    case 'failed':
      return { dot: 'bg-red-500', label: 'Failed', text: 'text-red-700' };
    default:
      return { dot: 'bg-emerald-500', label: 'Deployed', text: 'text-emerald-700' };
  }
}

/**
 * Deployment History for one business process — full tab:
 * - a stage pipeline (Development → Staging → Production) to switch the viewed
 *   stage and **promote** the whole BP to the next stage;
 * - the live **service availability** of the current deployment (each member
 *   container's running state, replicas, open-app link);
 * - the git-derived deployment history (newest-first) with a **Current** marker,
 *   **Roll back** (whole-BP, all members together), and **Diff vs current**.
 */
export function DeploymentHistoryView({
  bp,
  stage,
  onClose,
}: {
  bp: string;
  stage: string;
  onClose: () => void;
}) {
  const [activeStage, setActiveStage] = useState(
    stage === '' ? 'production' : stage,
  );
  const [byStage, setByStage] = useState<Record<string, BpHistory | null>>({});
  const [loaded, setLoaded] = useState(false);
  // eslint-disable-next-line no-restricted-syntax -- null = no error
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // eslint-disable-next-line no-restricted-syntax -- null = no confirm open
  const [confirm, setConfirm] = useState<BpHistoryEntry | null>(null);
  const [busy, setBusy] = useState(false);
  // eslint-disable-next-line no-restricted-syntax -- null = diff panel closed
  const [diffFor, setDiffFor] = useState<BpHistoryEntry | null>(null);
  const [diffText, setDiffText] = useState('');
  const [diffLoading, setDiffLoading] = useState(false);
  const { automations } = useAutomations();

  // Load all three stages' histories so the pipeline shows which are deployed.
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setError(null);
    Promise.all(
      STAGES.map((s) =>
        api
          .bpHistory(bp, s.id)
          .then((h) => [s.id, h] as const)
          .catch(() => [s.id, null] as const),
      ),
    )
      .then((pairs) => {
        if (!alive) return;
        setByStage(Object.fromEntries(pairs));
        setLoaded(true);
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [bp, reloadKey]);

  const data = byStage[activeStage] ?? null;
  const history = data?.history ?? [];
  const currentEntry = useMemo(
    () =>
      history.find((e) => e.commit === data?.current) ?? history[0] ?? null,
    [history, data],
  );

  // Live availability of the current deployment's member containers.
  const members = useMemo(() => {
    if (!currentEntry) return [];
    return Object.keys(currentEntry.members).map((id) => {
      const a = automations.find((x) => x.deployment_id === id);
      return {
        id,
        display: a?.deployment_id ? stateToDisplay(a.state) : 'not-deployed',
        replicas: a?.replicas ?? 0,
        url: a?.automation_url ?? null,
      };
    });
  }, [currentEntry, automations]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  const runRollback = useCallback(
    async (entry: BpHistoryEntry) => {
      const ver = (entry.source_commit ?? entry.commit).slice(0, 8);
      setBusy(true);
      const work = api.bpRollback(bp, activeStage, entry.commit);
      toast.promise(work, {
        loading: `Rolling ${bp} back to ${ver}…`,
        success: `${bp} rolled back to ${ver}`,
        error: (e: unknown) => `Rollback failed: ${String(e)}`,
      });
      try {
        await work;
        refresh();
      } catch {
        /* toast handled it */
      } finally {
        setBusy(false);
        setConfirm(null);
      }
    },
    [bp, activeStage, refresh],
  );

  const runPromote = useCallback(
    async (target: 'staging' | 'production') => {
      setBusy(true);
      await promoteBpWithToast({
        bp,
        stage: target,
        loading: `Promoting ${bp} to ${target}…`,
        success: `${bp} promoted to ${target}`,
        failurePrefix: `Failed to promote ${bp} to ${target}`,
      });
      setBusy(false);
      refresh();
    },
    [bp, refresh],
  );

  const openDiff = useCallback(
    async (entry: BpHistoryEntry) => {
      if (!currentEntry?.source_commit || !entry.source_commit) return;
      setDiffFor(entry);
      setDiffText('');
      setDiffLoading(true);
      try {
        const r = await api.bpDiff(bp, entry.source_commit, currentEntry.source_commit);
        setDiffText(r.diff);
      } catch (e) {
        setDiffText(`Failed to load diff: ${String(e)}`);
      } finally {
        setDiffLoading(false);
      }
    },
    [bp, currentEntry],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10">
            <History className="size-4 text-primary" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-foreground">
              Deployment history
            </div>
            <div className="text-xs text-muted-foreground">
              <span className="font-mono">{bp}</span> · promote, roll back &amp;
              diff across stages
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex size-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        {/* Stage pipeline — switch viewed stage + promote between stages */}
        <div className="flex items-center gap-2 border-b border-border px-7 py-4">
          {STAGES.map((s, i) => {
            const sHist = byStage[s.id];
            const hasDeploy = !!sHist && sHist.history.length > 0;
            const active = s.id === activeStage;
            const Icon = s.icon;
            const next = STAGES[i + 1];
            const canPromote =
              hasDeploy &&
              i < STAGES.length - 1 &&
              !busy &&
              // only when the next stage differs from this stage's current
              byStage[next?.id ?? '']?.current !==
                (sHist?.history.find((h) => h.commit === sHist.current)
                  ?.source_commit ?? null);
            return (
              <div key={s.id} className="contents">
                <button
                  type="button"
                  onClick={() => hasDeploy && setActiveStage(s.id)}
                  disabled={!hasDeploy && !active}
                  className={cn(
                    'flex shrink-0 flex-col items-center gap-1.5',
                    !hasDeploy && !active && 'opacity-50',
                  )}
                >
                  <span
                    className={cn(
                      'flex size-11 items-center justify-center rounded-full ring-offset-2',
                      hasDeploy ? 'bg-emerald-500 text-white' : 'border border-dashed border-border bg-background text-muted-foreground',
                      active && 'ring-2 ring-primary',
                    )}
                  >
                    <Icon className="size-5" aria-hidden />
                  </span>
                  <span
                    className={cn(
                      'text-[11px] font-semibold uppercase tracking-wide',
                      active ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {s.label}
                  </span>
                </button>
                {next && (
                  <>
                    <div className="h-px flex-1 bg-border" aria-hidden />
                    <Button
                      variant={canPromote ? 'default' : 'outline'}
                      size="sm"
                      disabled={!canPromote}
                      onClick={() =>
                        void runPromote(next.id as 'staging' | 'production')
                      }
                      title={
                        canPromote
                          ? `Promote ${bp} to ${next.label}`
                          : `Nothing new to promote to ${next.label}`
                      }
                    >
                      Promote
                      <ArrowRight className="size-3.5" aria-hidden />
                    </Button>
                    <div className="h-px flex-1 bg-border" aria-hidden />
                  </>
                )}
              </div>
            );
          })}
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {error ? (
            <div className="p-6 text-sm text-destructive">
              Failed to load history: {error}
            </div>
          ) : !loaded ? (
            <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
            </div>
          ) : (
            <>
              {/* Live service availability for the current deployment */}
              {members.length > 0 && (
                <div className="mb-4 rounded-lg border border-border p-3">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Services · {STAGE_LABEL[activeStage] ?? activeStage}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {members.map((m) => {
                      const meta = STATUS_META[m.display];
                      return (
                        <div key={m.id} className="flex items-center gap-2.5 text-sm">
                          <span
                            className={cn('size-2 rounded-full', meta.dot)}
                            aria-hidden
                          />
                          <span className="font-mono text-xs text-foreground">
                            {m.id}
                          </span>
                          <span className={cn('text-xs', meta.labelColor)}>
                            {meta.label}
                          </span>
                          {m.replicas > 0 && (
                            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                              <Layers className="size-3" aria-hidden />
                              {m.replicas}
                            </span>
                          )}
                          {m.url && m.display === 'running' && (
                            <a
                              href={m.url}
                              target="_blank"
                              rel="noreferrer"
                              className="ml-auto inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                            >
                              Open <ExternalLink className="size-3" aria-hidden />
                            </a>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {history.length === 0 ? (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  Nothing deployed to {STAGE_LABEL[activeStage] ?? activeStage}{' '}
                  yet.
                  {activeStage === 'dev'
                    ? ' Deploy from Sync & Deploy to start a history.'
                    : ' Promote from the previous stage.'}
                </div>
              ) : (
                <ul className="flex flex-col gap-2">
                  {history.map((entry, i) => {
                    const isCurrent = entry.commit === data?.current;
                    const tone = statusTone(entry.status);
                    const ver = entry.source_commit ?? entry.commit;
                    const memberCount = Object.keys(entry.members ?? {}).length;
                    const firstImageId = Object.values(entry.members ?? {}).find(
                      (m) => m.image_id,
                    )?.image_id;
                    return (
                      <li
                        key={`${entry.commit}-${i}`}
                        className={cn(
                          'rounded-lg border bg-background px-4 py-3',
                          isCurrent
                            ? 'border-primary ring-1 ring-primary/20'
                            : 'border-border',
                        )}
                      >
                        <div className="flex items-center gap-2.5">
                          <span
                            className={cn('size-2 rounded-full', tone.dot)}
                            aria-hidden
                          />
                          <span className="font-mono text-sm font-semibold text-foreground">
                            {ver.slice(0, 8)}
                          </span>
                          <span className={cn('text-xs font-medium', tone.text)}>
                            {tone.label}
                          </span>
                          {entry.source && entry.source !== 'deploy' && (
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                              {entry.source === 'rollback'
                                ? 'rollback'
                                : `promoted from ${entry.source}`}
                            </span>
                          )}
                          {isCurrent && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                              <Check className="size-3" aria-hidden /> Current
                            </span>
                          )}
                          <span className="ml-auto text-[11px] text-muted-foreground">
                            {entry.deployed_at}
                          </span>
                        </div>
                        <div className="mt-1.5 flex items-center gap-3 pl-[18px] text-[11px] text-muted-foreground">
                          {entry.deployed_by && <span>{entry.deployed_by}</span>}
                          <span>
                            {memberCount} container{memberCount === 1 ? '' : 's'}
                          </span>
                          {firstImageId && (
                            <span className="font-mono">
                              {firstImageId.replace(/^sha256:/, '').slice(0, 12)}
                            </span>
                          )}
                          <span className="ml-auto flex items-center gap-1.5">
                            {!isCurrent &&
                              currentEntry?.source_commit &&
                              entry.source_commit && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => void openDiff(entry)}
                                >
                                  <GitCompare className="size-3" aria-hidden />
                                  Diff
                                </Button>
                              )}
                            {!isCurrent && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() => setConfirm(entry)}
                              >
                                <RotateCcw className="size-3" aria-hidden />
                                Roll back
                              </Button>
                            )}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>
      </div>

      {/* Diff vs current — full sub-overlay */}
      {diffFor && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-8"
          onClick={() => setDiffFor(null)}
        >
          <div
            className="flex h-[80vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
              <GitCompare className="size-4 text-muted-foreground" aria-hidden />
              <span className="text-sm font-medium">
                {(diffFor.source_commit ?? '').slice(0, 8)} → current{' '}
                {(currentEntry?.source_commit ?? '').slice(0, 8)}
              </span>
              <button
                type="button"
                onClick={() => setDiffFor(null)}
                className="ml-auto flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-muted"
                aria-label="Close diff"
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <DiffView
                path={`${bp} — ${(diffFor.source_commit ?? '').slice(0, 8)} vs current`}
                diff={diffText || (diffLoading ? '' : 'No changes.')}
                loading={diffLoading}
              />
            </div>
          </div>
        </div>
      )}

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
      >
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>Roll back this business process?</AlertDialogTitle>
            <AlertDialogDescription>
              All containers in <span className="font-mono">{bp}</span> at{' '}
              {STAGE_LABEL[activeStage] ?? activeStage} will be redeployed
              together to{' '}
              <span className="font-mono">
                {(confirm?.source_commit ?? confirm?.commit)?.slice(0, 8)}
              </span>{' '}
              ({confirm ? Object.keys(confirm.members ?? {}).length : 0}{' '}
              container(s)). This records a new history entry.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirm(null)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirm && void runRollback(confirm)}
            >
              Roll back
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

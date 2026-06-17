import { useCallback, useEffect, useState } from 'react';
import { Check, History, Loader2, RotateCcw, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, type BpHistory, type BpHistoryEntry } from '@/lib/api';
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

const STAGE_LABEL: Record<string, string> = {
  dev: 'Development',
  staging: 'Staging',
  production: 'Production',
};

function statusTone(status: string): { dot: string; label: string; text: string } {
  switch (status) {
    case 'deployed':
      return { dot: 'bg-emerald-500', label: 'Deployed', text: 'text-emerald-700' };
    case 'rolled-back':
      return { dot: 'bg-amber-500', label: 'Rolled back', text: 'text-amber-700' };
    case 'failed':
      return { dot: 'bg-red-500', label: 'Failed', text: 'text-red-700' };
    default:
      return { dot: 'bg-zinc-400', label: status, text: 'text-muted-foreground' };
  }
}

/**
 * Deployment History for one business process at one stage: the list of past
 * deploys/promotions/rollbacks (newest-first) with the live one marked, and a
 * whole-BP **Roll back** action on past entries. All of a BP's containers
 * deploy and roll back together, sharing one source git commit.
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
  // eslint-disable-next-line no-restricted-syntax -- null = not yet loaded
  const [data, setData] = useState<BpHistory | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- null = no error
  const [error, setError] = useState<string | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- null = no confirm open
  const [confirm, setConfirm] = useState<BpHistoryEntry | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.bpHistory(bp, stage));
    } catch (e) {
      setError(String(e));
    }
  }, [bp, stage]);

  useEffect(() => {
    setData(null);
    setError(null);
    void load();
  }, [load]);

  const runRollback = useCallback(
    async (entry: BpHistoryEntry) => {
      if (!entry.git_commit) return;
      setBusy(true);
      const work = api.bpRollback(bp, stage, entry.git_commit);
      toast.promise(work, {
        loading: `Rolling ${bp} back to ${entry.git_commit.slice(0, 8)}…`,
        success: `${bp} rolled back to ${entry.git_commit.slice(0, 8)}`,
        error: (e: unknown) => `Rollback failed: ${String(e)}`,
      });
      try {
        await work;
        await load();
      } catch {
        // toast handled it
      } finally {
        setBusy(false);
        setConfirm(null);
      }
    },
    [bp, stage, load],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl"
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
              <span className="font-mono">{bp}</span> ·{' '}
              {STAGE_LABEL[stage] ?? stage}
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

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {error ? (
            <div className="p-6 text-sm text-destructive">
              Failed to load history: {error}
            </div>
          ) : !data ? (
            <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
            </div>
          ) : data.history.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              Nothing deployed to {STAGE_LABEL[stage] ?? stage} yet.
              {stage === 'dev'
                ? ' Deploy from Sync & Deploy to start a history.'
                : ' Promote from the previous stage.'}
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {data.history.map((entry, i) => {
                const isCurrent =
                  !!entry.git_commit && entry.git_commit === data.current;
                const tone = statusTone(entry.status);
                const members = Object.entries(entry.members ?? {});
                const firstImageId = members.find(
                  ([, m]) => m.image_id,
                )?.[1]?.image_id;
                return (
                  <li
                    key={`${entry.git_commit}-${i}`}
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
                        {entry.git_commit
                          ? entry.git_commit.slice(0, 8)
                          : '(no commit)'}
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
                        {members.length} container
                        {members.length === 1 ? '' : 's'}
                      </span>
                      {firstImageId && (
                        <span className="font-mono">
                          {firstImageId.replace(/^sha256:/, '').slice(0, 12)}
                        </span>
                      )}
                      {!isCurrent && entry.git_commit && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="ml-auto"
                          disabled={busy}
                          onClick={() => setConfirm(entry)}
                        >
                          <RotateCcw className="size-3" aria-hidden />
                          Roll back
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
      >
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>Roll back this business process?</AlertDialogTitle>
            <AlertDialogDescription>
              All containers in <span className="font-mono">{bp}</span> at{' '}
              {STAGE_LABEL[stage] ?? stage} will be redeployed together to commit{' '}
              <span className="font-mono">
                {confirm?.git_commit?.slice(0, 8)}
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

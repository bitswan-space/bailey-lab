import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { toast } from '@/lib/notify';
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
import { api } from '@/lib/api';
import type { BusinessProcess } from '@/types';

export interface DeleteBusinessProcessDialogProps {
  /** The BP being deleted; the dialog is closed while this is null. */
  // eslint-disable-next-line no-restricted-syntax -- null = dialog closed
  bp: BusinessProcess | null;
  onClose: () => void;
}

/** The 409 guard payload gitops returns while staging/production deployments
 *  exist (or a deploy is in flight). Rendered inside the dialog. */
interface GuardDetail {
  error?: string;
  deployments?: ({ deployment_id: string; stage: string } | string)[];
}

/**
 * Confirm + run the destructive business-process delete. Gitops guards it
 * server-side (409 while staging/production deployments exist) and tears the
 * rest down asynchronously: dev/live-dev containers, per-BP and per-copy
 * databases, secrets, and the BP's source in main and every copy. Snapshots,
 * backups and the deploy history are kept. The `processes` SSE snapshot
 * dropping the BP is the completion signal — App's consistency effect then
 * moves the selection off the deleted BP by itself.
 */
export function DeleteBusinessProcessDialog({
  bp,
  onClose,
}: DeleteBusinessProcessDialogProps) {
  const [busy, setBusy] = useState(false);
  // eslint-disable-next-line no-restricted-syntax -- null = not blocked
  const [guard, setGuard] = useState<GuardDetail | null>(null);
  const [unmerged, setUnmerged] = useState<string[]>([]);

  // Reset + best-effort unmerged-work hints each time a BP is picked: a copy
  // with commits not yet on main loses that work when its clone is deleted.
  useEffect(() => {
    setBusy(false);
    setGuard(null);
    setUnmerged([]);
    if (!bp) return;
    let cancelled = false;
    for (const c of bp.copies) {
      api.copyFiles
        .divergence(c, bp.name)
        .then((d) => {
          if (cancelled || d.ahead_bp <= 0) return;
          setUnmerged((prev) =>
            [...prev, `${c}: ${d.ahead_bp} unmerged commit${d.ahead_bp === 1 ? '' : 's'}`].sort(),
          );
        })
        .catch(() => {
          // Best-effort hint only — the delete itself doesn't depend on it.
        });
    }
    return () => {
      cancelled = true;
    };
  }, [bp]);

  const confirm = async () => {
    if (!bp || busy) return;
    setBusy(true);
    try {
      const r = await api.deleteBusinessProcess(bp.name);
      if (r.status === 409) {
        // Guard hit — render the blocking deployments inside the dialog
        // instead of closing, so the user knows exactly what to tear down.
        setGuard(r.body?.detail ?? { error: 'conflict' });
        return;
      }
      if (r.status >= 400) {
        toast.error('Failed to delete business process', {
          description: r.error ?? `HTTP ${r.status}`,
        });
        return;
      }
      toast.success(`Deleting “${bp.displayName}”…`, {
        description:
          'Teardown runs in the background — the process disappears from the list when it finishes.',
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const copyList = bp ? [...(bp.inMain ? ['main'] : []), ...bp.copies] : [];

  return (
    <AlertDialog open={bp !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{bp?.displayName}”?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                This permanently deletes the business process{' '}
                <span className="font-mono">{bp?.name}</span>: its running
                dev/live-dev deployments, its databases (including every
                copy&apos;s), its secrets, and its source
                {copyList.length > 0 ? (
                  <> in {copyList.map((c) => `“${c}”`).join(', ')}</>
                ) : null}
                . Snapshots, backups and the deployment history are kept.
              </p>
              {unmerged.length > 0 && (
                <p className="flex items-start gap-1.5 text-amber-700">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <span>
                    Unmerged work that will be lost — {unmerged.join('; ')}.
                  </span>
                </p>
              )}
              {guard && (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-destructive">
                  {guard.error === 'deploy_in_progress' ? (
                    <p>
                      A deployment of this process is currently in progress —
                      wait for it to finish, then try again.
                    </p>
                  ) : (
                    <>
                      <p className="font-medium">
                        This process is still deployed to a protected stage.
                        Tear these down first (Deployments tab):
                      </p>
                      <ul className="mt-1 list-inside list-disc font-mono text-xs">
                        {(guard.deployments ?? []).map((d) =>
                          typeof d === 'string' ? (
                            <li key={d}>{d}</li>
                          ) : (
                            <li key={d.deployment_id}>
                              {d.deployment_id} ({d.stage})
                            </li>
                          ),
                        )}
                      </ul>
                    </>
                  )}
                </div>
              )}
              <p>This cannot be undone.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={busy}
            onClick={(e) => {
              // Keep the dialog open — a 409 renders the guard in place.
              e.preventDefault();
              void confirm();
            }}
          >
            {busy ? 'Deleting…' : 'Delete process'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

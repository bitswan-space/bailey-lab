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
import type { Copy } from '@/types';

export interface DeleteCopyDialogProps {
  /** The copy being deleted; the dialog is closed while this is null. */
  // eslint-disable-next-line no-restricted-syntax -- null = dialog closed
  copy: Copy | null;
  /** True when this is the signed-in user's own personal copy. */
  isOwnCopy: boolean;
  onClose: () => void;
  /** Fired once the delete is ACCEPTED (202) — the parent moves the selection
   *  off the copy; the `copies` SSE snapshot dropping it signals completion. */
  onDeleted: (name: string) => void;
}

/**
 * Confirm + run the destructive whole-copy delete: the copy's live-dev
 * deployments and containers, its per-copy databases, its branch in every
 * business process's repo, and its working tree. Unlike a BP delete nothing
 * is kept — unmerged commits and uncommitted changes are gone for good, so
 * the dialog fetches the copy's divergence and shows exactly what would be
 * lost before asking for confirmation (warn + confirm, never block).
 */
export function DeleteCopyDialog({
  copy,
  isOwnCopy,
  onClose,
  onDeleted,
}: DeleteCopyDialogProps) {
  const [busy, setBusy] = useState(false);
  const [unmerged, setUnmerged] = useState<string[]>([]);

  useEffect(() => {
    setBusy(false);
    setUnmerged([]);
    if (!copy) return;
    let cancelled = false;
    api.copyFiles
      .divergenceAll(copy.name)
      .then((d) => {
        if (cancelled) return;
        setUnmerged(
          Object.entries(d)
            .filter(([, v]) => v.ahead > 0)
            .map(([bp, v]) => `${bp}: ${v.ahead} unmerged commit${v.ahead === 1 ? '' : 's'}`)
            .sort(),
        );
      })
      .catch(() => {
        // Best-effort hint only.
      });
    return () => {
      cancelled = true;
    };
  }, [copy]);

  const confirm = async () => {
    if (!copy || busy) return;
    setBusy(true);
    try {
      const r = await api.deleteCopy(copy.name);
      if (r.status >= 400) {
        toast.error('Failed to delete copy', {
          description: r.error ?? r.body?.detail ?? `HTTP ${r.status}`,
        });
        return;
      }
      toast.success(`Deleting copy “${copy.name}”…`, {
        description:
          'Teardown runs in the background — the copy disappears from the list when it finishes.',
      });
      onDeleted(copy.name);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const hasLoss = unmerged.length > 0 || !!copy?.has_changes;

  return (
    <AlertDialog open={copy !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete copy “{copy?.name}”?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                This permanently deletes the whole copy: its running live-dev
                deployments, its databases, its branch in every business
                process, and all of its files. Work already synced to main is
                unaffected.
              </p>
              {hasLoss && (
                <p className="flex items-start gap-1.5 text-amber-700">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <span>
                    Work that will be lost —{' '}
                    {[
                      ...(copy?.has_changes ? ['uncommitted changes'] : []),
                      ...unmerged,
                    ].join('; ')}
                    .
                  </span>
                </p>
              )}
              {isOwnCopy && (
                <p>
                  This is your personal copy — a fresh one is created from
                  main the next time you open the dashboard.
                </p>
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
              e.preventDefault();
              void confirm();
            }}
          >
            {busy ? 'Deleting…' : 'Delete copy'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

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
import { useBpLabel } from '@/hooks/useBpLabel';
import { api, errorMessage } from '@/lib/api';
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
  /** The user confirmed: a copy transition has begun (the copy in view is
   *  about to stop existing), so the shell locks the interface. Gets the
   *  human label of what is being discarded. */
  onConfirmed?: (label: string) => void;
  /** The delete was accepted; only the copies feed is still awaited. */
  onSettled?: () => void;
  /** The delete failed — nothing moved; hand the interface back. */
  onFailed?: () => void;
}

/**
 * Confirm + run the destructive whole-copy delete: the copy's live-dev
 * deployments and containers, its per-copy databases, its branch in every
 * business process's repo, and its working tree. Unlike a BP delete nothing
 * is kept — unmerged commits and uncommitted changes are gone for good, so the
 * dialog reads BOTH live, at the moment it opens (its divergence from main and
 * its changed files), and shows exactly what would be lost before asking for
 * confirmation (warn + confirm, never block). Neither read is allowed to fail
 * quietly: on a destructive confirm, a swallowed error understates what the
 * user is about to destroy, so the dialog says it couldn't tell.
 *
 * Experiments are the user-facing case ("Discard experiment"): they're named
 * by their title, since their copy name is an opaque slug.
 */
export function DeleteCopyDialog({
  copy,
  isOwnCopy,
  onClose,
  onDeleted,
  onConfirmed,
  onSettled,
  onFailed,
}: DeleteCopyDialogProps) {
  // The unmerged-work list is keyed by DIRECTORY off `divergenceAll`; a dialog
  // that names what you are about to destroy must name it the way you know it.
  const bpLabel = useBpLabel();
  const [busy, setBusy] = useState(false);
  const [unmerged, setUnmerged] = useState<string[]>([]);
  /** Files with uncommitted/unpublished edits in the copy. null = not read
   *  yet; 0 = read and clean. */
  // eslint-disable-next-line no-restricted-syntax -- null = not read yet
  const [changedFiles, setChangedFiles] = useState<number | null>(null);
  /** What we tried to measure and couldn't, verbatim — shown in the dialog. */
  const [unreadable, setUnreadable] = useState<string[]>([]);

  useEffect(() => {
    setBusy(false);
    setUnmerged([]);
    setChangedFiles(null);
    setUnreadable([]);
    if (!copy) return;
    let cancelled = false;
    const failed = (what: string, err: unknown) => {
      if (cancelled) return;
      setUnreadable((cur) => [...cur, `${what}: ${errorMessage(err)}`]);
    };
    // Commits this copy has that main doesn't, per business process.
    api.copyFiles
      .divergenceAll(copy.name)
      .then((d) => {
        if (cancelled) return;
        setUnmerged(
          Object.entries(d)
            .filter(([, v]) => v.ahead > 0)
            .map(([bp, v]) => `${bpLabel(bp)}: ${v.ahead} unmerged commit${v.ahead === 1 ? '' : 's'}`)
            .sort(),
        );
      })
      .catch((err: unknown) => failed('unmerged commits', err));
    // Work that was never even committed. This used to come from the `copies`
    // SSE snapshot's `has_changes`, which no longer exists — and which only
    // refreshed on git events, so an edit saved a minute ago wasn't in it. Read
    // fresh, here, at the moment the user is asked to confirm.
    api.copyFiles
      .status(copy.name)
      .then((s) => {
        if (!cancelled) setChangedFiles(s.changed.length);
      })
      .catch((err: unknown) => failed('uncommitted changes', err));
    return () => {
      cancelled = true;
    };
  }, [copy]);

  const isExperiment = copy?.kind === 'experiment';
  const label = (isExperiment ? copy?.title : copy?.name) ?? copy?.name ?? '';

  const confirm = async () => {
    if (!copy || busy) return;
    setBusy(true);
    onConfirmed?.(label);
    try {
      const r = await api.deleteCopy(copy.name);
      if (r.status >= 400) {
        onFailed?.();
        toast.error(
          isExperiment ? 'Failed to discard experiment' : 'Failed to delete copy',
          {
            description: r.error ?? r.body?.detail ?? `HTTP ${r.status}`,
          },
        );
        return;
      }
      toast.success(`Deleting ${isExperiment ? 'experiment' : 'copy'} “${label}”…`, {
        description:
          'Teardown runs in the background — the copy disappears from the list when it finishes.',
      });
      onDeleted(copy.name);
      onClose();
      onSettled?.();
    } catch (err) {
      onFailed?.();
      throw err;
    } finally {
      setBusy(false);
    }
  };

  const dirty = changedFiles !== null && changedFiles > 0;
  const hasLoss = unmerged.length > 0 || dirty;

  return (
    <AlertDialog open={copy !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isExperiment ? `Discard experiment “${label}”?` : `Delete copy “${label}”?`}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                {isExperiment
                  ? 'This permanently deletes the whole experiment: its running live-dev deployments, its databases, its branch in every business process, and all of its files. Your own copy is untouched — only work that never left the experiment is lost.'
                  : 'This permanently deletes the whole copy: its running live-dev deployments, its databases, its branch in every business process, and all of its files. Work already published to main is unaffected.'}
              </p>
              {hasLoss && (
                <p className="flex items-start gap-1.5 text-amber-700">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <span>
                    Work that will be lost —{' '}
                    {[
                      ...(dirty
                        ? [
                            `uncommitted changes in ${changedFiles} file${changedFiles === 1 ? '' : 's'}`,
                          ]
                        : []),
                      ...unmerged,
                    ].join('; ')}
                    .
                  </span>
                </p>
              )}
              {/* A destructive confirm must not understate the damage: if we
                  couldn't read what's here, say so rather than showing an empty
                  "nothing to lose". */}
              {unreadable.length > 0 && (
                <p className="flex items-start gap-1.5 text-destructive">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <span>
                    {`Couldn't determine what would be lost (${unreadable.join('; ')}). ` +
                      `There may be work here that this delete destroys — check ` +
                      `once gitops is reachable, or continue knowing that.`}
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
            {isExperiment
              ? busy
                ? 'Discarding…'
                : 'Discard'
              : busy
                ? 'Deleting…'
                : 'Delete copy'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

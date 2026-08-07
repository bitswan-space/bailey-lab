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

export type TakeVersionSource = 'experiment' | 'main' | 'commit';

export interface TakeVersionDialogProps {
  open: boolean;
  /** Where the version comes from — this is the whole difference between the
   *  three cases, so it drives the words rather than a caller-supplied blob. */
  source: TakeVersionSource;
  /** The business process by its DISPLAY NAME. Never the directory slug. */
  bpLabel: string;
  /** How to refer to the version itself: an experiment's title, or a short
   *  sha with the stage and date it was deployed. Unused for `main`. */
  sourceLabel?: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * "Use this version — don't merge mine into it."
 *
 * The three entry points into the same primitive (an experiment, main, a
 * deployed version) share one dialog because they share the one promise the
 * user needs before pressing: WHATEVER YOU HAVE IS KEPT. Your current work on
 * this business process is parked as an experiment of its own first, and it is
 * still there under Advanced afterwards.
 *
 * The dialog says the promise plainly instead of asking "are you sure?", which
 * is the question a user cannot answer without knowing what happens to what
 * they have.
 */
export function TakeVersionDialog({
  open,
  source,
  bpLabel,
  sourceLabel,
  busy,
  onConfirm,
  onCancel,
}: TakeVersionDialogProps) {
  const what =
    source === 'main'
      ? 'the main version'
      : source === 'experiment'
        ? `“${sourceLabel ?? 'this experiment'}”`
        : `the version ${sourceLabel ?? ''}`.trim();
  const title =
    source === 'main'
      ? `Edit the main version of ${bpLabel}?`
      : source === 'experiment'
        ? `Use this version of ${bpLabel} without merging?`
        : `Edit this version of ${bpLabel}?`;

  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2 text-[13px] leading-snug">
              <p>
                Your copy of <strong>{bpLabel}</strong> becomes {what}, exactly
                as it stands. Nothing is merged in either direction.
              </p>
              <p>
                Whatever you have in <strong>{bpLabel}</strong> right now —
                including edits you have not committed — is saved first as a new
                experiment, named after today, and waits for you under{' '}
                <strong>Advanced → Experiments</strong>. If there is nothing of
                yours to save, none is created and you will be told so.
              </p>
              {source === 'experiment' && (
                <p>
                  The experiment itself is then closed: it has become your copy,
                  so keeping it as well would leave two things claiming to be
                  the same work.
                </p>
              )}
              {source === 'commit' && (
                <p>
                  Your copy ends up one commit ahead of main and none behind, so
                  you can fix this version and press Deploy without syncing
                  first.
                </p>
              )}
              <p>Only {bpLabel} is touched. Your other work is not involved.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} onClick={onCancel}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
          >
            {busy
              ? 'Taking it…'
              : source === 'main'
                ? 'Take the main version'
                : source === 'experiment'
                  ? 'Use this version'
                  : 'Edit this version'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

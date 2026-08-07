import { TriangleAlert } from 'lucide-react';
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

export interface RevertDevDialogProps {
  open: boolean;
  /** The business process by its DISPLAY NAME. */
  bpLabel: string;
  /** Short sha of the version dev goes back to. */
  commit: string;
  /** When that version was deployed to dev, already formatted for reading. */
  deployedAt: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Putting the DEV stage back to a version it ran before.
 *
 * This is the one action in the copy tree whose effect leaves the person doing
 * it: dev deploys from MAIN, so reverting dev means adding a commit to main —
 * and main is what every copy measures itself against. Everyone else's copy
 * goes one commit behind on this business process and picks the revert up on
 * their next Sync.
 *
 * That is intended (dev is shared; one person's fix to it is everybody's), and
 * it is exactly the kind of consequence a dialog must state rather than imply.
 * The reassuring half matters too: nothing of theirs is lost — their own
 * unpublished commits replay on top of the revert when they sync.
 */
export function RevertDevDialog({
  open,
  bpLabel,
  commit,
  deployedAt,
  busy,
  onConfirm,
  onCancel,
}: RevertDevDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Put dev back to this version of {bpLabel}?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2 text-[13px] leading-snug">
              <p>
                Dev goes back to <span className="font-mono">{commit}</span>
                {deployedAt ? `, the version it ran on ${deployedAt}` : ''}, and
                is redeployed from it.
              </p>
              <p>
                Nothing is rewritten: the version being replaced stays in the
                history and can be brought back the same way.
              </p>
              <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  <strong>Everyone else will see this.</strong> Dev runs the
                  shared main version, so after this every colleague's copy is
                  one commit behind on <strong>{bpLabel}</strong> and their next
                  Sync brings the revert in. Their own unpublished work is not
                  lost — it replays on top of it.
                </span>
              </div>
              <p>
                Staging and production are untouched. They go back through
                promote and rollback, not through here.
              </p>
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
            {busy ? 'Reverting dev…' : 'Revert dev to this version'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

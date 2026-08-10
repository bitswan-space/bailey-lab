import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { BusinessProcess } from '@/types';

export interface NewExperimentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The business process the experiment is started ON — the one, and only
   *  one, cloned into it. null when nothing is selected, which makes the
   *  create impossible rather than empty (see below). */
  // eslint-disable-next-line no-restricted-syntax -- null = no BP selected
  bp: BusinessProcess | null;
  /** The user has named what they're trying: start it. The SHELL owns the
   *  request, because creating an experiment is a copy transition — it locks
   *  the interface and unlocks it inside the new experiment. This dialog's job
   *  ends at "here is the title". */
  onStart: (title: string, bp: BusinessProcess) => void;
}

/**
 * Start an experiment: a side branch off your own copy for trying something
 * out on ONE business process, without disturbing the work in your copy. The
 * user names what they're trying, not a branch — the slug, the parent, the
 * business process and the ownership metadata are all recorded server-side.
 *
 * An experiment BELONGS to the business process in view and will never hold
 * another: each process is its own git repository, so the process is recorded
 * in the experiment's metadata and gitops refuses to materialize any other one
 * into it. With no business process selected there is nothing to experiment ON,
 * so the action is disabled and says so — sending the request anyway would 400.
 */
export function NewExperimentDialog({
  open,
  onOpenChange,
  bp,
  onStart,
}: NewExperimentDialogProps) {
  const [title, setTitle] = useState('');

  const trimmed = title.trim();
  const canSubmit = trimmed.length > 0 && bp !== null;

  const reset = useCallback(() => setTitle(''), []);

  // Submitting CLOSES the dialog and hands over. It does not sit there with a
  // "Starting…" button while the app behind it is half in one copy and half in
  // another: the shell puts its lock up on this very frame, and the next thing
  // the user sees is the experiment, whole.
  const handleSubmit = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!canSubmit || !bp) return;
      onOpenChange(false);
      reset();
      onStart(trimmed, bp);
    },
    [canSubmit, bp, trimmed, onOpenChange, reset, onStart],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {bp ? `Start an experiment on ${bp.displayName}` : 'Start an experiment'}
          </DialogTitle>
          <DialogDescription>
            {bp
              ? `An experiment branches “${bp.displayName}” off your copy as it is right now — including edits you haven't committed. Work on it without touching your copy, then merge it back when you like the result — or discard it.`
              : `An experiment belongs to one business process — it branches that one process off your copy. Select one in the top bar first (or create one, if this workspace has none yet).`}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-2">
          <label htmlFor="new-experiment-title" className="text-sm font-medium">
            What are you trying out?
          </label>
          <Input
            id="new-experiment-title"
            autoFocus
            placeholder="Try new pricing rules"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={bp === null}
            autoComplete="off"
          />
          {/* An experiment is ONE business process, so it stays cheap however
              big the workspace is — and switching to another process is a way
              out of the experiment, not a way to grow it. */}
          {bp && (
            <p className="text-[12px] text-muted-foreground">
              {`The experiment is on ${bp.displayName} and only ${bp.displayName} — each business process is its own repository. Switching to another one takes you back to your copy.`}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <span
            title={
              bp === null
                ? 'Select a business process first — an experiment belongs to exactly one.'
                : 'Start this experiment'
            }
          >
            <Button onClick={() => handleSubmit()} disabled={!canSubmit}>
              Start experiment
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

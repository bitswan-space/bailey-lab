import { useCallback, useState } from 'react';
import { toast } from '@/lib/notify';
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
import { api, errorMessage } from '@/lib/api';
import { watchDeployTask } from '@/lib/deployBp';
import type { BusinessProcess } from '@/types';

export interface NewExperimentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The business process the experiment is started ON — the one, and only
   *  one, cloned into it. null when nothing is selected, which makes the
   *  create impossible rather than empty (see below). */
  // eslint-disable-next-line no-restricted-syntax -- null = no BP selected
  bp: BusinessProcess | null;
  /** The new experiment's copy name (an opaque slug — everything the user
   *  sees is the title). The caller switches into it. */
  onCreated: (name: string) => void;
}

/**
 * Start an experiment: a side branch off your own copy for trying something
 * out on ONE business process, without disturbing the work in your copy. The
 * user names what they're trying, not a branch — the slug, the parent and the
 * ownership metadata are all derived server-side from the verified identity.
 *
 * The experiment is scoped to the business process in view: only that one is
 * cloned into it (cloning all of them is what made this take minutes), and the
 * rest of the copy materializes lazily if the user ever opens one. With no
 * business process selected there is nothing to experiment ON, so the action is
 * disabled and says so — sending the request anyway would either 400 or, worse,
 * create a real but empty experiment.
 */
export function NewExperimentDialog({
  open,
  onOpenChange,
  bp,
  onCreated,
}: NewExperimentDialogProps) {
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const trimmed = title.trim();
  const canSubmit = trimmed.length > 0 && bp !== null && !submitting;

  const reset = useCallback(() => {
    setTitle('');
    setSubmitting(false);
  }, []);

  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!canSubmit || !bp) return;
      setSubmitting(true);
      const work = api.createExperiment({ title: trimmed, bp: bp.name });
      toast.promise(work, {
        loading: `Starting experiment "${trimmed}" on ${bp.displayName}…`,
        success: `Experiment "${trimmed}" created`,
        // The server's own text, verbatim: gitops names the business process
        // and the parent copy when the parent doesn't carry it, which is the
        // actionable part.
        error: (err: unknown) =>
          `Failed to start experiment: ${errorMessage(err)}`,
      });
      try {
        const res = await work;
        onOpenChange(false);
        reset();
        onCreated(res.name);
        // An experiment deploys nothing up front — it is a side branch off ONE
        // business process, and the one the user opens is brought up lazily on
        // access. These two branches only fire if gitops ever does spawn a
        // deploy here; they are not the normal path.
        if (res.deploy_error) {
          toast.error(
            `Failed to start automations in "${trimmed}": ${res.deploy_error}`,
          );
        } else if (res.deploy_task_id) {
          void watchDeployTask(res.deploy_task_id, `exp-deploy-${res.name}`, {
            loading: `Starting automations in "${trimmed}"…`,
            success: `Experiment "${trimmed}" automations started`,
            failurePrefix: `Failed to start automations in "${trimmed}"`,
          });
        }
      } catch {
        // already reported via toast.promise
      } finally {
        setSubmitting(false);
      }
    },
    [canSubmit, bp, trimmed, onOpenChange, reset, onCreated],
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
              ? `An experiment branches “${bp.displayName}” off your copy as it is right now — including edits you haven't committed. Work in it without touching your copy, then merge it back when you like the result — or discard it.`
              : `An experiment is started on a business process — it branches that one process off your copy. Select one in the top bar first (or create one, if this workspace has none yet).`}
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
            disabled={submitting || bp === null}
            autoComplete="off"
          />
          {/* Only the business processes you open are ever cloned in, so an
              experiment stays cheap however big the workspace is. */}
          {bp && (
            <p className="text-[12px] text-muted-foreground">
              {`Only ${bp.displayName} is set up in the experiment. Any other business process you open in it is brought in from your copy at that point.`}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <span
            title={
              bp === null
                ? 'Select a business process first — an experiment is started on one, and only that one is cloned into it.'
                : 'Start this experiment'
            }
          >
            <Button onClick={() => void handleSubmit()} disabled={!canSubmit}>
              {submitting ? 'Starting…' : 'Start experiment'}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

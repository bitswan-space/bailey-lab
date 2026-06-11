import { useCallback, useState } from 'react';
import { toast } from 'sonner';
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
import { api, isTransientNetworkError } from '@/lib/api';
import { watchDeployTask } from '@/lib/deployBp';

// Gitops's worktree-name allowlist (mirrors `_WORKTREE_NAME_RE` in
// bitswan-gitops/app/routes/worktrees.py:_WORKTREE_NAME_RE). Kept here so we
// can give the user immediate feedback in the dialog rather than waiting
// for a 400 round-trip.
const WORKTREE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;

export interface NewWorktreeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingNames: string[];
  onCreated: (name: string) => void;
}

export function NewWorktreeDialog({
  open,
  onOpenChange,
  existingNames,
  onCreated,
}: NewWorktreeDialogProps) {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const trimmed = name.trim();
  // eslint-disable-next-line no-restricted-syntax -- error message; null = "no error"
  let validationError: string | null = null;
  if (trimmed.length === 0) {
    validationError = null; // empty input is just "not ready yet"
  } else if (!WORKTREE_NAME_RE.test(trimmed)) {
    validationError =
      'Use letters, digits and hyphens only. Must start with a letter or digit.';
  } else if (existingNames.includes(trimmed)) {
    validationError = `A worktree named "${trimmed}" already exists.`;
  }
  const canSubmit = trimmed.length > 0 && !validationError && !submitting;

  const reset = useCallback(() => {
    setName('');
    setSubmitting(false);
  }, []);

  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!canSubmit) return;
      setSubmitting(true);
      const work = api.createWorktree({ branch_name: trimmed });
      toast.promise(work, {
        loading: `Creating worktree "${trimmed}"…`,
        success: `Worktree "${trimmed}" created`,
        error: (err: unknown) =>
          isTransientNetworkError(err)
            ? `Worktree "${trimmed}" created`
            : `Failed to create worktree: ${String(err)}`,
      });
      try {
        const res = await work;
        onOpenChange(false);
        reset();
        onCreated(trimmed);
        // Server-side auto-deploy: gitops starts live-dev for every BP
        // automation in the new worktree — watch its task with a second
        // toast (fire-and-forget).
        if (res.deploy_error) {
          toast.error(
            `Failed to start automations in "${trimmed}": ${res.deploy_error}`,
          );
        } else if (res.deploy_task_id) {
          void watchDeployTask(res.deploy_task_id, `wt-deploy-${trimmed}`, {
            loading: `Starting automations in ${trimmed}…`,
            success: `Worktree ${trimmed} automations started`,
            failurePrefix: `Failed to start automations in ${trimmed}`,
          });
        }
      } catch {
        // already reported via toast.promise
      } finally {
        setSubmitting(false);
      }
    },
    [canSubmit, trimmed, onOpenChange, reset, onCreated],
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
          <DialogTitle>New worktree</DialogTitle>
          <DialogDescription>
            Creates a new git worktree under <code>worktrees/</code> with a
            branch of the same name, branched off the current main HEAD.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-2">
          <label htmlFor="new-worktree-name" className="text-sm font-medium">
            Branch name
          </label>
          <Input
            id="new-worktree-name"
            autoFocus
            placeholder="my-feature"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={submitting}
            spellCheck={false}
            autoComplete="off"
          />
          {validationError && (
            <p className="text-xs text-destructive">{validationError}</p>
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
          <Button onClick={() => void handleSubmit()} disabled={!canSubmit}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

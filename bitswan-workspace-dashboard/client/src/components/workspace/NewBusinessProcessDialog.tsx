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
import { api, isTransientNetworkError } from '@/lib/api';
import { SessionExpiredError } from '@/lib/session';
import { watchDeployTask } from '@/lib/deployBp';
import { slugifyBpName } from '@/lib/slug';

// Mirrors the gitops-side cap on display-name length.
const MAX_BP_NAME_LEN = 100;

export interface NewBusinessProcessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  copy?: string;
  existingNames: string[];
  onCreated: (name: string) => void;
}

export function NewBusinessProcessDialog({
  open,
  onOpenChange,
  copy,
  existingNames,
  onCreated,
}: NewBusinessProcessDialogProps) {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const trimmed = name.replace(/\s+/g, ' ').trim();
  // The name is free-form (issue #77); the slug is what the directory, git
  // repo, and deployment ids are named after. `existingNames` are slugs, so
  // duplicates are checked at the slug level.
  const slug = slugifyBpName(trimmed);
  // eslint-disable-next-line no-restricted-syntax -- error message; null = "no error yet"
  let validationError: string | null = null;
  if (trimmed.length === 0) {
    validationError = null;
  } else if (trimmed.length > MAX_BP_NAME_LEN) {
    validationError = `Keep the name under ${MAX_BP_NAME_LEN} characters.`;
  } else if (!slug) {
    validationError = 'Include at least one letter or digit (a–z, 0–9).';
  } else if (existingNames.includes(slug)) {
    validationError = `A business process with the id "${slug}" already exists in this scope.`;
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
      const target = copy ? `copy "${copy}"` : 'main';
      const work = api.createBusinessProcess({
        name: trimmed,
        ...(copy ? { copy } : {}),
      });
      toast.promise(work, {
        loading: `Creating "${trimmed}" in ${target}…`,
        success: `Business process "${trimmed}" created`,
        error: (err: unknown) =>
          err instanceof SessionExpiredError
            ? undefined // expired session → the re-login banner says it; no scary "Failed" here
            : isTransientNetworkError(err)
              ? `Business process "${trimmed}" created`
              : `Failed to create business process: ${String(err)}`,
      });
      try {
        const res = await work;
        onOpenChange(false);
        reset();
        // The server's slug is the BP's id everywhere (selection, API paths);
        // the response carries it authoritatively.
        const createdSlug = res.name || slug;
        onCreated(createdSlug);
        // Server-side auto-setup: the BP was scaffolded from the default
        // template group and a deploy was kicked off in the background —
        // watch its task with a second toast (fire-and-forget).
        if (res.setup_error) {
          toast.error(`Auto-setup for "${trimmed}" failed: ${res.setup_error}`);
        } else if (res.deploy_task_id) {
          void watchDeployTask(
            res.deploy_task_id,
            `bp-deploy-${copy ?? 'main'}-${createdSlug}`,
            {
              loading: `Setting up ${trimmed}…`,
              success: `${trimmed} ready`,
              failurePrefix: `Failed to set up ${trimmed}`,
            },
          );
        }
      } catch {
        // toast handled it
      } finally {
        setSubmitting(false);
      }
    },
    [canSubmit, trimmed, slug, copy, onOpenChange, onCreated, reset],
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
          <DialogTitle>New business process</DialogTitle>
          <DialogDescription>
            {copy
              ? `Creates a new business-process directory under copies/${copy}/ with a process.toml and a starter README.`
              : 'Creates a new business-process directory in the main workspace with a process.toml and a starter README.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-2">
          <label htmlFor="new-bp-name" className="text-sm font-medium">
            Name
          </label>
          <Input
            id="new-bp-name"
            autoFocus
            placeholder="Invoice Processing"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={submitting}
            spellCheck={false}
            autoComplete="off"
          />
          {validationError ? (
            <p className="text-xs text-destructive">{validationError}</p>
          ) : (
            slug &&
            slug !== trimmed && (
              <p className="text-xs text-muted-foreground">
                Will be created as <span className="font-mono">{slug}</span>
              </p>
            )
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

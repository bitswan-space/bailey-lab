import { useCallback, useEffect, useState } from 'react';
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
import { slugifyBpName } from '@/lib/slug';
import type { BusinessProcess } from '@/types';

// Mirrors the gitops-side cap on display-name length.
const MAX_BP_NAME_LEN = 100;

export interface RenameBusinessProcessDialogProps {
  /** The BP being renamed; the dialog is closed while this is null. */
  // eslint-disable-next-line no-restricted-syntax -- null = dialog closed
  bp: BusinessProcess | null;
  onClose: () => void;
}

/**
 * Change a business process's display name. The slug — directory, git repo,
 * deployment ids, URLs — is immutable; only the `name` in process.toml moves,
 * so this is a safe, purely cosmetic rename. The updated listing arrives over
 * the SSE feed, so there is nothing to write back into local state here.
 */
export function RenameBusinessProcessDialog({
  bp,
  onClose,
}: RenameBusinessProcessDialogProps) {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Prefill with the current display name each time a BP is picked.
  useEffect(() => {
    if (bp) {
      setName(bp.displayName);
      setSubmitting(false);
    }
  }, [bp]);

  const trimmed = name.replace(/\s+/g, ' ').trim();
  // Same display-name rules as creation (NewBusinessProcessDialog) — minus
  // the duplicate check, which guards the slug, and the slug never changes.
  // eslint-disable-next-line no-restricted-syntax -- error message; null = "no error yet"
  let validationError: string | null = null;
  if (trimmed.length === 0) {
    validationError = null;
  } else if (trimmed.length > MAX_BP_NAME_LEN) {
    validationError = `Keep the name under ${MAX_BP_NAME_LEN} characters.`;
  } else if (!slugifyBpName(trimmed)) {
    validationError = 'Include at least one letter or digit (a–z, 0–9).';
  }
  const canSubmit =
    trimmed.length > 0 &&
    !validationError &&
    !submitting &&
    trimmed !== bp?.displayName;

  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!canSubmit || !bp) return;
      setSubmitting(true);
      // The display name shown for a BP is main's whenever it's in main
      // (gitops's `get_all_processes`), so rename main when possible and the
      // BP's copy only for copy-only BPs.
      const copy = bp.inMain ? undefined : bp.copies[0];
      const work = api.renameBusinessProcess(bp.name, {
        name: trimmed,
        ...(copy ? { copy } : {}),
      });
      toast.promise(work, {
        loading: `Renaming "${bp.displayName}" to "${trimmed}"…`,
        success: `Business process renamed to "${trimmed}"`,
        error: (err: unknown) =>
          err instanceof SessionExpiredError
            ? undefined // expired session → the re-login banner says it
            : isTransientNetworkError(err)
              ? `Business process renamed to "${trimmed}"`
              : `Failed to rename business process: ${String(err)}`,
      });
      try {
        await work;
        onClose();
      } catch {
        // toast handled it
      } finally {
        setSubmitting(false);
      }
    },
    [canSubmit, bp, trimmed, onClose],
  );

  return (
    <Dialog open={bp !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename business process</DialogTitle>
          <DialogDescription>
            Changes only the display name. The identifier{' '}
            <span className="font-mono">{bp?.name}</span> — and with it URLs
            and deployments — stays the same.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-2">
          <label htmlFor="rename-bp-name" className="text-sm font-medium">
            Name
          </label>
          <Input
            id="rename-bp-name"
            autoFocus
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
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={!canSubmit}>
            Rename
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import { useCallback, useState } from 'react';
import { Archive, X } from 'lucide-react';
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
  // A selected bundle switches the dialog into restore mode: the BP is
  // recreated from a downloaded deployment bundle instead of the template
  // scaffold, and the name becomes optional (the bundle carries one).
  // eslint-disable-next-line no-restricted-syntax -- null = no bundle selected (create mode)
  const [bundle, setBundle] = useState<File | null>(null);
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
  } else if (!submitting && existingNames.includes(slug)) {
    // Skipped while submitting: the created BP arrives over SSE (and thus in
    // existingNames) before the create response resolves — its own name must
    // not flash red as a "duplicate" mid-flight.
    validationError = `A business process with the id "${slug}" already exists in this scope.`;
  }
  // With a bundle the name is optional (empty = keep the bundle's name); a
  // typed name must still pass validation in both modes.
  const canSubmit =
    !validationError && !submitting && (bundle ? true : trimmed.length > 0);

  const reset = useCallback(() => {
    setName('');
    setBundle(null);
    setSubmitting(false);
  }, []);

  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!canSubmit) return;
      setSubmitting(true);
      const target = copy ? `copy "${copy}"` : 'main';
      // In restore mode without a typed name the display name comes from the
      // bundle — use the file name in toasts until the response tells us.
      const label = trimmed || bundle?.name || 'business process';
      const work = bundle
        ? api.createBusinessProcessFromBundle({
            file: bundle,
            ...(trimmed ? { name: trimmed } : {}),
            ...(copy ? { copy } : {}),
          })
        : api.createBusinessProcess({
            name: trimmed,
            ...(copy ? { copy } : {}),
          });
      toast.promise(work, {
        loading: bundle
          ? `Restoring "${label}" in ${target}…`
          : `Creating "${label}" in ${target}…`,
        success: bundle
          ? `Business process restored from "${label}"`
          : `Business process "${label}" created`,
        error: (err: unknown) =>
          err instanceof SessionExpiredError
            ? undefined // expired session → the re-login banner says it; no scary "Failed" here
            : isTransientNetworkError(err)
              ? bundle
                ? `Business process restored from "${label}"`
                : `Business process "${label}" created`
              : `Failed to ${bundle ? 'restore' : 'create'} business process: ${String(err)}`,
      });
      try {
        const res = await work;
        onOpenChange(false);
        reset();
        // The server's slug is the BP's id everywhere (selection, API paths);
        // the response carries it authoritatively.
        const createdSlug = res.name || slug;
        const createdLabel = res.display_name || trimmed || createdSlug;
        onCreated(createdSlug);
        // Server-side auto-setup: create scaffolds the default template group,
        // restore deploys the bundle's own automations — either way a deploy
        // was kicked off in the background; watch its task with a second toast.
        if (res.setup_error) {
          toast.error(`Auto-setup for "${createdLabel}" failed: ${res.setup_error}`);
        } else if (res.deploy_task_id) {
          void watchDeployTask(
            res.deploy_task_id,
            `bp-deploy-${copy ?? 'main'}-${createdSlug}`,
            {
              loading: `Setting up ${createdLabel}…`,
              success: `${createdLabel} ready`,
              failurePrefix: `Failed to set up ${createdLabel}`,
            },
          );
        }
      } catch {
        // toast handled it
      } finally {
        setSubmitting(false);
      }
    },
    [canSubmit, trimmed, slug, bundle, copy, onOpenChange, onCreated, reset],
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
            placeholder={bundle ? "Keep the bundle's name" : 'Invoice Processing'}
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
          <div className="mt-1 flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">
              …or restore from a downloaded bundle
            </span>
            {bundle ? (
              <div className="flex items-center gap-2 rounded-md border border-input px-3 py-2 text-[13px]">
                <Archive className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{bundle.name}</span>
                <button
                  type="button"
                  aria-label="Remove bundle"
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  disabled={submitting}
                  onClick={() => setBundle(null)}
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </div>
            ) : (
              <label className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-input px-3 py-2 text-[13px] text-muted-foreground hover:bg-muted">
                <Archive className="size-3.5" aria-hidden />
                Choose a .tar.gz bundle
                <input
                  type="file"
                  accept=".tar.gz,.tgz,application/gzip"
                  className="hidden"
                  disabled={submitting}
                  onChange={(e) => {
                    setBundle(e.target.files?.[0] ?? null);
                    e.target.value = '';
                  }}
                />
              </label>
            )}
            {bundle && (
              <p className="text-xs text-muted-foreground">
                Restores the bundle&apos;s source as a new business process
                {trimmed ? '' : " under the bundle's own name"}; containers are
                rebuilt and deployed automatically.
              </p>
            )}
          </div>
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
            {bundle ? 'Restore' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

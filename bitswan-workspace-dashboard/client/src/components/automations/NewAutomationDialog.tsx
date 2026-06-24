import { useCallback, useEffect, useState } from 'react';
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
import {
  api,
  isTransientNetworkError,
  type TemplateEntry,
  type TemplateGroupEntry,
  type TemplatesResponse,
} from '@/lib/api';
import { cn } from '@/lib/utils';

interface NewAutomationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bpId: string;
  copy?: string;
  /** Existing automation directory names to validate against. */
  existingNames: string[];
}

type Selection =
  | { kind: 'template'; entry: TemplateEntry }
  | { kind: 'group'; entry: TemplateGroupEntry };

const NAME_RE = /^[a-z][a-z0-9-]*$/;

function sanitize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Mirrors the bitswan-editor "Create Automation" gallery. Discovers
 * templates (and template groups) via the dashboard server's /api/templates
 * endpoint, lets the user pick a tile, prompts for a name (templates only —
 * groups bundle pre-named automations), and POSTs to /api/automations/from-template.
 */
export function NewAutomationDialog({
  open,
  onOpenChange,
  bpId,
  copy,
  existingNames,
}: NewAutomationDialogProps) {
  const [data, setData] = useState<TemplatesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Load templates lazily on first open. Re-fetch every open in case the
  // user edited /workspace/examples in the meantime; the response is cheap.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    api
      .templates()
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setData({ templates: [], groups: [] });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const reset = useCallback(() => {
    setSelection(null);
    setName('');
    setSubmitting(false);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) reset();
      onOpenChange(next);
    },
    [onOpenChange, reset],
  );

  const sanitizedName = sanitize(name);
  const nameError = (() => {
    if (selection?.kind !== 'template') return null;
    if (sanitizedName.length === 0) return null; // waiting for input
    if (!NAME_RE.test(sanitizedName)) {
      return 'Use lowercase letters, digits, and hyphens. Must start with a letter.';
    }
    if (existingNames.includes(sanitizedName)) {
      return `An automation named "${sanitizedName}" already exists.`;
    }
    return null;
  })();

  const groupConflict =
    selection?.kind === 'group'
      ? selection.entry.automations.find((a) => existingNames.includes(a))
      : null;

  const canSubmit =
    !submitting &&
    selection !== null &&
    (selection.kind === 'group'
      ? !groupConflict
      : sanitizedName.length > 0 && !nameError);

  const submit = useCallback(async () => {
    if (!selection || !canSubmit) return;
    setSubmitting(true);
    const label =
      selection.kind === 'template'
        ? `Creating "${sanitizedName}" from ${selection.entry.name}…`
        : `Creating ${selection.entry.automations.length} automations from ${selection.entry.name}…`;
    const successLabel =
      selection.kind === 'template'
        ? `Automation "${sanitizedName}" created`
        : `Created ${selection.entry.automations.length} automations`;
    const work = api.createAutomationFromTemplate({
      ...(selection.kind === 'template'
        ? { template_id: selection.entry.id, name: sanitizedName }
        : { group_id: selection.entry.id }),
      bp: bpId,
      ...(copy ? { copy } : {}),
    });
    toast.promise(work, {
      loading: label,
      success: successLabel,
      error: (err: unknown) =>
        isTransientNetworkError(err)
          ? successLabel
          : `Failed to create automation: ${String(err)}`,
    });
    try {
      await work;
      handleOpenChange(false);
    } catch {
      // toast handled the surfacing
    } finally {
      setSubmitting(false);
    }
  }, [selection, canSubmit, sanitizedName, bpId, copy, handleOpenChange]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex h-[80vh] max-w-3xl flex-col gap-3 overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {selection?.kind === 'template'
              ? `Name "${selection.entry.name}"`
              : 'New automation'}
          </DialogTitle>
          <DialogDescription>
            {selection === null
              ? 'Pick a template or template group to scaffold from.'
              : selection.kind === 'template'
                ? 'Choose a directory name for the new automation.'
                : 'Confirm to create every automation in this group.'}
          </DialogDescription>
        </DialogHeader>

        {selection === null ? (
          <div className="-mx-1 flex-1 overflow-y-auto px-1">
            {loading ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Loading templates…
              </p>
            ) : data && (data.templates.length > 0 || data.groups.length > 0) ? (
              <div className="flex flex-col gap-5 pb-2">
                {data.groups.length > 0 && (
                  <section className="flex flex-col gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Automation groups
                    </h3>
                    <Grid>
                      {data.groups.map((g) => (
                        <Tile
                          key={g.id}
                          name={g.name}
                          description={g.shortDescription}
                          iconSvg={g.iconSvg}
                          badge={`${g.automations.length} automations`}
                          onClick={() => setSelection({ kind: 'group', entry: g })}
                        />
                      ))}
                    </Grid>
                  </section>
                )}
                {data.templates.length > 0 && (
                  <section className="flex flex-col gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Templates
                    </h3>
                    <Grid>
                      {data.templates.map((t) => (
                        <Tile
                          key={t.id}
                          name={t.name}
                          description={t.shortDescription}
                          iconSvg={t.iconSvg}
                          onClick={() =>
                            setSelection({ kind: 'template', entry: t })
                          }
                        />
                      ))}
                    </Grid>
                  </section>
                )}
              </div>
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No templates found. Add your own under
                <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-xs">
                  workspace/templates/
                </code>
                or check that <code>/workspace/examples</code> is mounted.
              </p>
            )}
          </div>
        ) : selection.kind === 'template' ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            className="flex flex-col gap-2"
          >
            <label htmlFor="new-automation-name" className="text-sm font-medium">
              Directory name
            </label>
            <Input
              id="new-automation-name"
              autoFocus
              placeholder="my-automation"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
              spellCheck={false}
              autoComplete="off"
            />
            {nameError && <p className="text-xs text-destructive">{nameError}</p>}
          </form>
        ) : (
          <div className="flex flex-col gap-2 text-sm">
            <p>
              This will create {selection.entry.automations.length} automation
              {selection.entry.automations.length === 1 ? '' : 's'} in this
              business process:
            </p>
            <ul className="ml-4 list-disc text-muted-foreground">
              {selection.entry.automations.map((a) => (
                <li key={a}>
                  <code>{a}</code>
                </li>
              ))}
            </ul>
            {groupConflict && (
              <p className="text-xs text-destructive">
                Cannot create — an automation named "{groupConflict}" already
                exists in this business process.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {selection !== null && (
            <Button
              variant="ghost"
              onClick={reset}
              disabled={submitting}
              className="mr-auto"
            >
              ← Back
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() => handleOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          {selection !== null && (
            <Button onClick={() => void submit()} disabled={!canSubmit}>
              Create
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
      {children}
    </div>
  );
}

interface TileProps {
  name: string;
  description: string;
  iconSvg: string;
  badge?: string;
  onClick: () => void;
}

function Tile({ name, description, iconSvg, badge, onClick }: TileProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex flex-col items-start gap-2 rounded-md border border-border bg-background p-3 text-left transition-colors',
        'hover:border-primary/60 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
      )}
    >
      <div
        className="grid h-10 w-10 place-items-center [&_svg]:size-7"
        // The SVG is workspace-author-controlled content from a TOML on
        // disk; we trust it (same as the editor does for the same files).
        // eslint-disable-next-line no-restricted-syntax -- author-trusted content from the workspace bind-mount
        dangerouslySetInnerHTML={{ __html: iconSvg || '' }}
      />
      <div className="text-sm font-semibold leading-tight">{name}</div>
      <div className="text-xs leading-snug text-muted-foreground line-clamp-3">
        {description}
      </div>
      {badge && (
        <span className="mt-auto rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          {badge}
        </span>
      )}
    </button>
  );
}

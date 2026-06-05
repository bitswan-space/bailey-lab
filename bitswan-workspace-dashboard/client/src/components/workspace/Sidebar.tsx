import { useCallback, useMemo, useState } from 'react';
import { Folder, FolderOpen, Plus, Search } from 'lucide-react';
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
import { cn } from '@/lib/utils';
import type { BusinessProcess } from '@/types';

const BP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

interface SidebarProps {
  bps: BusinessProcess[];
  // eslint-disable-next-line no-restricted-syntax -- null = no BP selected yet
  activeBpId: string | null;
  onSelect: (id: string) => void;
  /**
   * Current scope's worktree (undefined for main). New BPs are created in
   * this scope so the user gets immediate sidebar feedback.
   */
  worktree?: string;
  /**
   * Called after a successful create so the parent can auto-select the new
   * BP — the SSE feed will deliver it shortly, but selecting by name is
   * idempotent.
   */
  onCreated?: (name: string) => void;
}

export function Sidebar({
  bps,
  activeBpId,
  onSelect,
  worktree,
  onCreated,
}: SidebarProps) {
  const [query, setQuery] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return bps;
    return bps.filter((b) => b.name.toLowerCase().includes(q));
  }, [bps, query]);

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-muted/30">
      <div className="px-3 pb-1.5 pt-3.5">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search business processes…"
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 px-3.5 pb-1 pt-1.5">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Business Processes
        </div>
        {/* BP creation is worktree-only in the UI — new work belongs on a
            branch and gets promoted to main via merge. The server still
            accepts main-scope creation; we just don't surface it. */}
        {worktree && (
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            aria-label="New business process"
            title={`New business process in worktree "${worktree}"`}
            className={cn(
              'inline-flex size-5 items-center justify-center rounded-md text-muted-foreground transition-colors',
              'hover:bg-background/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            )}
          >
            <Plus className="size-3.5" aria-hidden />
          </button>
        )}
      </div>

      <div className="flex-1 space-y-0.5 overflow-auto px-2 pb-3">
        {filtered.length === 0 ? (
          <div className="px-3 pt-2 text-xs text-muted-foreground">
            {bps.length === 0 ? 'No business processes found' : 'No matches'}
          </div>
        ) : (
          filtered.map((bp) => {
            const active = bp.id === activeBpId;
            const IconCmp = active ? FolderOpen : Folder;
            return (
              <button
                key={bp.id}
                onClick={() => onSelect(bp.id)}
                className={cn(
                  'flex h-7 w-full items-center gap-2 truncate rounded-md px-2 text-left text-sm transition-colors',
                  active
                    ? 'bg-background text-foreground shadow-[inset_0_0_0_1px_var(--tw-shadow-color)] shadow-border'
                    : 'text-zinc-700 hover:bg-background/60',
                )}
              >
                <IconCmp
                  className={cn(
                    'size-3.5 shrink-0',
                    active ? 'text-primary' : 'text-muted-foreground',
                  )}
                  aria-hidden
                />
                <span className="flex-1 truncate">{bp.name}</span>
              </button>
            );
          })
        )}
      </div>

      <NewBusinessProcessDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        worktree={worktree}
        existingNames={bps.map((b) => b.name)}
        onCreated={(name) => {
          onCreated?.(name);
        }}
      />
    </aside>
  );
}

interface NewBusinessProcessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  worktree?: string;
  existingNames: string[];
  onCreated: (name: string) => void;
}

function NewBusinessProcessDialog({
  open,
  onOpenChange,
  worktree,
  existingNames,
  onCreated,
}: NewBusinessProcessDialogProps) {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const trimmed = name.trim();
  // eslint-disable-next-line no-restricted-syntax -- error message; null = "no error yet"
  let validationError: string | null = null;
  if (trimmed.length === 0) {
    validationError = null;
  } else if (!BP_NAME_RE.test(trimmed)) {
    validationError =
      'Use letters, digits, underscores, dots and dashes. Must start with a letter or digit.';
  } else if (existingNames.includes(trimmed)) {
    validationError = `A business process named "${trimmed}" already exists in this scope.`;
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
      const target = worktree ? `worktree "${worktree}"` : 'main';
      const work = api.createBusinessProcess({
        name: trimmed,
        ...(worktree ? { worktree } : {}),
      });
      toast.promise(work, {
        loading: `Creating "${trimmed}" in ${target}…`,
        success: `Business process "${trimmed}" created`,
        error: (err: unknown) =>
          isTransientNetworkError(err)
            ? `Business process "${trimmed}" created`
            : `Failed to create business process: ${String(err)}`,
      });
      try {
        const res = await work;
        onOpenChange(false);
        reset();
        onCreated(trimmed);
        // Server-side auto-setup: the BP was scaffolded from the default
        // template group and a deploy was kicked off in the background —
        // watch its task with a second toast (fire-and-forget).
        if (res.setup_error) {
          toast.error(`Auto-setup for "${trimmed}" failed: ${res.setup_error}`);
        } else if (res.deploy_task_id) {
          void watchDeployTask(
            res.deploy_task_id,
            `bp-deploy-${worktree ?? 'main'}-${trimmed}`,
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
    [canSubmit, trimmed, worktree, onOpenChange, onCreated, reset],
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
            {worktree
              ? `Creates a new business-process directory under worktrees/${worktree}/ with a process.toml and a starter README.`
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
            placeholder="my-process"
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

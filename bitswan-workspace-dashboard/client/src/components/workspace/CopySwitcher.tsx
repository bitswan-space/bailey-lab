import { useCallback, useState } from 'react';
import { Check, ChevronsUpDown, GitBranch, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { NewCopyDialog } from '@/components/workspace/NewCopyDialog';
import { useAutomations } from '@/components/workspace/WorkspaceProvider';
import { api, isTransientNetworkError } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { Copy } from '@/types';

interface CopySwitcherProps {
  // eslint-disable-next-line no-restricted-syntax -- null = no copy selected
  copy: string | null;
  copies: Copy[];
  onSelect: (name: string) => void;
}

/**
 * Top-bar copy switcher: flat copy list with sync dots, plus
 * "New copy" and "Delete copy" (for the selected one) in the footer.
 */
export function CopySwitcher({
  copy,
  copies,
  onSelect,
}: CopySwitcherProps) {
  const { automations: raw } = useAutomations();
  const [open, setOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const active = copies.find((w) => w.name === copy);

  // Editor-parity flow (moved from the old WorktreeView): best-effort stop
  // every live-dev deployment in the copy before asking gitops to remove
  // the directory — running containers pointing at a deleted bind-mount would
  // otherwise be stranded.
  const runDeleteCopy = useCallback(async () => {
    if (!copy) return;
    setDeleting(true);
    try {
      const wtPrefix = `copies/${copy}/`;
      const liveDev = raw.filter((a) => {
        const rel = a.relative_path ?? '';
        return (
          rel.startsWith(wtPrefix) && a.deployment_id && a.stage === 'live-dev'
        );
      });
      await Promise.allSettled(
        liveDev.map((a) =>
          a.deployment_id
            ? api.removeAutomation(a.deployment_id)
            : Promise.resolve(),
        ),
      );
      const work = api.deleteCopy(copy);
      toast.promise(work, {
        loading: `Deleting copy "${copy}"…`,
        success: `Copy "${copy}" deleted`,
        error: (err: unknown) =>
          isTransientNetworkError(err)
            ? `Copy "${copy}" deleted`
            : `Failed to delete copy: ${String(err)}`,
      });
      try {
        await work;
        // The copies SSE snapshot drops the entry; the App-level effect
        // re-selects the next available copy (or clears).
      } catch {
        // toast handled the surfacing
      }
    } finally {
      setDeleting(false);
      setDeleteOpen(false);
    }
  }, [raw, copy]);

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            title="Switch copy"
            className={cn(
              'inline-flex h-[34px] items-center gap-2 rounded-lg border bg-background py-0 pl-3 pr-2.5 transition-colors hover:bg-muted/60',
              active ? 'border-primary' : 'border-border',
              open && 'bg-muted/60',
            )}
          >
            <GitBranch
              className={cn(
                'size-3.5 shrink-0',
                active ? 'text-primary' : 'text-muted-foreground',
              )}
              aria-hidden
            />
            <span className="mr-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Copy
            </span>
            <span className="max-w-48 truncate font-mono text-[13px] font-semibold text-foreground">
              {active?.name ?? '—'}
            </span>
            {active && (
              <span
                title={active.synced ? 'Synced with main' : 'Unsynced'}
                className={cn(
                  'size-[7px] shrink-0 rounded-full',
                  active.synced ? 'bg-emerald-500' : 'bg-amber-500',
                )}
                aria-hidden
              />
            )}
            <ChevronsUpDown className="size-3.5 text-muted-foreground" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={6} className="w-80 p-0">
          <div className="max-h-72 space-y-0.5 overflow-auto p-1.5">
            {copies.length === 0 ? (
              <div className="px-2.5 py-2 text-xs text-muted-foreground">
                Setting up your copy…
              </div>
            ) : (
              copies.map((w) => {
                const isActive = w.name === copy;
                return (
                  <button
                    key={w.name}
                    onClick={() => {
                      onSelect(w.name);
                      setOpen(false);
                    }}
                    className={cn(
                      'flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left transition-colors',
                      isActive ? 'bg-muted' : 'hover:bg-muted/60',
                    )}
                  >
                    <GitBranch
                      className={cn(
                        'size-3.5 shrink-0',
                        isActive ? 'text-primary' : 'text-muted-foreground',
                      )}
                      aria-hidden
                    />
                    <span className="flex-1 truncate font-mono text-[13px]">
                      {w.name}
                    </span>
                    <span
                      title={w.synced ? 'Synced with main' : 'Unsynced'}
                      className={cn(
                        'size-[7px] shrink-0 rounded-full',
                        w.synced ? 'bg-emerald-500' : 'bg-amber-500',
                      )}
                      aria-hidden
                    />
                    {isActive && (
                      <Check className="size-3.5 shrink-0 text-primary" aria-hidden />
                    )}
                  </button>
                );
              })
            )}
          </div>
          <div className="flex flex-col gap-1 border-t border-border p-1.5">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setNewOpen(true);
              }}
              className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <Plus className="size-3.5" aria-hidden />
              New copy
            </button>
            <button
              type="button"
              disabled={!copy}
              onClick={() => {
                setOpen(false);
                setDeleteOpen(true);
              }}
              className={cn(
                'flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-xs font-medium transition-colors',
                copy
                  ? 'text-destructive hover:bg-destructive/10'
                  : 'cursor-not-allowed text-muted-foreground/50',
              )}
            >
              <Trash2 className="size-3.5" aria-hidden />
              Delete copy{copy ? ` "${copy}"` : ''}
            </button>
          </div>
        </PopoverContent>
      </Popover>

      <NewCopyDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        existingNames={copies.map((w) => w.name)}
        onCreated={(name) => onSelect(name)}
      />

      <AlertDialog
        open={deleteOpen}
        onOpenChange={(o) => !deleting && setDeleteOpen(o)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete copy &quot;{copy}&quot;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This force-removes the copy and the{' '}
              <code>{active?.branch ?? copy}</code> branch, and drops the
              copy&apos;s postgres database. Any live-dev deployments under
              this copy will be stopped first. Uncommitted changes are{' '}
              <strong>lost</strong>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(e) => {
                // Block AlertDialog's default close-on-action so the dialog
                // stays up while the async delete runs; we close it ourselves.
                e.preventDefault();
                void runDeleteCopy();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

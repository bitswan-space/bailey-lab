import { useState } from 'react';
import { Check, ChevronsUpDown, GitBranch, Plus } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { NewCopyDialog } from '@/components/workspace/NewCopyDialog';
import { cn } from '@/lib/utils';
import type { Copy } from '@/types';

interface CopySwitcherProps {
  // eslint-disable-next-line no-restricted-syntax -- null = no copy selected
  copy: string | null;
  copies: Copy[];
  onSelect: (name: string) => void;
}

/**
 * Top-bar copy switcher: flat copy list with sync dots, plus "New copy" in
 * the footer.
 *
 * There is deliberately NO "Delete copy" action. A copy is the user's personal
 * working environment; the dashboard must never let a user delete their own
 * copy — and listing other users' copies here must never expose a delete
 * either. Copy cleanup is an operator-only concern, handled out-of-band.
 */
export function CopySwitcher({ copy, copies, onSelect }: CopySwitcherProps) {
  const [open, setOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);

  const active = copies.find((w) => w.name === copy);

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
          </div>
        </PopoverContent>
      </Popover>

      <NewCopyDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        existingNames={copies.map((w) => w.name)}
        onCreated={(name) => onSelect(name)}
      />
    </>
  );
}

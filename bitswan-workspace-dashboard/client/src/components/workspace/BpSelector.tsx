import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronsUpDown, Folder, FolderOpen, Plus } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { BusinessProcess } from '@/types';

interface BpSelectorProps {
  bps: BusinessProcess[];
  // eslint-disable-next-line no-restricted-syntax -- null = no BP selected
  activeBpId: string | null;
  onSelect: (id: string) => void;
  /** Open the "new business process" flow (the dialog lives in TopNav, shared
   *  with the Automate Business Process action). */
  onNewBp: () => void;
}

/**
 * The business-process picker — the top-level subject you're building. A flat,
 * searchable list of every BP in the workspace. Picking which copy to work on
 * it in is a separate, subordinate choice (see CopySelector), so this selector
 * carries no copy notion at all.
 */
export function BpSelector({
  bps,
  activeBpId,
  onSelect,
  onNewBp,
}: BpSelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const activeBp = bps.find((b) => b.id === activeBpId) ?? null;
  const sorted = useMemo(
    () => [...bps].sort((a, b) => a.name.localeCompare(b.name)),
    [bps],
  );
  const q = query.trim().toLowerCase();
  const visible = q
    ? sorted.filter((b) => b.name.toLowerCase().includes(q))
    : sorted;

  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Switch business process"
          className={cn(
            'inline-flex h-[34px] max-w-64 items-center gap-2 rounded-lg border bg-background py-0 pl-3 pr-2.5 transition-colors hover:bg-muted/60',
            activeBp ? 'border-primary' : 'border-border',
            open && 'bg-muted/60',
          )}
        >
          <Folder
            className={cn(
              'size-3.5 shrink-0',
              activeBp ? 'text-primary' : 'text-muted-foreground',
            )}
            aria-hidden
          />
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Process
          </span>
          <span className="max-w-40 truncate text-[13px] font-semibold text-foreground">
            {activeBp?.name ?? 'Select a process'}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-72 p-0">
        <div className="border-b border-border p-1.5">
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search business processes…"
            spellCheck={false}
            autoComplete="off"
            className="h-8"
          />
        </div>
        <div className="max-h-72 space-y-0.5 overflow-auto p-1.5">
          {sorted.length === 0 ? (
            <div className="px-2.5 py-2 text-xs text-muted-foreground">
              No business processes yet
            </div>
          ) : visible.length === 0 ? (
            <div className="px-2.5 py-2 text-xs text-muted-foreground">
              No matches
            </div>
          ) : (
            visible.map((b) => {
              const active = b.id === activeBpId;
              const Icon = active ? FolderOpen : Folder;
              return (
                <button
                  key={b.id}
                  onClick={() => {
                    onSelect(b.id);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left transition-colors',
                    active ? 'bg-muted' : 'hover:bg-muted/60',
                  )}
                >
                  <Icon
                    className={cn(
                      'size-3.5 shrink-0',
                      active ? 'text-primary' : 'text-muted-foreground',
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    {b.name}
                  </span>
                  {active && (
                    <Check className="size-3.5 shrink-0 text-primary" aria-hidden />
                  )}
                </button>
              );
            })
          )}
        </div>
        <div className="border-t border-border p-1.5">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onNewBp();
            }}
            className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            <Plus className="size-3.5" aria-hidden />
            New business process
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

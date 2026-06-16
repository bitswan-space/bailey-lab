import { useMemo, useState } from 'react';
import {
  Check,
  ChevronsUpDown,
  Folder,
  FolderOpen,
  Plus,
  Search,
} from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { NewBusinessProcessDialog } from '@/components/workspace/NewBusinessProcessDialog';
import { cn } from '@/lib/utils';
import type { BusinessProcess } from '@/types';

interface BpSwitcherProps {
  bps: BusinessProcess[];
  // eslint-disable-next-line no-restricted-syntax -- null = no BP selected yet
  activeBpId: string | null;
  onSelect: (id: string) => void;
  /** Fired after a new BP is created — selects it and focuses its
   *  Description tab. Falls back to onSelect when not provided. */
  onCreated?: (name: string) => void;
  /** New BPs are created in the selected copy; the footer button is
   *  hidden when no copy is selected. */
  // eslint-disable-next-line no-restricted-syntax -- null = no copy selected
  copy: string | null;
}

/** Top-bar business-process switcher: searchable popover + "+ New BP". */
export function BpSwitcher({ bps, activeBpId, onSelect, onCreated, copy }: BpSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);

  const active = bps.find((b) => b.id === activeBpId);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return bps;
    return bps.filter((b) => b.name.toLowerCase().includes(q));
  }, [bps, query]);

  const select = (id: string) => {
    onSelect(id);
    setOpen(false);
    setQuery('');
  };

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setQuery('');
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            title="Switch business process"
            className={cn(
              'inline-flex h-[34px] items-center gap-2 rounded-lg border border-border bg-background py-0 pl-3 pr-2.5 transition-colors hover:bg-muted/60',
              open && 'bg-muted/60',
            )}
          >
            <FolderOpen className="size-3.5 shrink-0 text-primary" aria-hidden />
            <span className="mr-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Business process
            </span>
            <span className="max-w-60 truncate text-[13px] font-semibold text-foreground">
              {active?.name ?? '—'}
            </span>
            <ChevronsUpDown className="size-3.5 text-muted-foreground" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={6} className="w-[360px] p-0">
          <div className="border-b border-border p-2">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && filtered[0]) select(filtered[0].id);
                }}
                placeholder="Search business processes…"
                className="h-8 pl-8 text-xs"
              />
            </div>
          </div>
          <div className="max-h-72 space-y-0.5 overflow-auto p-1.5">
            {filtered.length === 0 ? (
              <div className="px-2.5 py-2 text-xs text-muted-foreground">
                {bps.length === 0 ? 'No business processes yet' : 'No matches'}
              </div>
            ) : (
              filtered.map((b) => {
                const isActive = b.id === activeBpId;
                const IconCmp = isActive ? FolderOpen : Folder;
                return (
                  <button
                    key={b.id}
                    onClick={() => select(b.id)}
                    className={cn(
                      'flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm transition-colors',
                      isActive ? 'bg-muted text-foreground' : 'hover:bg-muted/60',
                    )}
                  >
                    <IconCmp
                      className={cn(
                        'size-3.5 shrink-0',
                        isActive ? 'text-primary' : 'text-muted-foreground',
                      )}
                      aria-hidden
                    />
                    <span className="flex-1 truncate">{b.name}</span>
                    {isActive && (
                      <Check className="size-3.5 shrink-0 text-primary" aria-hidden />
                    )}
                  </button>
                );
              })
            )}
          </div>
          {copy && (
            <div className="border-t border-border p-1.5">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setDialogOpen(true);
                }}
                title={`New business process in copy "${copy}"`}
                className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              >
                <Plus className="size-3.5" aria-hidden />
                New business process
              </button>
            </div>
          )}
        </PopoverContent>
      </Popover>

      <NewBusinessProcessDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        copy={copy ?? undefined}
        existingNames={bps.map((b) => b.name)}
        onCreated={(name) => (onCreated ?? onSelect)(name)}
      />
    </>
  );
}

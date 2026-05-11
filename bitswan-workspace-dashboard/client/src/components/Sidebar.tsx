import { useMemo, useState } from 'react';
import { Folder, FolderOpen, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { BusinessProcess } from '@/types';

interface SidebarProps {
  bps: BusinessProcess[];
  activeBpId: string | null;
  onSelect: (id: string) => void;
}

export function Sidebar({ bps, activeBpId, onSelect }: SidebarProps) {
  const [query, setQuery] = useState('');
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

      <div className="flex items-center justify-between px-3.5 pb-1 pt-1.5">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Business Processes
        </div>
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
    </aside>
  );
}

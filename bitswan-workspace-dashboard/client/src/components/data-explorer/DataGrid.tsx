import { ArrowDown, ArrowUp, Loader2 } from 'lucide-react';
import type { SqlColumn } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Props {
  columns: SqlColumn[];
  // eslint-disable-next-line no-restricted-syntax -- wire-mirror: SQL NULL cells
  rows: Record<string, string | null>[];
  // eslint-disable-next-line no-restricted-syntax -- null = unsorted
  sort: string | null;
  dir: 'asc' | 'desc';
  /** Header click: cycles asc → desc → none (server-side sort only). */
  onSort: (column: string) => void;
  loading: boolean;
}

/**
 * Presentational read-only results grid for the SQL explorer. Cells arrive
 * text-cast and server-truncated; NULLs render as a muted italic marker.
 */
export function DataGrid({ columns, rows, sort, dir, onSort, loading }: Props) {
  return (
    <div className="relative min-h-0 flex-1 overflow-auto">
      {loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60">
          <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
        </div>
      )}
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 z-[1] bg-muted/90 backdrop-blur">
          <tr>
            {columns.map((c) => (
              <th
                key={c.name}
                className="whitespace-nowrap border-b border-border px-3 py-2 text-left align-bottom"
              >
                <button
                  type="button"
                  onClick={() => onSort(c.name)}
                  className={cn(
                    'flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide',
                    sort === c.name ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                  title={`Sort by ${c.name}`}
                >
                  {c.name}
                  {sort === c.name &&
                    (dir === 'asc' ? (
                      <ArrowUp className="size-3" aria-hidden />
                    ) : (
                      <ArrowDown className="size-3" aria-hidden />
                    ))}
                </button>
                <span className="block text-[9px] font-normal normal-case text-muted-foreground/60">
                  {c.type}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            // Rows have no stable identity (read-only page slice) — index is fine.
            <tr key={i} className="border-b border-border/60 hover:bg-muted/30">
              {columns.map((c) => {
                const v = row[c.name];
                return (
                  <td
                    key={c.name}
                    className="max-w-[28rem] truncate whitespace-nowrap px-3 py-1.5 font-mono text-foreground"
                    title={v ?? undefined}
                  >
                    {v === null || v === undefined ? (
                      <span className="italic text-muted-foreground/60">NULL</span>
                    ) : (
                      v
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {!loading && rows.length === 0 && (
        <div className="px-4 py-10 text-center text-xs text-muted-foreground">
          This table has no rows.
        </div>
      )}
    </div>
  );
}

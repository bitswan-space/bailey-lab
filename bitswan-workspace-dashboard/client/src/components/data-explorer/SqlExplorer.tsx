import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, RefreshCw, Table2 } from 'lucide-react';
import {
  api,
  type DataOverview,
  type DataScope,
  type SqlRowsPage,
  type SqlTable,
} from '@/lib/api';
import { setUrlParams, useUrlEnum, useUrlParam } from '@/lib/urlState';
import { EmptyState } from '@/components/shared/EmptyState';
import { cn } from '@/lib/utils';
import { DataGrid } from './DataGrid';
import { fmtBytes, fmtRowEstimate } from './format';

const PAGE_SIZE = 50;

interface Props {
  scope: DataScope;
  active: boolean;
}

/**
 * Read-only SQL explorer: the deployment's per-BP database — table list in a
 * left sidebar, paginated sortable rows on the right. No free-form SQL; the
 * server runs everything as the SELECT-only `ro_` role. Deep-linked via
 * `?table=&page=&sort=&dir=`.
 */
export function SqlExplorer({ scope, active }: Props) {
  // eslint-disable-next-line no-restricted-syntax -- null = probe not finished
  const [overview, setOverview] = useState<DataOverview | null | 'missing'>(null);
  // eslint-disable-next-line no-restricted-syntax -- null = not loaded yet
  const [tables, setTables] = useState<SqlTable[] | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- null = no page yet
  const [page, setPage] = useState<SqlRowsPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  const [tableParam] = useUrlParam('table');
  const [pageParam, setPageParam] = useUrlParam('page');
  const [sortParam] = useUrlParam('sort');
  const [dir] = useUrlEnum('dir', ['asc', 'desc'] as const, 'asc');
  const pageNo = Math.max(1, Number(pageParam) || 1);

  const scopeKey = `${scope.bp} ${scope.stage} ${scope.copy ?? ''}`;

  // Probe + table list.
  useEffect(() => {
    if (!active) return;
    let alive = true;
    setError('');
    setTables(null);
    setOverview(null);
    (async () => {
      try {
        const ov = await api.data.overview(scope);
        if (!alive) return;
        setOverview(ov ?? 'missing');
        if (!ov?.postgres.enabled || !ov.postgres.running || !ov.registered) return;
        const r = await api.data.sqlTables(scope);
        if (!alive) return;
        setTables(r?.tables ?? []);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scopeKey covers scope
  }, [scopeKey, active, reload]);

  // Keep a valid table selection.
  const table = useMemo(() => {
    if (!tables?.length) return '';
    return tableParam && tables.some((t) => t.name === tableParam)
      ? tableParam
      : (tables[0]?.name ?? '');
  }, [tables, tableParam]);

  // Rows page.
  useEffect(() => {
    if (!active || !table) return;
    let alive = true;
    setLoading(true);
    api.data
      .sqlRows(scope, table, {
        limit: PAGE_SIZE,
        offset: (pageNo - 1) * PAGE_SIZE,
        ...(sortParam ? { sort: sortParam, order: dir } : {}),
      })
      .then((r) => {
        if (!alive) return;
        setPage(r);
        setError('');
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scopeKey covers scope
  }, [scopeKey, active, table, pageNo, sortParam, dir, reload]);

  const selectTable = (name: string) =>
    setUrlParams({ table: name, page: null, sort: null, dir: null });

  const cycleSort = (column: string) => {
    if (sortParam !== column) {
      setUrlParams({ sort: column, dir: null, page: null });
    } else if (dir === 'asc') {
      setUrlParams({ dir: 'desc', page: null });
    } else {
      setUrlParams({ sort: null, dir: null, page: null });
    }
  };

  const selected = tables?.find((t) => t.name === table);

  const gate = explorerGate(overview, 'postgres', error, () => setReload((n) => n + 1));
  if (gate) return gate;

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Left: table list */}
      <aside className="flex w-[220px] shrink-0 flex-col border-r border-border bg-background">
        <div className="flex items-center gap-1.5 border-b border-border px-3.5 py-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Tables
          <span className="ml-auto font-medium text-muted-foreground/60">
            {tables?.length ?? '…'}
          </span>
        </div>
        <div className="flex-1 overflow-auto">
          {!tables ? (
            <div className="flex justify-center py-8">
              <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
            </div>
          ) : tables.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-muted-foreground">
              No tables yet.
            </div>
          ) : (
            tables.map((t) => (
              <button
                key={t.name}
                onClick={() => selectTable(t.name)}
                className={cn(
                  'flex w-full items-center gap-2 border-l-2 px-3 py-2 text-left',
                  t.name === table
                    ? 'border-foreground bg-muted/60'
                    : 'border-transparent hover:bg-muted/40',
                )}
                title={`${t.kind} · ${fmtBytes(t.total_bytes)}`}
              >
                <Table2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="flex-1 truncate font-mono text-xs text-foreground">{t.name}</span>
              </button>
            ))
          )}
        </div>
      </aside>

      {/* Right: grid */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
          <div className="min-w-0">
            <div className="truncate font-mono text-sm font-semibold text-foreground">
              {table || 'No table'}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {overview && overview !== 'missing' && overview.postgres.database
                ? `${overview.postgres.database} · read-only`
                : 'read-only'}
              {selected ? ` · ${fmtRowEstimate(selected.row_estimate)} rows` : ''}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setReload((n) => n + 1)}
              title="Refresh"
              className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted"
            >
              <RefreshCw className="size-3" aria-hidden />
              Refresh
            </button>
          </div>
        </div>

        {error ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <div className="max-w-md text-xs text-red-600">{error}</div>
            <button
              type="button"
              onClick={() => setReload((n) => n + 1)}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
            >
              Retry
            </button>
          </div>
        ) : !table ? (
          <div className="p-6">
            <EmptyState message="No tables in this database yet." />
          </div>
        ) : (
          <>
            <DataGridLazy
              page={page}
              sort={sortParam}
              dir={dir}
              onSort={cycleSort}
              loading={loading}
            />
            <div className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
              <span>
                Rows {(pageNo - 1) * PAGE_SIZE + 1}–
                {(pageNo - 1) * PAGE_SIZE + (page?.rows.length ?? 0)}
              </span>
              <div className="ml-auto flex items-center gap-1.5">
                <PagerBtn
                  disabled={pageNo <= 1 || loading}
                  onClick={() => setPageParam(pageNo <= 2 ? null : String(pageNo - 1))}
                  icon={<ChevronLeft className="size-3.5" aria-hidden />}
                  label="Previous page"
                />
                <span className="min-w-8 text-center font-medium text-foreground">{pageNo}</span>
                <PagerBtn
                  disabled={!page?.has_more || loading}
                  onClick={() => setPageParam(String(pageNo + 1))}
                  icon={<ChevronRight className="size-3.5" aria-hidden />}
                  label="Next page"
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function DataGridLazy({
  page,
  sort,
  dir,
  onSort,
  loading,
}: {
  // eslint-disable-next-line no-restricted-syntax -- null = no page yet
  page: SqlRowsPage | null;
  // eslint-disable-next-line no-restricted-syntax -- null = unsorted
  sort: string | null;
  dir: 'asc' | 'desc';
  onSort: (c: string) => void;
  loading: boolean;
}) {
  if (!page) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
      </div>
    );
  }
  return (
    <DataGrid
      columns={page.columns}
      rows={page.rows}
      sort={sort}
      dir={dir}
      onSort={onSort}
      loading={loading}
    />
  );
}

function PagerBtn({
  disabled,
  onClick,
  icon,
  label,
}: {
  disabled: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="rounded-md border border-border p-1 text-foreground hover:bg-muted disabled:opacity-40"
    >
      {icon}
    </button>
  );
}

/**
 * Shared "can this explorer show anything at all" ladder. Returns a rendered
 * gate state, or null when the explorer should render its real UI.
 * Exported for ObjectBrowser (same ladder, different service).
 */
export function explorerGate(
  // eslint-disable-next-line no-restricted-syntax -- null = probe in flight
  overview: DataOverview | 'missing' | null,
  kind: 'postgres' | 'garage',
  error: string,
  retry: () => void,
  // eslint-disable-next-line no-restricted-syntax -- null = render the real UI
): React.ReactElement | null {
  const noun = kind === 'postgres' ? 'SQL database' : 'object storage';
  if (error && overview === null) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="max-w-md text-xs text-red-600">{error}</div>
        <button
          type="button"
          onClick={retry}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
        >
          Retry
        </button>
      </div>
    );
  }
  if (overview === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
      </div>
    );
  }
  if (overview === 'missing' || !overview.registered) {
    return (
      <div className="flex-1 p-6">
        <EmptyState
          message={
            <>
              This business process has no {kind === 'postgres' ? 'database' : 'object storage'}{' '}
              yet. Provision per-BP data services from the Backups tab.
            </>
          }
        />
      </div>
    );
  }
  const svc = overview[kind];
  if (!svc.enabled) {
    return (
      <div className="flex-1 p-6">
        <EmptyState message={`The ${noun} service isn't enabled for this stage.`} />
      </div>
    );
  }
  if (!svc.running) {
    return (
      <div className="flex-1 p-6">
        <EmptyState message={`The ${noun} service container isn't running.`} />
      </div>
    );
  }
  return null;
}

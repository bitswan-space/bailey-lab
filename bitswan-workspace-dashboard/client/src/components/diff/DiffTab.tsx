import { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useFileDiff } from '@/hooks/useFileDiff';
import { useCopyStatus } from '@/hooks/useCopyStatus';
import { DiffFileList } from './DiffFileList';
import { DiffView } from './DiffView';

interface Props {
  copy: string;
  /** When set, only show changes under this directory (e.g. the BP being
   *  synced) — the diff that will actually become main on Sync & Deploy. */
  pathPrefix?: string;
}

export function DiffTab({ copy, pathPrefix }: Props) {
  const { changed: allChanged, loading, refresh: refreshStatus } =
    useCopyStatus(copy);
  const changed = useMemo(
    () =>
      pathPrefix
        ? allChanged.filter(
            (c) => c.path === pathPrefix || c.path.startsWith(`${pathPrefix}/`),
          )
        : allChanged,
    [allChanged, pathPrefix],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const { diff, loading: diffLoading, refresh: refreshDiff } = useFileDiff(
    copy,
    selected,
  );

  // When the status list changes (focus refetch, refresh click) make sure
  // the selected file is still present; if not, drop the selection so we
  // don't show a stale diff.
  useEffect(() => {
    if (!selected) return;
    if (!changed.some((c) => c.path === selected)) {
      setSelected(null);
    }
  }, [changed, selected]);

  const totals = useMemo(() => {
    let adds = 0;
    let dels = 0;
    for (const c of changed) {
      adds += c.adds;
      dels += c.dels;
    }
    return { adds, dels };
  }, [changed]);

  const handleRefresh = () => {
    void refreshStatus();
    void refreshDiff();
  };

  return (
    <div className="flex h-full overflow-hidden bg-background">
      <aside className="flex w-[340px] shrink-0 flex-col border-r border-border bg-background">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {changed.length} {changed.length === 1 ? 'file' : 'files'}
            {totals.adds > 0 ? (
              <span className="ml-2 text-emerald-600">+{totals.adds}</span>
            ) : null}
            {totals.dels > 0 ? (
              <span className="ml-1 text-red-600">−{totals.dels}</span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Refresh"
          >
            <RefreshCw className="size-3.5" aria-hidden />
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          {loading && changed.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              Loading…
            </div>
          ) : changed.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              No changes in this copy.
            </div>
          ) : (
            <DiffFileList
              files={changed}
              selectedPath={selected}
              onSelect={setSelected}
            />
          )}
        </div>
      </aside>
      <main className="flex-1 overflow-hidden">
        <DiffView path={selected} diff={diff} loading={diffLoading} />
      </main>
    </div>
  );
}

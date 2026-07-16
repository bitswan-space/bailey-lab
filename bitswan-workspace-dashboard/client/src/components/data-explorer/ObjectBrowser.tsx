import { Fragment, useEffect, useState } from 'react';
import {
  ChevronRight,
  Database,
  File as FileIcon,
  Folder,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { api, type DataOverview, type DataScope, type ObjectListing } from '@/lib/api';
import { setUrlParams, useUrlParam } from '@/lib/urlState';
import { EmptyState } from '@/components/shared/EmptyState';
import { cn } from '@/lib/utils';
import { explorerGate } from './SqlExplorer';
import { ObjectPreviewPane } from './ObjectPreviewPane';
import { fmtBytes, fmtDate } from './format';

interface Props {
  scope: DataScope;
  active: boolean;
}

/**
 * Read-only object-storage browser: the deployment's per-BP bucket with
 * prefix-based folder navigation (breadcrumbs; folder clicks push history so
 * Back walks up), inline preview and download. Deep-linked via `?prefix=&obj=`.
 */
export function ObjectBrowser({ scope, active }: Props) {
  // eslint-disable-next-line no-restricted-syntax -- null = probe not finished
  const [overview, setOverview] = useState<DataOverview | null | 'missing'>(null);
  // eslint-disable-next-line no-restricted-syntax -- null = loading; 'missing' = no bucket
  const [listing, setListing] = useState<ObjectListing | null | 'missing'>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  const [prefixParam] = useUrlParam('prefix');
  const [objParam, setObjParam] = useUrlParam('obj');
  const prefix = prefixParam ?? '';

  const scopeKey = `${scope.bp} ${scope.stage} ${scope.copy ?? ''}`;

  useEffect(() => {
    if (!active) return;
    let alive = true;
    setError('');
    setListing(null);
    setOverview(null);
    (async () => {
      try {
        const ov = await api.data.overview(scope);
        if (!alive) return;
        setOverview(ov ?? 'missing');
        if (!ov?.garage.enabled || !ov.garage.running || !ov.registered) return;
        const r = await api.data.objects(scope, prefix);
        if (!alive) return;
        setListing(r ?? 'missing');
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scopeKey covers scope
  }, [scopeKey, active, prefix, reload]);

  const setPrefix = (p: string) =>
    setUrlParams({ prefix: p || null, obj: null }, { push: true });

  const crumbs = prefix.split('/').filter(Boolean);

  const gate = explorerGate(overview, 'garage', error, () => setReload((n) => n + 1));
  if (gate) return gate;

  const bucket =
    overview && overview !== 'missing' ? (overview.garage.bucket ?? '') : '';

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {/* Toolbar: breadcrumbs + refresh */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-4 py-2.5 text-xs">
        <button
          type="button"
          onClick={() => setPrefix('')}
          className={cn(
            'flex shrink-0 items-center gap-1.5 font-mono',
            prefix ? 'text-muted-foreground hover:text-foreground' : 'font-semibold text-foreground',
          )}
          title={bucket}
        >
          <Database className="size-3.5" aria-hidden />
          {bucket || 'bucket'}
        </button>
        {crumbs.map((seg, i) => {
          const upto = `${crumbs.slice(0, i + 1).join('/')}/`;
          const last = i === crumbs.length - 1;
          return (
            <Fragment key={upto}>
              <ChevronRight className="size-3 shrink-0 text-muted-foreground/50" aria-hidden />
              <button
                type="button"
                onClick={() => setPrefix(upto)}
                className={cn(
                  'shrink-0 font-mono',
                  last
                    ? 'font-semibold text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {seg}
              </button>
            </Fragment>
          );
        })}
        <div className="ml-auto flex shrink-0 items-center gap-2 pl-3">
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

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Listing */}
        <div className="min-h-0 flex-1 overflow-auto">
          {error ? (
            <div className="flex flex-col items-center gap-3 p-6 text-center">
              <div className="max-w-md text-xs text-red-600">{error}</div>
              <button
                type="button"
                onClick={() => setReload((n) => n + 1)}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
              >
                Retry
              </button>
            </div>
          ) : listing === null ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
            </div>
          ) : listing === 'missing' ? (
            <div className="p-6">
              <EmptyState message="This business process has no bucket yet. Provision per-BP data services from the Backups tab." />
            </div>
          ) : listing.entries.length === 0 ? (
            <div className="p-6">
              <EmptyState message={prefix ? 'This folder is empty.' : 'This bucket is empty.'} />
            </div>
          ) : (
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 z-[1] bg-muted/90 backdrop-blur">
                <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="border-b border-border px-4 py-2">Name</th>
                  <th className="w-28 border-b border-border px-3 py-2">Size</th>
                  <th className="w-44 border-b border-border px-3 py-2">Modified</th>
                </tr>
              </thead>
              <tbody>
                {listing.entries.map((e) => {
                  const fullKey = prefix + e.key;
                  const name = e.type === 'folder' ? e.key.replace(/\/$/, '') : e.key;
                  const isSel = e.type === 'file' && objParam === fullKey;
                  return (
                    <tr
                      key={fullKey}
                      className={cn(
                        'cursor-pointer border-b border-border/60',
                        isSel ? 'bg-muted/60' : 'hover:bg-muted/30',
                      )}
                      onClick={() =>
                        e.type === 'folder' ? setPrefix(fullKey) : setObjParam(fullKey)
                      }
                    >
                      <td className="max-w-0 truncate px-4 py-2">
                        <span className="flex items-center gap-2">
                          {e.type === 'folder' ? (
                            <Folder className="size-3.5 shrink-0 text-blue-500" aria-hidden />
                          ) : (
                            <FileIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                          )}
                          <span className="truncate font-mono text-foreground">{name}</span>
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                        {e.type === 'folder' ? '—' : fmtBytes(e.size)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                        {e.type === 'folder' ? '—' : fmtDate(e.last_modified)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Preview */}
        {objParam && (
          <ObjectPreviewPane scope={scope} objKey={objParam} onClose={() => setObjParam(null)} />
        )}
      </div>
    </div>
  );
}

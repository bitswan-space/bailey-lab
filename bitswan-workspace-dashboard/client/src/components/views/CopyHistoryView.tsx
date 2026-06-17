import { useEffect, useMemo, useState } from 'react';
import { Rocket } from 'lucide-react';
import { api, type CopyHistory, type HistoryCommit } from '@/lib/api';
import { cn } from '@/lib/utils';

function GraphRow({
  commit,
  side,
  tag,
  copyHereLabel,
}: {
  commit: HistoryCommit;
  side: 'left' | 'right';
  /** Branch label for this commit's tip (e.g. "main" or the copy name), shown
   *  as a pill right on the commit so the label is visibly tied to it. */
  tag?: string;
  /** When set, this (main) commit is also where the copy currently points —
   *  show the copy label on the left even though they share the commit. */
  copyHereLabel?: string;
}) {
  const isLeft = side === 'left';
  return (
    <div className="relative py-2.5">
      {/* node on the centre line */}
      <span
        className={cn(
          'absolute left-1/2 top-3.5 size-2.5 -translate-x-1/2 rounded-full ring-2 ring-background',
          isLeft || copyHereLabel ? 'bg-emerald-500' : 'bg-primary',
        )}
        aria-hidden
      />
      {/* copy-is-here marker on the left when the copy shares this main commit */}
      {copyHereLabel ? (
        <div className="absolute left-0 top-2.5 w-1/2 pr-6 text-right">
          <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700">
            {copyHereLabel} is here
          </span>
        </div>
      ) : null}
      <div className={cn('w-1/2', isLeft ? 'pr-6 text-right' : 'ml-auto pl-6')}>
        <div
          className={cn(
            'flex items-baseline gap-2',
            isLeft && 'flex-row-reverse',
          )}
        >
          {tag ? (
            <span
              className={cn(
                'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                isLeft
                  ? 'bg-emerald-500/15 text-emerald-700'
                  : 'bg-primary/15 text-primary',
              )}
            >
              {tag}
            </span>
          ) : null}
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {commit.short}
          </span>
          <span className="truncate text-sm text-foreground">
            {commit.subject}
          </span>
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {commit.author_email} · {new Date(commit.date).toLocaleString()}
        </div>
        {(commit.deploys ?? []).map((d) => (
          <div
            key={d}
            className={cn(
              'mt-1 inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary',
            )}
          >
            <Rocket className="size-3" aria-hidden />
            {d}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Single-column commit graph around a centre line: this copy's own (un-merged)
 * commits branch to the LEFT, main's commits run down the RIGHT. Deploy markers
 * ("<email> deployed <date>") sit on the main commits each Sync & Deploy left
 * at the tip.
 */
export function CopyHistoryView({ copy }: { copy: string }) {
  // eslint-disable-next-line no-restricted-syntax -- null = not yet loaded
  const [data, setData] = useState<CopyHistory | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- null = no error
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    api.copyFiles
      .history(copy)
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [copy]);

  // The copy's own commits = those not yet on main. The rest of the copy's log
  // is shared history and shows on the main side below.
  const copyUnique = useMemo(() => {
    if (!data) return [];
    const onMain = new Set(data.main.map((c) => c.sha));
    return data.copy.filter((c) => !onMain.has(c.sha));
  }, [data]);

  // The copy's current tip. When it has no un-merged commits this sha is a main
  // commit, and we still want to show where the copy points — so mark that main
  // row with the copy label even though the two share the commit.
  const copyHeadOnMain = useMemo(() => {
    if (!data || copyUnique.length > 0) return null;
    return data.copy[0]?.sha ?? null;
  }, [data, copyUnique]);

  if (error) {
    return (
      <div className="p-6 text-sm text-destructive">
        Failed to load history: {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="p-6 text-sm text-muted-foreground">Loading history…</div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-background py-4">
      <div className="relative mx-auto max-w-3xl px-4">
        {/* centre line */}
        <span
          className="absolute bottom-0 top-0 w-0.5 -translate-x-1/2 bg-border"
          style={{ left: '50%' }}
          aria-hidden
        />
        {copyUnique.map((c, i) => (
          <GraphRow
            key={`copy-${c.sha}`}
            commit={c}
            side="left"
            tag={i === 0 ? copy : undefined}
          />
        ))}
        {data.main.map((c, i) => (
          <GraphRow
            key={`main-${c.sha}`}
            commit={c}
            side="right"
            tag={i === 0 ? 'main' : undefined}
            copyHereLabel={c.sha === copyHeadOnMain ? copy : undefined}
          />
        ))}
      </div>
    </div>
  );
}

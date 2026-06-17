import { useEffect, useState } from 'react';
import { Rocket } from 'lucide-react';
import { api, type CopyHistory, type HistoryCommit } from '@/lib/api';

function CommitRow({ commit }: { commit: HistoryCommit }) {
  return (
    <div className="border-b border-border px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {commit.short}
        </span>
        <span className="truncate text-sm text-foreground">{commit.subject}</span>
      </div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">
        {commit.author_email} · {new Date(commit.date).toLocaleString()}
      </div>
      {(commit.deploys ?? []).map((d) => (
        <div
          key={d}
          className="mt-1 inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary"
        >
          <Rocket className="size-3" aria-hidden />
          {d}
        </div>
      ))}
    </div>
  );
}

function Column({ title, commits }: { title: string; commits: HistoryCommit[] }) {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden bg-background">
      <div className="shrink-0 border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {commits.length === 0 ? (
          <div className="px-3 py-4 text-xs text-muted-foreground">No commits.</div>
        ) : (
          commits.map((c) => <CommitRow key={c.sha} commit={c} />)
        )}
      </div>
    </div>
  );
}

/**
 * Side-by-side commit history of this copy and main, with deploy markers
 * (`<email> deployed <date>`) on the main commits each Sync & Deploy left at
 * main's tip.
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
    api.copies
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
    <div className="grid min-h-0 flex-1 grid-cols-2 gap-px overflow-hidden bg-border">
      <Column title={`This copy · ${copy}`} commits={data.copy} />
      <Column title="main (deployed)" commits={data.main} />
    </div>
  );
}

import { useMemo } from 'react';

interface Props {
  /** Path of the file the diff is for; used only as a header hint. */
  path: string | null;
  diff: string;
  loading: boolean;
}

interface DiffLine {
  text: string;
  kind: 'add' | 'del' | 'hunk' | 'fileHeader' | 'meta' | 'context';
}

function classify(text: string): DiffLine['kind'] {
  if (text.startsWith('+++') || text.startsWith('---')) return 'fileHeader';
  if (text.startsWith('@@')) return 'hunk';
  if (text.startsWith('diff --git') || text.startsWith('index ') || text.startsWith('similarity ')) {
    return 'meta';
  }
  if (text.startsWith('+')) return 'add';
  if (text.startsWith('-')) return 'del';
  return 'context';
}

const STYLES: Record<DiffLine['kind'], string> = {
  add: 'bg-emerald-100 text-emerald-700',
  del: 'bg-red-100 text-red-700',
  hunk: 'bg-slate-100 text-sky-700',
  fileHeader: 'text-muted-foreground',
  meta: 'text-muted-foreground',
  context: 'text-foreground',
};

export function DiffView({ path, diff, loading }: Props) {
  const lines = useMemo<DiffLine[]>(() => {
    if (!diff) return [];
    return diff.split('\n').map((text) => ({ text, kind: classify(text) }));
  }, [diff]);

  if (!path) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a file to view its diff.
      </div>
    );
  }

  if (loading && lines.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading diff…
      </div>
    );
  }

  if (!loading && lines.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No changes in {path}.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 truncate border-b border-border px-4 py-2 font-mono text-[12px] text-muted-foreground">
        {path}
      </div>
      <div className="flex-1 overflow-auto bg-background">
        <pre className="m-0 font-mono text-[12px] leading-5">
          {lines.map((l, i) => (
            // eslint-disable-next-line react/no-array-index-key -- stable, lines don't reorder
            <div key={i} className={`whitespace-pre px-4 ${STYLES[l.kind]}`}>
              {l.text || ' '}
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

import type { ChangedFile, ChangedKind } from '@/lib/api';

interface Props {
  files: ChangedFile[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

const KIND_STYLES: Record<ChangedKind, string> = {
  A: 'bg-emerald-100 text-emerald-700',
  M: 'bg-amber-100 text-amber-700',
  D: 'bg-red-100 text-red-700',
};

export function DiffFileList({ files, selectedPath, onSelect }: Props) {
  return (
    <div className="flex flex-col">
      {files.map((f) => {
        const selected = selectedPath === f.path;
        return (
          <button
            key={f.path}
            type="button"
            onClick={() => onSelect(f.path)}
            className={`flex w-full items-start gap-2 border-b border-border px-3 py-2 text-left transition-colors ${
              selected ? 'bg-muted/60' : 'hover:bg-muted/30'
            }`}
          >
            <span
              className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-bold ${KIND_STYLES[f.kind]}`}
            >
              {f.kind}
            </span>
            <div className="min-w-0 flex-1">
              {/* Right-align the path so the filename (leaf) stays visible when truncated. */}
              <div
                className="truncate text-right font-mono text-[12px]"
                dir="rtl"
                title={f.path}
              >
                {/* The bidi-isolate wrapper keeps the path readable left-to-right
                    inside an RTL container. */}
                <bdi>{f.path}</bdi>
              </div>
              <div className="text-right text-[11px] text-muted-foreground">
                {f.adds > 0 ? (
                  <span className="text-emerald-600">+{f.adds}</span>
                ) : null}
                {f.adds > 0 && f.dels > 0 ? ' · ' : ''}
                {f.dels > 0 ? <span className="text-red-600">−{f.dels}</span> : null}
                {f.adds === 0 && f.dels === 0 ? '—' : null}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

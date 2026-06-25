import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { Clipboard, Loader2 } from 'lucide-react';
import { toast } from '@/lib/notify';
import {
  api,
  type FileContentResponse,
  type FileEtag,
} from '@/lib/api';

// CodeMirror lives in its own chunk so the initial dashboard bundle
// doesn't pay for the editor unless someone opens a file.
const CodeEditor = lazy(() => import('./CodeEditor'));

interface Props {
  copy: string;
  path: string | null;
  data: FileContentResponse | null;
  loading: boolean;
  /** Called after a successful save so the parent can refresh status/tree. */
  onAfterSave?: () => void;
  /**
   * Suppress focus-driven re-fetches while the editor has unsaved
   * changes. Wired by the parent via `useFileContent.setRefetchPaused`.
   */
  setRefetchPaused?: (paused: boolean) => void;
}

/**
 * Idle-debounce: save the buffer this long after the user stops typing.
 * Combined with save-on-blur and Cmd+S keeps the experience predictable
 * without a flood of writes during fast typing.
 */
const AUTOSAVE_IDLE_MS = 2000;

type SaveState =
  | { kind: 'clean' }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'error'; message: string }
  | { kind: 'conflict' };

export function FileViewer({
  copy,
  path,
  data,
  loading,
  onAfterSave,
  setRefetchPaused,
}: Props) {
  // Local buffer copy. Reset whenever the underlying file (path) or its
  // canonical content changes (e.g. parent reloaded after a refresh).
  const [buffer, setBuffer] = useState<string>('');
  const [etag, setEtag] = useState<FileEtag | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: 'clean' });

  // Keep latest values in refs for the timer callback so we don't have to
  // re-arm the timer on every keystroke.
  const bufferRef = useRef(buffer);
  bufferRef.current = buffer;
  const etagRef = useRef(etag);
  etagRef.current = etag;

  // Reset state on file change / refresh.
  useEffect(() => {
    if (data && 'content' in data) {
      setBuffer(data.content);
      setEtag(data.etag);
      setSave({ kind: 'clean' });
    } else {
      setBuffer('');
      setEtag(null);
      setSave({ kind: 'clean' });
    }
  }, [data, path]);

  const dirty = save.kind === 'dirty' || save.kind === 'saving' || save.kind === 'error' || save.kind === 'conflict';

  // Hand the dirty flag up so the focus refetch can bail.
  useEffect(() => {
    setRefetchPaused?.(dirty);
    return () => setRefetchPaused?.(false);
  }, [dirty, setRefetchPaused]);

  const doSave = useCallback(async () => {
    if (!path) return;
    const content = bufferRef.current;
    const currentEtag = etagRef.current;
    setSave({ kind: 'saving' });
    try {
      const r = await api.copyFiles.save(copy, path, {
        content,
        ...(currentEtag ? { etag: currentEtag } : {}),
      });
      if ('ok' in r) {
        setEtag(r.etag);
        setSave({ kind: 'saved', at: Date.now() });
        onAfterSave?.();
      } else if (r.error === 'conflict') {
        setSave({ kind: 'conflict' });
        toast.error(
          'This file changed on disk while you were editing it. Reload to merge.',
        );
      } else {
        const message =
          r.error === 'too-large'
            ? 'File exceeds 1 MiB limit.'
            : r.error === 'binary'
              ? 'Refusing to overwrite a binary file as text.'
              : r.error === 'not-found'
                ? 'File no longer exists on disk.'
                : `Save failed: ${r.error}`;
        setSave({ kind: 'error', message });
        toast.error(message);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSave({ kind: 'error', message });
      toast.error(`Save failed: ${message}`);
    }
  }, [copy, path, onAfterSave]);

  // Idle debounce: arm a save timer when `dirty` flips on, reset it on
  // every keystroke. Cleared on unmount or successful save.
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (save.kind !== 'dirty') return;
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      void doSave();
    }, AUTOSAVE_IDLE_MS);
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [save.kind, buffer, doSave]);

  const reload = useCallback(() => {
    if (!data || 'error' in data) return;
    setBuffer(data.content);
    setEtag(data.etag);
    setSave({ kind: 'clean' });
  }, [data]);

  const copyRef = () => {
    if (!path) return;
    void navigator.clipboard?.writeText(path).then(
      () => toast.success(`Copied ${path}`),
      () => toast.error('Clipboard not available'),
    );
  };

  if (!path) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Pick a file from the tree to view its contents.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 font-mono text-[12px] text-muted-foreground">
          {dirty ? (
            <span
              className="size-1.5 shrink-0 rounded-full bg-amber-500"
              aria-label="unsaved changes"
              title="Unsaved changes"
            />
          ) : null}
          <span className="min-w-0 truncate">{path}</span>
          <SaveStatus state={save} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => void doSave()}
            disabled={!dirty || save.kind === 'saving'}
            className="inline-flex h-7 items-center gap-1.5 rounded border border-border bg-background px-2 text-[11px] hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            title="Save (⌘/Ctrl+S)"
          >
            {save.kind === 'saving' ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : null}
            Save
          </button>
          <button
            type="button"
            onClick={copyRef}
            className="inline-flex h-7 items-center gap-1.5 rounded border border-border bg-background px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Copy file reference"
          >
            <Clipboard className="size-3.5" aria-hidden /> Copy reference
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        {loading && !data ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Loading…
          </div>
        ) : !data ? null : 'error' in data ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {data.error === 'binary'
              ? 'Binary file — not displayed.'
              : data.error === 'too-large'
                ? 'File is larger than 1 MiB — not displayed.'
                : data.error === 'not-found'
                  ? 'File not found.'
                  : `Couldn't read: ${data.error}`}
          </div>
        ) : (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Loading editor…
              </div>
            }
          >
            <CodeEditor
              value={buffer}
              path={path}
              onChange={(next) => {
                setBuffer(next);
                setSave((s) =>
                  s.kind === 'saving' ? s : { kind: 'dirty' },
                );
              }}
              onSave={() => void doSave()}
            />
          </Suspense>
        )}
      </div>
      {save.kind === 'conflict' ? (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-amber-50 px-4 py-2 text-[12px] text-amber-900">
          <span>
            This file was edited elsewhere since you opened it. Discard your
            edits and reload?
          </span>
          <button
            type="button"
            onClick={reload}
            className="rounded border border-amber-300 bg-amber-100 px-2 py-0.5 text-[11px] hover:bg-amber-200"
          >
            Reload from disk
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SaveStatus({ state }: { state: SaveState }) {
  if (state.kind === 'saving') return <span className="text-muted-foreground">Saving…</span>;
  if (state.kind === 'saved') {
    const ts = new Date(state.at).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    return <span className="text-emerald-600">Saved {ts}</span>;
  }
  if (state.kind === 'error') return <span className="text-destructive">{state.message}</span>;
  if (state.kind === 'conflict') return <span className="text-amber-700">Conflict</span>;
  if (state.kind === 'dirty') return <span className="text-amber-700">Unsaved</span>;
  return null;
}

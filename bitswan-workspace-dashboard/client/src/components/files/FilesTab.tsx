import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, File as FileIcon, RefreshCw, Search, Upload, X } from 'lucide-react';
import { useDropzone, type DropEvent } from 'react-dropzone';
import { toast } from '@/lib/notify';
import { api, type ChangedKind, type FileSearchMatch } from '@/lib/api';
import { useUrlParam } from '@/lib/urlState';
import { useFileContent } from '@/hooks/useFileContent';
import { useFileTree } from '@/hooks/useFileTree';
import { useCopyStatus } from '@/hooks/useCopyStatus';
import { FileTree } from './FileTree';
import { FileViewer } from './FileViewer';

interface Props {
  copy: string;
  /**
   * Currently-selected business process. When set, the explorer "cd"s
   * into that folder: only its contents render, uploads default to it,
   * and a breadcrumb points it out. Falsy → show the whole copy.
   */
  bp?: string | null;
}

const SEARCH_KIND_STYLES: Record<ChangedKind, string> = {
  A: 'bg-emerald-100 text-emerald-700',
  M: 'bg-amber-100 text-amber-700',
  D: 'bg-red-100 text-red-700',
};

/** Split `text` around case-insensitive occurrences of `q` so the matched
 *  substrings can be emphasised in a search result line. */
function highlight(text: string, q: string): React.ReactNode {
  if (!q) return text;
  const out: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let i = 0;
  let k = 0;
  for (;;) {
    const hit = lower.indexOf(needle, i);
    if (hit < 0) {
      out.push(text.slice(i));
      break;
    }
    if (hit > i) out.push(text.slice(i, hit));
    out.push(
      <mark key={k++} className="rounded-sm bg-amber-200 text-foreground">
        {text.slice(hit, hit + needle.length)}
      </mark>,
    );
    i = hit + needle.length;
  }
  return out;
}

/**
 * Copy file explorer: 280 px tree on the left, content viewer on the
 * right. Status badges on the tree come from the same `/status` endpoint
 * the Diff tab uses, merged in by path. The tree pane doubles as a drop
 * target for file uploads. A search box runs a full-text search across the
 * copy's files (server-side grep) and lists matching lines grouped by file.
 */
export function FilesTab({ copy, bp }: Props) {
  const { tree, loading: treeLoading, refresh: refreshTree } = useFileTree(copy);
  const { changed, refresh: refreshStatus } = useCopyStatus(copy);
  // The open file lives in the URL (?file=…) so the Files view is deep-linkable.
  const [openPath, setOpenPath] = useUrlParam('file');
  const {
    data,
    loading: contentLoading,
    refresh: refreshContent,
    setRefetchPaused,
  } = useFileContent(copy, openPath);

  // Lets the user pop out of BP scope back to the full copy view
  // without having to deselect the BP in the sidebar. Reset whenever
  // the user navigates to a different BP / copy so each cd starts
  // scoped again.
  const [showFullTree, setShowFullTree] = useState(false);
  // Explorer search query — filters all files (by path) into a flat list.
  const [query, setQuery] = useState('');
  // Reset the scope toggle, search, and open file when the user switches BP
  // or copy — but NOT on the initial mount, so a pasted ?file=… link opens.
  const resetReady = useRef(false);
  useEffect(() => {
    if (!resetReady.current) {
      resetReady.current = true;
      return;
    }
    setShowFullTree(false);
    setQuery('');
    setOpenPath(null);
  }, [bp, copy, setOpenPath]);

  // Resolve the BP folder in the current tree. If the BP doesn't exist
  // as a top-level folder yet (e.g. brand-new BP with no files), or the
  // user has popped back to the full tree, we fall through to the
  // unscoped view so they're never stuck staring at "No files".
  const { displayTree, rootDir } = useMemo(() => {
    if (!bp || showFullTree) return { displayTree: tree, rootDir: '' };
    const folder = tree.find((n) => n.kind === 'folder' && n.name === bp);
    if (!folder) return { displayTree: tree, rootDir: '' };
    return { displayTree: folder.children ?? [], rootDir: bp };
  }, [tree, bp, showFullTree]);

  const statusByPath = useMemo<Map<string, ChangedKind>>(() => {
    const out = new Map<string, ChangedKind>();
    for (const c of changed) out.set(c.path, c.kind);
    return out;
  }, [changed]);

  // Full-text search: a debounced server-side grep across the copy's files
  // (scoped to the BP folder when cd'd in). `results === null` means "not
  // searching" (show the tree).
  const [results, setResults] = useState<{
    matches: FileSearchMatch[];
    truncated: boolean;
  } | null>(null);
  const [searching, setSearching] = useState(false);
  const trimmedQuery = query.trim();
  useEffect(() => {
    if (!trimmedQuery) {
      setResults(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const id = setTimeout(() => {
      api.copyFiles
        .search(copy, trimmedQuery, rootDir || undefined)
        .then((r) => {
          if (!cancelled) setResults(r);
        })
        .catch(() => {
          if (!cancelled) setResults({ matches: [], truncated: false });
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [trimmedQuery, copy, rootDir]);

  // Group consecutive matches by file (the server walks file-by-file, so
  // same-file lines already arrive contiguously).
  const resultGroups = useMemo(() => {
    if (!results) return null;
    const groups: { path: string; lines: FileSearchMatch[] }[] = [];
    for (const m of results.matches) {
      const last = groups[groups.length - 1];
      if (last && last.path === m.path) last.lines.push(m);
      else groups.push({ path: m.path, lines: [m] });
    }
    return groups;
  }, [results]);

  // Upload target for the **click** path (the Upload button → OS picker)
  // is the directory the currently-open file lives in, or — when no file
  // is open — the scoped root (BP folder when cd'd in, copy root
  // otherwise). The **drag-drop** path uses whatever folder the user is
  // hovering over instead — see `dragHoverFolder` below.
  const uploadDir = useMemo(() => {
    if (!openPath) return rootDir;
    const i = openPath.lastIndexOf('/');
    return i < 0 ? rootDir : openPath.slice(0, i);
  }, [openPath, rootDir]);

  // `dragHoverFolder` is the folder row the user is currently dragging
  // over. `''` is the panel root (set by file rows / empty space when
  // a drag is in progress); `null` means no drag.
  const [dragHoverFolder, setDragHoverFolderState] = useState<string | null>(null);
  // A ref shadow so the dropzone's `onDrop` (whose closure is captured
  // at hook-setup time) can read the latest value without re-creating
  // the dropzone on every drag step.
  const dragHoverRef = useRef<string | null>(null);
  const setDragHoverFolder = useCallback((p: string | null) => {
    dragHoverRef.current = p;
    setDragHoverFolderState(p);
  }, []);

  const performUpload = useCallback(
    async (accepted: File[], dest: string) => {
      try {
        const r = await api.copyFiles.upload(copy, dest, accepted);
        const count = r.written.length;
        const where = dest ? `/${dest}` : ' the copy root';
        toast.success(
          `Uploaded ${count} file${count === 1 ? '' : 's'} to${where}`,
        );
        void refreshTree();
        void refreshStatus();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(`Upload failed: ${message}`);
      }
    },
    [copy, refreshTree, refreshStatus],
  );

  const onDrop = useCallback(
    async (accepted: File[], _rej: unknown, event?: DropEvent) => {
      if (accepted.length === 0) {
        setDragHoverFolder(null);
        return;
      }
      // `event` is a DragEvent for drag-drops and a synthetic Change
      // event when triggered by the OS file picker (the Upload button).
      // For drags we use the latest hovered folder; if the user dropped
      // on a file row or empty space (hover==='') we fall back to the
      // panel's scoped root (BP folder when cd'd in).
      const isDrag = !!event && 'dataTransfer' in event;
      const dest = isDrag ? (dragHoverRef.current || rootDir) : uploadDir;
      await performUpload(accepted, dest);
      setDragHoverFolder(null);
    },
    [rootDir, uploadDir, performUpload, setDragHoverFolder],
  );

  // `noClick`/`noKeyboard` keep the dropzone from intercepting clicks on
  // tree rows — uploads happen via the Upload button (which calls `open`)
  // or by drag-and-drop. `onDragLeave` only fires when the drag actually
  // leaves the panel — useful for resetting the hover claim.
  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    onDragLeave: () => setDragHoverFolder(null),
    noClick: true,
    noKeyboard: true,
    multiple: true,
  });

  const handleRefresh = () => {
    void refreshTree();
    void refreshStatus();
  };

  const dropOverlayTarget = dragHoverFolder || rootDir;
  const uploadButtonTitle = `Upload to ${uploadDir ? '/' + uploadDir : 'copy root'}`;

  return (
    <div className="flex h-full overflow-hidden bg-background">
      <aside
        {...getRootProps()}
        className="relative flex w-[280px] shrink-0 flex-col border-r border-border bg-background outline-none"
      >
        <input {...getInputProps()} />
        <div className="flex shrink-0 items-center justify-between gap-1 border-b border-border px-3 py-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Explorer
            </div>
            {rootDir ? (
              <button
                type="button"
                onClick={() => setShowFullTree(true)}
                className="group inline-flex min-w-0 items-center gap-1 rounded px-1 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Show whole copy"
              >
                <ArrowUp className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
                <span className="truncate">/{rootDir}</span>
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={open}
              className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              title={uploadButtonTitle}
            >
              <Upload className="size-3.5" aria-hidden />
            </button>
            <button
              type="button"
              onClick={handleRefresh}
              className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Refresh"
            >
              <RefreshCw className="size-3.5" aria-hidden />
            </button>
          </div>
        </div>
        <div className="shrink-0 border-b border-border px-2 py-1.5">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search in files…"
              spellCheck={false}
              aria-label="Search in files"
              className="w-full rounded border border-input bg-background py-1 pl-7 pr-7 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                title="Clear search"
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-3" aria-hidden />
              </button>
            ) : null}
          </div>
        </div>
        <div className="flex-1 overflow-auto">
          {treeLoading && tree.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              Loading…
            </div>
          ) : trimmedQuery ? (
            !results ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                Searching…
              </div>
            ) : results.matches.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                No matches for “{trimmedQuery}”.
              </div>
            ) : (
              <div className="flex flex-col py-1 text-[13px]">
                {(resultGroups ?? []).map((g) => {
                  const kind = statusByPath.get(g.path);
                  const slash = g.path.lastIndexOf('/');
                  const name = slash < 0 ? g.path : g.path.slice(slash + 1);
                  const dir = slash < 0 ? '' : g.path.slice(0, slash);
                  return (
                    <div key={g.path} className="mb-1">
                      <button
                        type="button"
                        onClick={() => setOpenPath(g.path)}
                        title={g.path}
                        className="group flex w-full items-center gap-1.5 px-2 py-0.5 text-left hover:bg-muted/40"
                      >
                        <FileIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="min-w-0 flex-1 truncate font-medium">
                          {name}
                          {dir ? (
                            <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                              {dir}
                            </span>
                          ) : null}
                        </span>
                        {kind ? (
                          <span
                            className={`inline-flex h-4 items-center rounded px-1 text-[10px] font-semibold ${SEARCH_KIND_STYLES[kind]}`}
                          >
                            {kind}
                          </span>
                        ) : null}
                      </button>
                      {g.lines.map((m, i) => (
                        <button
                          key={`${m.line}:${i}`}
                          type="button"
                          onClick={() => setOpenPath(g.path)}
                          title={`${g.path}:${m.line}`}
                          className={`flex w-full items-baseline gap-2 rounded px-2 py-0.5 pl-7 text-left transition-colors ${
                            openPath === g.path ? 'bg-muted/60' : 'hover:bg-muted/40'
                          }`}
                        >
                          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                            {m.line}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                            {highlight(m.text, trimmedQuery)}
                          </span>
                        </button>
                      ))}
                    </div>
                  );
                })}
                {results.truncated ? (
                  <div className="px-3 py-2 text-center text-[11px] text-muted-foreground">
                    Showing the first {results.matches.length} matches — refine
                    your search.
                  </div>
                ) : null}
              </div>
            )
          ) : displayTree.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              {rootDir
                ? `No files in /${rootDir} yet.`
                : 'No files in this copy.'}
            </div>
          ) : (
            <FileTree
              // Re-key on the active scope (copy + BP + escape-hatch
              // toggle) so each navigation re-runs the rows' initial
              // `open` state — otherwise rows mounted under a previous
              // scope would hold onto their toggled state and the
              // explorer wouldn't follow the user's selection.
              key={`${copy}::${rootDir || ''}`}
              tree={displayTree}
              openPath={openPath}
              statusByPath={statusByPath}
              onOpen={setOpenPath}
              dragHoverFolder={dragHoverFolder}
              onDragHoverChange={setDragHoverFolder}
            />
          )}
        </div>
        {isDragActive ? (
          // When the user is hovering a specific folder, we let *that*
          // folder's own highlight be the visible target and dim the
          // panel-wide overlay so the row stays readable. When no folder
          // is hovered (file row / empty space), show the panel-root
          // overlay instead — which is the BP folder when we've cd'd in.
          <div
            className={`pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 text-center text-[12px] font-medium text-sky-900 ring-2 ring-inset ring-sky-400 ${
              dragHoverFolder ? 'bg-sky-50/40' : 'bg-sky-100/80'
            }`}
            aria-hidden
          >
            <Upload className="size-5" />
            <span>Drop files into</span>
            <span className="font-mono text-[11px]">
              {dropOverlayTarget ? `/${dropOverlayTarget}` : '/'}
            </span>
          </div>
        ) : null}
      </aside>
      <main className="flex-1 overflow-hidden">
        <FileViewer
          copy={copy}
          path={openPath}
          data={data}
          loading={contentLoading}
          setRefetchPaused={setRefetchPaused}
          onAfterSave={() => {
            // A save can move a previously-clean file into the M
            // bucket, change adds/dels, etc. Refresh both surfaces;
            // the editor's local etag is already updated in-component.
            void refreshStatus();
            void refreshContent();
          }}
        />
      </main>
    </div>
  );
}

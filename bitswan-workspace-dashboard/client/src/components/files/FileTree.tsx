import { useState } from 'react';
import { ChevronRight, File as FileIcon, Folder } from 'lucide-react';
import type { ChangedKind, FileTreeNode } from '@/lib/api';

interface Props {
  tree: FileTreeNode[];
  /** Currently-open file path; gets the selected-row styling. */
  openPath: string | null;
  /** Per-path A/M/D map merged from the status hook. */
  statusByPath: Map<string, ChangedKind>;
  onOpen: (path: string) => void;
  /**
   * The folder path the user is currently dragging files over — used to
   * highlight the row. Empty string means "the panel root" (the copy
   * root, or the BP folder when the parent has cd'd into it); `null`
   * means no drag in progress.
   */
  dragHoverFolder: string | null;
  /**
   * Called when the user drags into a row. `path` is the folder's path
   * for folders, or `null` for file rows (meaning "not a valid folder
   * target, fall back to the panel root"). Set via the row's `dragenter`.
   */
  onDragHoverChange: (path: string | null) => void;
}

const KIND_STYLES: Record<ChangedKind, string> = {
  A: 'bg-emerald-100 text-emerald-700',
  M: 'bg-amber-100 text-amber-700',
  D: 'bg-red-100 text-red-700',
};

export function FileTree({
  tree,
  openPath,
  statusByPath,
  onOpen,
  dragHoverFolder,
  onDragHoverChange,
}: Props) {
  return (
    <div className="flex flex-col py-1 text-[13px]">
      {tree.map((n) => (
        <FileTreeRow
          key={n.path}
          node={n}
          depth={0}
          openPath={openPath}
          statusByPath={statusByPath}
          onOpen={onOpen}
          dragHoverFolder={dragHoverFolder}
          onDragHoverChange={onDragHoverChange}
        />
      ))}
    </div>
  );
}

interface RowProps {
  node: FileTreeNode;
  depth: number;
  openPath: string | null;
  statusByPath: Map<string, ChangedKind>;
  onOpen: (path: string) => void;
  dragHoverFolder: string | null;
  onDragHoverChange: (path: string | null) => void;
}

function FileTreeRow({
  node,
  depth,
  openPath,
  statusByPath,
  onOpen,
  dragHoverFolder,
  onDragHoverChange,
}: RowProps) {
  // Default to expanded for top-level folders so the tree feels "alive"
  // on first render. Deeper folders start collapsed to keep the initial
  // view compact.
  const [open, setOpen] = useState(depth < 1);
  const indent = 8 + depth * 14;

  if (node.kind === 'folder') {
    const dragHovered = dragHoverFolder === node.path;
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          // Folder rows claim themselves as drop targets on dragenter; we
          // stopPropagation so the panel-level handler doesn't overwrite
          // with `null` (which would fall back to the copy root).
          onDragEnter={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDragHoverChange(node.path);
          }}
          // Repeat the claim on dragover — `dragenter` doesn't refire if
          // the user moves between this row's own descendants, so without
          // dragover the highlight would flicker on hover scroll.
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (dragHoverFolder !== node.path) onDragHoverChange(node.path);
          }}
          className={`group flex w-full items-center gap-1.5 rounded px-2 py-0.5 text-left transition-colors ${
            dragHovered ? 'bg-sky-100 ring-1 ring-inset ring-sky-400' : 'hover:bg-muted/40'
          }`}
          style={{ paddingLeft: indent }}
        >
          <ChevronRight
            className={`size-3 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`}
            aria-hidden
          />
          <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{node.name}</span>
        </button>
        {open &&
          (node.children ?? []).map((child) => (
            <FileTreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              openPath={openPath}
              statusByPath={statusByPath}
              onOpen={onOpen}
              dragHoverFolder={dragHoverFolder}
              onDragHoverChange={onDragHoverChange}
            />
          ))}
      </>
    );
  }

  const kind = statusByPath.get(node.path);
  const selected = openPath === node.path;
  return (
    <button
      type="button"
      onClick={() => onOpen(node.path)}
      // File rows aren't valid folder targets — clear any previous claim
      // so the upload falls back to the copy root.
      onDragEnter={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (dragHoverFolder !== '') onDragHoverChange('');
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (dragHoverFolder !== '') onDragHoverChange('');
      }}
      className={`group flex w-full items-center gap-1.5 rounded px-2 py-0.5 text-left transition-colors ${
        selected ? 'bg-muted/60' : 'hover:bg-muted/40'
      }`}
      style={{ paddingLeft: indent + 14 }}
    >
      <FileIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{node.name}</span>
      {kind ? (
        <span
          className={`inline-flex h-4 items-center rounded px-1 text-[10px] font-semibold ${KIND_STYLES[kind]}`}
        >
          {kind}
        </span>
      ) : null}
    </button>
  );
}

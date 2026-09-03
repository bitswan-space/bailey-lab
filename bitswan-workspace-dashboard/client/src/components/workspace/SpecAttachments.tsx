import { useCallback, useEffect, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import {
  ChevronDown,
  Download,
  Loader2,
  Paperclip,
  Trash2,
  Upload,
} from 'lucide-react';
import { toast } from '@/lib/notify';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { api, type FileTreeNode, type FileUploadResponse } from '@/lib/api';
import { cn } from '@/lib/utils';

interface SpecAttachmentsProps {
  /** BP directory name — attachments live at `<bp>/attachments/`. */
  bpId: string;
  copy: string;
}

export interface AttachmentRow {
  name: string;
  /** Copy-relative path, e.g. `my-bp/attachments/diagram.png`. */
  path: string;
}

export function formatByteSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 || unit === 0 ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded} ${units[unit]}`;
}

// Mounted panels register here so an upload made from somewhere else (the
// editor toolbar's insert-image popover, a pasted screenshot) shows up in
// the panel without the user having to reload the tab.
const changeListeners = new Set<() => void>();

/** Tell every mounted attachments panel to refetch its list. */
export function notifySpecAttachmentsChanged(): void {
  for (const listener of changeListeners) listener();
}

/**
 * Upload files into a BP's `attachments/` folder. The single upload path
 * for attachments — the panel below, the toolbar's insert-image popover
 * and paste-to-attach all go through here, so everything lands as a plain
 * file the coding agent sees under `attachments/`.
 *
 * A file whose name already exists is overwritten (the server writes by
 * basename), same as dropping it on the panel.
 */
export async function uploadSpecAttachments(
  copy: string,
  bpId: string,
  files: File[],
): Promise<FileUploadResponse> {
  const dir = `${bpId}/attachments`;
  const { maxBytes, maxBytesLabel } = await api.copyFiles.uploadLimit(copy, dir);
  const oversized = files.filter((f) => f.size > maxBytes);
  if (oversized.length > 0) {
    const names = oversized.map((f) => `${f.name} (${formatByteSize(f.size)})`).join(', ');
    throw new Error(
      `${names} ${oversized.length === 1 ? 'exceeds' : 'exceed'} the ${maxBytesLabel} upload limit — 80% of the free disk space on this workspace.`,
    );
  }
  return api.copyFiles.upload(copy, dir, files);
}

// eslint-disable-next-line no-restricted-syntax -- undefined = folder not in tree yet (no attachments uploaded)
function findFolder(nodes: FileTreeNode[], folderPath: string): FileTreeNode | undefined {
  for (const n of nodes) {
    if (n.kind !== 'folder') continue;
    if (n.path === folderPath) return n;
    if (folderPath.startsWith(`${n.path}/`) && n.children) {
      const hit = findFolder(n.children, folderPath);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** List the files under `<bp>/attachments/` in a copy (sorted by name). */
export async function listSpecAttachments(
  copy: string,
  bpId: string,
): Promise<AttachmentRow[]> {
  const tree = await api.copyFiles.tree(copy);
  const folder = findFolder(tree, `${bpId}/attachments`);
  return (folder?.children ?? [])
    .filter((n) => n.kind === 'file')
    .map((n) => ({ name: n.name, path: n.path }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Attachments for a BP's specification. Files are stored as plain files
 * at `<bp>/attachments/` inside the copy — the same directory the
 * coding agent works in — via the copy-files HTTP API, so the agent
 * (and git) see them with no extra plumbing.
 */
export function SpecAttachments({ bpId, copy }: SpecAttachmentsProps) {
  const [files, setFiles] = useState<AttachmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AttachmentRow>();

  const refresh = useCallback(async () => {
    try {
      setFiles(await listSpecAttachments(copy, bpId));
    } catch {
      // Tree fetch failures surface in the Files tab too; keep the panel
      // quiet and just show what we last had.
    } finally {
      setLoading(false);
    }
  }, [copy, bpId]);

  useEffect(() => {
    setLoading(true);
    setFiles([]);
    void refresh();
  }, [refresh]);

  // Uploads made outside this panel (insert-image popover, paste) refresh it.
  useEffect(() => {
    const listener = () => void refresh();
    changeListeners.add(listener);
    return () => {
      changeListeners.delete(listener);
    };
  }, [refresh]);

  const handleUpload = useCallback(
    async (accepted: File[]) => {
      if (accepted.length === 0) return;
      setUploading(true);
      try {
        const r = await uploadSpecAttachments(copy, bpId, accepted);
        toast.success(
          r.written.length === 1
            ? `Uploaded ${r.written[0]?.name}`
            : `Uploaded ${r.written.length} attachments`,
        );
        // Don't swallow what just arrived behind a collapsed panel.
        setCollapsed(false);
        await refresh();
      } catch (err) {
        toast.error('Upload failed', {
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setUploading(false);
      }
    },
    [copy, bpId, refresh],
  );

  const handleDelete = useCallback(async () => {
    const target = deleteTarget;
    if (!target) return;
    setDeleteTarget(undefined);
    try {
      await api.copyFiles.remove(copy, target.path);
      toast.success(`Deleted ${target.name}`);
      await refresh();
    } catch (err) {
      toast.error('Delete failed', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }, [deleteTarget, copy, refresh]);

  const { getRootProps, getInputProps, open, isDragActive } = useDropzone({
    onDrop: (accepted) => void handleUpload(accepted),
    noClick: true,
    noKeyboard: true,
  });

  return (
    <div
      {...getRootProps()}
      className={cn(
        // The activity button (TaskQueuePanel) floats over the bottom-right
        // corner — bottom-4 right-4, size-11, so it owns the last 60px. The
        // extra right padding keeps Upload and the per-file download/delete
        // buttons out from under it. Reserved unconditionally: the float
        // comes and goes with activity, and controls that shift sideways
        // when a notification arrives would be worse than a little space.
        'shrink-0 border-t border-border bg-white py-3 pl-7 pr-20 transition-colors',
        isDragActive && 'bg-primary/5',
      )}
    >
      <input {...getInputProps()} />
      <div className="flex items-center gap-2">
        {/* The whole label toggles the list: with many attachments the panel
            would otherwise eat the bottom of the editor. */}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          aria-controls="spec-attachments-list"
          title={collapsed ? 'Show attachments' : 'Hide attachments'}
          className="flex items-center gap-2 rounded-md py-0.5 pr-1.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronDown
            className={cn('size-3.5 transition-transform', collapsed && '-rotate-90')}
            aria-hidden
          />
          <Paperclip className="size-3.5" aria-hidden />
          <span className="text-xs font-semibold uppercase tracking-wide">
            Attachments{files.length > 0 ? ` (${files.length})` : ''}
          </span>
        </button>
        <span className="flex-1" />
        <Button size="sm" variant="outline" onClick={open} disabled={uploading}>
          {uploading ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Upload className="size-3.5" aria-hidden />
          )}
          Upload
        </Button>
      </div>

      {!collapsed && (
        <div id="spec-attachments-list">
          {loading ? (
            <div className="py-2 text-xs text-muted-foreground">Loading…</div>
          ) : files.length === 0 ? (
            <div className="py-2 text-xs text-muted-foreground">
              {isDragActive
                ? 'Drop files to attach them.'
                : 'No attachments yet — drop files here or click Upload. The coding agent sees them under attachments/.'}
            </div>
          ) : (
            <ul className="mt-2 flex max-h-44 flex-col overflow-y-auto">
              {files.map((f) => (
                <li
                  key={f.path}
                  className="group flex items-center gap-2 rounded-md px-1.5 py-1 text-[13px] text-foreground hover:bg-muted/60"
                >
                  <Paperclip
                    className="size-3 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <a
                    href={api.copyFiles.rawUrl(copy, f.path)}
                    download={f.name}
                    title={`Download ${f.name}`}
                    className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Download className="size-3.5" aria-hidden />
                  </a>
                  <button
                    type="button"
                    title={`Delete ${f.name}`}
                    onClick={() => setDeleteTarget(f)}
                    className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <AlertDialog
        open={deleteTarget !== undefined}
        onOpenChange={(o) => !o && setDeleteTarget(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The file is removed from the copy&apos;s attachments/ folder.
              Anything referencing it (the spec, the coding agent) will no
              longer find it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                void handleDelete();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

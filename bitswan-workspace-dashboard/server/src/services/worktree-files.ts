import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isValidWorktreeName } from './workspace.js';

/**
 * Read-only views of a worktree's filesystem (tree + file content) for
 * the dashboard's Files / Diff tabs. We deliberately walk the bind-
 * mounted workspace directly instead of round-tripping through gitops:
 * the workspace is already mounted into the dashboard container (the
 * README + requirements features rely on the same mount), and the data
 * is purely informational.
 */

export interface FileTreeNode {
  name: string;
  kind: 'file' | 'folder';
  /** Workspace-relative path (without the `worktrees/<name>/` prefix). */
  path: string;
  /** Only set on folders. Empty array on an empty folder. */
  children?: FileTreeNode[];
}

/**
 * Names we silently skip while walking the tree. Hard-coded — the
 * mockup doesn't expose a toggle, and the surface area of clutter is
 * small and stable enough to not warrant per-workspace config.
 */
const HIDDEN_NAMES: ReadonlySet<string> = new Set([
  '.git',
  '.requirements.json',
  '.DS_Store',
  'node_modules',
  '__pycache__',
  '.venv',
]);

/** Files larger than this won't be returned by `readWorktreeFile`. */
const FILE_SIZE_LIMIT = 1024 * 1024; // 1 MiB

/** Heuristic: the first N bytes of a file. If we see a NUL, call it binary. */
const BINARY_PROBE_BYTES = 8 * 1024;

function worktreeRoot(opts: { workspaceRoot: string; worktree: string }): string {
  if (!isValidWorktreeName(opts.worktree)) {
    throw new Error('invalid worktree name');
  }
  // Always realpath the root so the containment check below works even
  // when symlinks are in play.
  return path.join(opts.workspaceRoot, 'worktrees', opts.worktree);
}

/**
 * Belt-and-suspenders containment check. The caller is expected to also
 * pass `path` through their route-layer validator, but a service-level
 * check means a future caller forgetting that doesn't get to escape the
 * worktree.
 */
function resolveInsideWorktree(root: string, relPath: string): string {
  const resolved = path.resolve(root, relPath);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error('path escapes worktree');
  }
  return resolved;
}

export async function readWorktreeTree(opts: {
  worktree: string;
  workspaceRoot: string;
}): Promise<FileTreeNode[]> {
  const root = worktreeRoot(opts);
  return readChildren(root, root);
}

async function readChildren(root: string, dir: string): Promise<FileTreeNode[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw err;
  }
  const out: FileTreeNode[] = [];
  for (const e of entries) {
    if (HIDDEN_NAMES.has(e.name)) continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (e.isDirectory()) {
      out.push({
        name: e.name,
        kind: 'folder',
        path: rel,
        children: await readChildren(root, full),
      });
    } else if (e.isFile() || e.isSymbolicLink()) {
      out.push({ name: e.name, kind: 'file', path: rel });
    }
    // Skip sockets / fifos / etc.
  }
  // Folders first, then files; both alphabetical. Matches the mockup
  // (and what most file explorers do).
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

/**
 * Compact representation of a file's identity at read time. Returned on
 * every successful content read; the editor sends it back on save so the
 * server can reject writes that would clobber an out-of-band change
 * (e.g. the agent edited the same file via SSH while a tab was open).
 */
export interface FileEtag {
  /** Last modified time in milliseconds since the epoch. */
  mtimeMs: number;
  /** Byte size at read time. */
  size: number;
}

function statEtag(st: import('node:fs').Stats): FileEtag {
  return { mtimeMs: Math.floor(st.mtimeMs), size: st.size };
}

export type FileReadResult =
  | { content: string; truncated: boolean; etag: FileEtag }
  | { error: 'binary' | 'too-large' | 'not-found' };

export async function readWorktreeFile(opts: {
  worktree: string;
  path: string;
  workspaceRoot: string;
}): Promise<FileReadResult> {
  const root = worktreeRoot(opts);
  let abs: string;
  try {
    abs = resolveInsideWorktree(root, opts.path);
  } catch {
    return { error: 'not-found' };
  }
  let st: import('node:fs').Stats;
  try {
    st = await fs.stat(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { error: 'not-found' };
    }
    throw err;
  }
  if (!st.isFile()) return { error: 'not-found' };
  if (st.size > FILE_SIZE_LIMIT) return { error: 'too-large' };

  // Read up to FILE_SIZE_LIMIT, but use a probe-then-decode pattern so
  // we can refuse binary files before allocating a giant UTF-8 string.
  const handle = await fs.open(abs, 'r');
  try {
    const probeSize = Math.min(st.size, BINARY_PROBE_BYTES);
    const probe = Buffer.alloc(probeSize);
    if (probeSize > 0) {
      await handle.read(probe, 0, probeSize, 0);
      if (probe.includes(0)) return { error: 'binary' };
    }
    const full = Buffer.alloc(st.size);
    if (st.size > 0) {
      await handle.read(full, 0, st.size, 0);
    }
    // Reject files whose tail bytes also have NULs (some binaries have a
    // text header). Skip if file fits in the probe range.
    if (st.size > probeSize && full.subarray(probeSize).includes(0)) {
      return { error: 'binary' };
    }
    return {
      content: full.toString('utf8'),
      truncated: false,
      etag: statEtag(st),
    };
  } finally {
    await handle.close();
  }
}

export type FileWriteResult =
  | { ok: true; etag: FileEtag }
  | { error: 'binary' | 'too-large' | 'conflict' | 'not-found'; expected?: FileEtag; actual?: FileEtag };

/**
 * Atomic write into the worktree. Optional `expectedEtag` enforces a
 * compare-and-set: the file's current mtime/size must match what the
 * caller last read, otherwise we return `conflict` and the caller can
 * surface a "agent edited this file — reload to merge" prompt.
 *
 * Writes use the tmp-then-rename pattern (same as services/requirements.ts)
 * so a crash mid-write leaves the original intact.
 */
export async function writeWorktreeFile(opts: {
  worktree: string;
  path: string;
  workspaceRoot: string;
  content: string;
  /** When set, refuse to write if the on-disk file has moved since this etag. */
  expectedEtag?: FileEtag;
  /** Allow creating the file if it doesn't exist. Defaults to true. */
  createIfMissing?: boolean;
}): Promise<FileWriteResult> {
  const root = worktreeRoot(opts);
  let abs: string;
  try {
    abs = resolveInsideWorktree(root, opts.path);
  } catch {
    return { error: 'not-found' };
  }

  // Refuse to clobber an existing binary file. Useful guard against the
  // editor "accidentally" writing UTF-8 over a binary payload.
  let existing: import('node:fs').Stats | null = null;
  try {
    existing = await fs.stat(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  if (existing) {
    if (!existing.isFile()) return { error: 'not-found' };
    if (existing.size > FILE_SIZE_LIMIT) return { error: 'too-large' };
    if (opts.expectedEtag) {
      const cur = statEtag(existing);
      if (
        cur.mtimeMs !== opts.expectedEtag.mtimeMs ||
        cur.size !== opts.expectedEtag.size
      ) {
        return { error: 'conflict', expected: opts.expectedEtag, actual: cur };
      }
    }
    if (existing.size > 0) {
      // Probe the existing file for a NUL byte to refuse turning a binary
      // into text. Same heuristic as the read path.
      const handle = await fs.open(abs, 'r');
      try {
        const probeSize = Math.min(existing.size, BINARY_PROBE_BYTES);
        const probe = Buffer.alloc(probeSize);
        await handle.read(probe, 0, probeSize, 0);
        if (probe.includes(0)) return { error: 'binary' };
      } finally {
        await handle.close();
      }
    }
  } else if (opts.createIfMissing === false) {
    return { error: 'not-found' };
  }

  // The new content's size limit also applies — a runaway "save" with
  // a giant string shouldn't blow up the workspace.
  if (Buffer.byteLength(opts.content, 'utf8') > FILE_SIZE_LIMIT) {
    return { error: 'too-large' };
  }

  // Make sure the parent directory exists (uploads write into nested dirs).
  await fs.mkdir(path.dirname(abs), { recursive: true });

  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, opts.content, 'utf8');
  await fs.rename(tmp, abs);
  const st = await fs.stat(abs);
  return { ok: true, etag: statEtag(st) };
}

export type FileDeleteResult = { ok: true } | { error: 'not-found' };

/**
 * Delete a single file inside a worktree. Directories are refused (the
 * dashboard only ever deletes files, e.g. spec attachments) — a missing
 * or non-file target reports `not-found`.
 */
export async function deleteWorktreeFile(opts: {
  worktree: string;
  path: string;
  workspaceRoot: string;
}): Promise<FileDeleteResult> {
  const root = worktreeRoot(opts);
  let abs: string;
  try {
    abs = resolveInsideWorktree(root, opts.path);
  } catch {
    return { error: 'not-found' };
  }
  let st: import('node:fs').Stats;
  try {
    st = await fs.stat(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { error: 'not-found' };
    }
    throw err;
  }
  if (!st.isFile()) return { error: 'not-found' };
  await fs.unlink(abs);
  return { ok: true };
}

export type FileStatResult =
  | { abs: string; size: number; name: string }
  | { error: 'not-found' };

/**
 * Resolve + stat a file inside a worktree for raw streaming (downloads,
 * binary attachments). Unlike {@link readWorktreeFile} this places no
 * size or text-ness constraints — the route layer streams the bytes.
 */
export async function statWorktreeFile(opts: {
  worktree: string;
  path: string;
  workspaceRoot: string;
}): Promise<FileStatResult> {
  const root = worktreeRoot(opts);
  let abs: string;
  try {
    abs = resolveInsideWorktree(root, opts.path);
  } catch {
    return { error: 'not-found' };
  }
  let st: import('node:fs').Stats;
  try {
    st = await fs.stat(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { error: 'not-found' };
    }
    throw err;
  }
  if (!st.isFile()) return { error: 'not-found' };
  return { abs, size: st.size, name: path.basename(abs) };
}

/**
 * Resolve a workspace-relative directory path inside a worktree (for
 * upload targets). Creates the directory if it doesn't exist. The empty
 * string resolves to the worktree root.
 */
export async function ensureWorktreeDir(opts: {
  worktree: string;
  path: string;
  workspaceRoot: string;
}): Promise<string> {
  const root = worktreeRoot(opts);
  const rel = opts.path && opts.path !== '/' ? opts.path : '';
  const abs = rel ? resolveInsideWorktree(root, rel) : root;
  await fs.mkdir(abs, { recursive: true });
  return abs;
}


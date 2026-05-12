import fs from 'node:fs/promises';
import path from 'node:path';

export interface BusinessProcess {
  id: string;
  name: string;
  path: string; // relative path under /workspace/workspace
  hasWorktrees: boolean;
}

const PROCESS_TOML = 'process.toml';

async function isDir(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function hasProcessToml(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, PROCESS_TOML));
    return true;
  } catch {
    return false;
  }
}

async function listBpDirsIn(root: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.')) continue;
    if (e.name === 'worktrees') continue;
    if (await hasProcessToml(path.join(root, e.name))) out.push(e.name);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

async function listWorktreeNames(root: string): Promise<string[]> {
  const worktreesDir = path.join(root, 'worktrees');
  if (!(await isDir(worktreesDir))) return [];
  const entries = await fs.readdir(worktreesDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

// Reads a BP's README.md, returning null if it doesn't exist. The bpId is
// validated against a tight allowlist before being joined into the path —
// path traversal is rejected.
const BP_ID_RE = /^[A-Za-z0-9_.-]+$/;
export function isValidBpId(bpId: string): boolean {
  return BP_ID_RE.test(bpId) && bpId !== '.' && bpId !== '..';
}

export async function readReadme(
  bpId: string,
  root = '/workspace/workspace',
): Promise<string | null> {
  if (!isValidBpId(bpId)) {
    throw new Error(`invalid bpId: ${bpId}`);
  }
  try {
    const p = path.join(root, bpId, 'README.md');
    return await fs.readFile(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function discoverBusinessProcesses(
  root = '/workspace/workspace',
): Promise<BusinessProcess[]> {
  const mainBps = await listBpDirsIn(root);
  const worktreeNames = await listWorktreeNames(root);

  // A BP "has worktrees" if any worktree contains a directory of the same name
  // with a process.toml. (Mirrors editor's mapping: live-dev automations live at
  // `worktrees/<wt>/<bpName>`.)
  const bpHasWorktree = new Map<string, boolean>();
  await Promise.all(
    worktreeNames.map(async (wt) => {
      const wtRoot = path.join(root, 'worktrees', wt);
      const bps = await listBpDirsIn(wtRoot);
      for (const name of bps) bpHasWorktree.set(name, true);
    }),
  );

  return mainBps.map((name) => ({
    id: name,
    name,
    path: name,
    hasWorktrees: bpHasWorktree.get(name) === true,
  }));
}

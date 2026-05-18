import { promises as fs } from 'node:fs';
import path from 'node:path';
import TOML from '@iarna/toml';
import { isValidBpId, isValidWorktreeName } from './workspace.js';

/**
 * Per-BP "testable requirements" stored in the BP directory as
 * `testable-requirements.toml`. Schema is intentionally identical to the
 * one used by `bitswan-coding-agent requirements …` (see
 * `bitswan-coding-agent/cmd/requirements.go`) so the dashboard, the
 * editor, and the agent CLI can all write to the same file without
 * losing data.
 */

export type ReqStatus = 'pending' | 'pass' | 'fail' | 'retest' | 'proposed';

const VALID_STATUSES: readonly ReqStatus[] = [
  'pending',
  'pass',
  'fail',
  'retest',
  'proposed',
];

export function isReqStatus(value: unknown): value is ReqStatus {
  return (
    typeof value === 'string' && (VALID_STATUSES as readonly string[]).includes(value)
  );
}

export interface Requirement {
  /** REQ-### for human-authored, AI-### for AI-proposed. */
  id: string;
  description: string;
  status: ReqStatus;
  /** Parent id (`""` = root). */
  parent: string;
}

const REQUIREMENTS_FILENAME = 'testable-requirements.toml';

/**
 * Worktree-scoped path resolution. We deliberately don't read main-repo
 * requirements from this surface — the dashboard places this UI inside
 * `WorktreeView` only, mirroring the editor's flow.
 */
function resolveFilePath(opts: {
  workspaceRoot: string;
  worktree: string;
  bp: string;
}): string {
  if (!isValidWorktreeName(opts.worktree)) {
    throw new Error('invalid worktree name');
  }
  if (!isValidBpId(opts.bp)) {
    throw new Error('invalid bp id');
  }
  return path.join(opts.workspaceRoot, 'worktrees', opts.worktree, opts.bp, REQUIREMENTS_FILENAME);
}

interface RawRequirement {
  id?: unknown;
  description?: unknown;
  status?: unknown;
  parent?: unknown;
}

function normaliseRequirement(raw: RawRequirement): Requirement | null {
  if (typeof raw.id !== 'string' || raw.id === '') return null;
  const description = typeof raw.description === 'string' ? raw.description : '';
  const parent = typeof raw.parent === 'string' ? raw.parent : '';
  const status: ReqStatus = isReqStatus(raw.status) ? raw.status : 'pending';
  return { id: raw.id, description, status, parent };
}

/**
 * Read + parse the TOML file. Returns an empty list when the file
 * doesn't exist; callers don't need to distinguish missing from empty.
 */
export async function listRequirements(opts: {
  workspaceRoot: string;
  worktree: string;
  bp: string;
}): Promise<Requirement[]> {
  const filePath = resolveFilePath(opts);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = TOML.parse(raw);
  } catch (err) {
    throw new Error(
      `failed to parse ${REQUIREMENTS_FILENAME}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const arr = (parsed as { requirement?: unknown }).requirement;
  if (!Array.isArray(arr)) return [];
  const out: Requirement[] = [];
  for (const r of arr) {
    const norm = normaliseRequirement(r as RawRequirement);
    if (norm) out.push(norm);
  }
  return out;
}

/**
 * Write the list back to disk atomically (write a sibling tmp file, then
 * rename). Avoids leaving a half-written file if the process dies mid-write.
 */
async function writeRequirements(
  opts: { workspaceRoot: string; worktree: string; bp: string },
  reqs: Requirement[],
): Promise<void> {
  const filePath = resolveFilePath(opts);
  // Ensure parent directory exists (it always should — the BP dir is
  // created when the BP is, and we won't write to a non-existent BP).
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // @iarna/toml stringifies an object with a `requirement` array of objects
  // into the `[[requirement]]` array-of-tables format the agent CLI expects.
  // Order keys to match the CLI's serialiser (id, parent, description, status)
  // for cleaner diffs when both write the file.
  const payload = {
    requirement: reqs.map((r) => ({
      id: r.id,
      parent: r.parent,
      description: r.description,
      status: r.status,
    })),
  };
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, TOML.stringify(payload as unknown as TOML.JsonMap), 'utf8');
  await fs.rename(tmp, filePath);
}

/**
 * Generate the next `REQ-NNN` / `AI-NNN` id. Picks the global max numeric
 * suffix across both prefixes and increments — same rule as the agent
 * CLI's `nextReqID` in `requirements.go:176`.
 */
function nextId(reqs: readonly Requirement[], prefix: 'REQ-' | 'AI-'): string {
  let max = 0;
  for (const r of reqs) {
    const m = r.id.match(/(\d+)$/);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  const next = (max + 1).toString().padStart(3, '0');
  return `${prefix}${next}`;
}

export async function addRequirement(opts: {
  workspaceRoot: string;
  worktree: string;
  bp: string;
  /** May be empty — the dashboard creates a blank row and edits inline. */
  text: string;
  parent?: string;
  status?: ReqStatus;
}): Promise<Requirement> {
  const reqs = await listRequirements(opts);
  const status: ReqStatus = opts.status && isReqStatus(opts.status) ? opts.status : 'pending';
  const prefix = status === 'proposed' ? 'AI-' : 'REQ-';
  const created: Requirement = {
    id: nextId(reqs, prefix),
    description: opts.text,
    status,
    parent: opts.parent ?? '',
  };
  // Validate parent (if given) exists, to avoid orphans introduced via the API.
  if (created.parent && !reqs.some((r) => r.id === created.parent)) {
    throw new Error(`parent '${created.parent}' does not exist`);
  }
  reqs.push(created);
  await writeRequirements(opts, reqs);
  return created;
}

export async function updateRequirement(opts: {
  workspaceRoot: string;
  worktree: string;
  bp: string;
  id: string;
  patch: { description?: string; status?: ReqStatus };
}): Promise<Requirement> {
  const reqs = await listRequirements(opts);
  const idx = reqs.findIndex((r) => r.id === opts.id);
  if (idx < 0) {
    throw new Error(`requirement '${opts.id}' not found`);
  }
  const cur = reqs[idx]!;
  if (opts.patch.status !== undefined && !isReqStatus(opts.patch.status)) {
    throw new Error('invalid status');
  }
  const next: Requirement = {
    ...cur,
    ...(opts.patch.description !== undefined ? { description: opts.patch.description } : {}),
    ...(opts.patch.status !== undefined ? { status: opts.patch.status } : {}),
  };
  reqs[idx] = next;
  await writeRequirements(opts, reqs);
  return next;
}

/**
 * Remove a requirement. We deliberately don't cascade — the agent CLI's
 * remove command does the same (see `requirements.go:386-390`). Orphaned
 * children appear at the root in the tree builder.
 */
export async function removeRequirement(opts: {
  workspaceRoot: string;
  worktree: string;
  bp: string;
  id: string;
}): Promise<void> {
  const reqs = await listRequirements(opts);
  if (!reqs.some((r) => r.id === opts.id)) {
    throw new Error(`requirement '${opts.id}' not found`);
  }
  const filtered = reqs.filter((r) => r.id !== opts.id);
  await writeRequirements(opts, filtered);
}

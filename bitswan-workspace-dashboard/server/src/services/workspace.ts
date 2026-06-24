import fs from 'node:fs/promises';
import path from 'node:path';

const BP_ID_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * Tight allowlist for a BP id used in filesystem paths — rejects empty
 * strings, dot-prefixed names, and anything containing slashes or `..`.
 * Same regex is used to vet a `copy` parameter so neither side can
 * escape the workspace root through path traversal.
 */
export function isValidBpId(bpId: string): boolean {
  return BP_ID_RE.test(bpId) && bpId !== '.' && bpId !== '..';
}

export const isValidCopyName = isValidBpId;

/**
 * Read a BP's `README.md`, returning `null` if the file doesn't exist.
 *
 * Path layout:
 *   - main repo: `<root>/<bpId>/README.md`
 *   - copy `c`:  `<root>/copies/<c>/<bpId>/README.md`
 *
 * `bpId` and `copy` are both validated against {@link isValidBpId}
 * before joining; `..` and `/` are rejected.
 */
export async function readReadme(
  bpId: string,
  root = '/workspace/workspace',
  copy?: string,
): Promise<string | null> {
  if (!isValidBpId(bpId)) {
    throw new Error(`invalid bpId: ${bpId}`);
  }
  if (copy !== undefined && !isValidCopyName(copy)) {
    throw new Error(`invalid copy: ${copy}`);
  }
  const p = copy
    ? path.join(root, 'copies', copy, bpId, 'README.md')
    : path.join(root, bpId, 'README.md');
  try {
    return await fs.readFile(p, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
}

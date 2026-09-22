import type { Requirement } from '@/lib/api';

export interface DisplayRow {
  req: Requirement;
  /** Indentation level within this table. */
  depth: number;
  /**
   * The parent, when it exists but is NOT rendered in this same table — so the
   * indentation cannot convey the relationship and the row has to name it.
   * Null when the parent is present here (indentation says it), when there is
   * no parent, or when the parent no longer exists at all.
   */
  parentElsewhere: Requirement | null;
}

/**
 * Flatten a set of requirements (which carry only `parent` pointers) into a
 * DFS-ordered render list with indentation depth.
 *
 * `rows` is what this table shows; `all` is every requirement in the business
 * process. The two differ because the tab groups by verdict, not by tree: a
 * failing parent and its blocked child land in different tables, and a child
 * shown on its own loses every visual clue about what it belongs to. Where
 * that happens the parent comes back as `parentElsewhere` for the row to name.
 *
 * Orphans — a `parent` pointing at a requirement that no longer exists, e.g.
 * after a non-cascade delete — surface at the root, matching how gitops and the
 * agent CLI both handle them. A requirement must never become invisible.
 */
export function flattenForDisplay(
  rows: readonly Requirement[],
  all: readonly Requirement[] = rows,
): DisplayRow[] {
  const here = new Set(rows.map((r) => r.id));
  const byId = new Map(all.map((r) => [r.id, r]));

  const byParent = new Map<string, Requirement[]>();
  for (const r of rows) {
    // A parent outside this table cannot hold the child, so the child is a
    // root here and carries the pointer as text instead.
    const key = r.parent && here.has(r.parent) ? r.parent : '';
    const arr = byParent.get(key) ?? [];
    arr.push(r);
    byParent.set(key, arr);
  }

  const out: DisplayRow[] = [];
  const walk = (parentId: string, depth: number) => {
    for (const r of byParent.get(parentId) ?? []) {
      const parentElsewhere =
        r.parent && !here.has(r.parent) ? (byId.get(r.parent) ?? null) : null;
      out.push({ req: r, depth, parentElsewhere });
      walk(r.id, depth + 1);
    }
  };
  walk('', 0);
  return out;
}

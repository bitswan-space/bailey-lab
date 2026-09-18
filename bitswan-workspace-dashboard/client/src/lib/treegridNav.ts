/**
 * Keyboard navigation for the requirements treegrid (#268).
 *
 * The requirements list is a tree rendered as a flat, depth-first list of
 * rows, each carrying an indentation `depth`. That flattening is enough to
 * recover every tree relationship positionally:
 *
 *   - a row's parent is the nearest *earlier* row with a smaller depth;
 *   - a row's children are the immediately *following* rows whose depth is
 *     exactly one greater, up to the next row at the parent's depth or less.
 *
 * So this module never needs the `parent` pointers the API returns — it works
 * on whatever `RequirementsTable.flatten()` produced, which also means it is
 * correct under filtering (a filtered-out parent leaves its children as roots,
 * and they navigate as roots).
 *
 * Keeping this pure — no React, no DOM — is what lets it be tested with the
 * repo's existing `node --test` runner, since the client has no component
 * testing stack. The components stay a thin shell that maps a `NavResult` onto
 * real DOM focus.
 *
 * Key assignments follow the WAI-ARIA Authoring Practices `treegrid` pattern,
 * so the behaviour matches what a screen-reader user already expects rather
 * than a vocabulary invented here.
 */

/** A row as flattened for render: its id and its indentation depth. */
export interface TreeRow {
  id: string;
  depth: number;
}

/**
 * A row that survived collapsing, annotated with the two facts navigation
 * needs but which cannot be read off the visible list itself: whether it has
 * children at all (a collapsed parent's children are absent from this list),
 * and whether those children are currently shown.
 */
export interface VisibleRow extends TreeRow {
  hasChildren: boolean;
  expanded: boolean;
}

/**
 * What the caller should do in response to a key. `null` means the key was
 * not ours — the caller must leave the event alone so the browser keeps its
 * default behaviour (notably Tab, which must still exit the grid).
 */
export type NavResult =
  | { kind: 'move'; id: string }
  | { kind: 'collapse'; id: string }
  | { kind: 'expand'; id: string }
  /** Move focus off the row and onto the first control inside it. */
  | { kind: 'enterRow'; id: string }
  /** Primary action for the row — here, open the description editor. */
  | { kind: 'activate'; id: string }
  | null;

/** True when `rows[i]` has at least one child in the *unfiltered* flat list. */
export function hasChildren(rows: readonly TreeRow[], i: number): boolean {
  const cur = rows[i];
  const next = rows[i + 1];
  return cur !== undefined && next !== undefined && next.depth > cur.depth;
}

/**
 * Index of `rows[i]`'s parent, or -1 when it is a root. Scans backwards for
 * the first row shallower than this one.
 */
export function parentIndexOf(rows: readonly TreeRow[], i: number): number {
  const depth = rows[i]?.depth ?? 0;
  if (depth === 0) return -1;
  for (let j = i - 1; j >= 0; j--) {
    const candidate = rows[j];
    if (candidate !== undefined && candidate.depth < depth) return j;
  }
  return -1;
}

/**
 * Ids of every row nested under `id` — its whole subtree, at any depth.
 *
 * Used to rescue focus when a subtree is about to be hidden: since collapsing
 * `id` hides exactly these rows, `id` itself is the nearest ancestor that
 * stays visible, and so the right place for focus to land.
 */
export function descendantIds(rows: readonly TreeRow[], id: string): string[] {
  const i = rows.findIndex((r) => r.id === id);
  const start = rows[i];
  if (start === undefined) return [];
  const out: string[] = [];
  for (let j = i + 1; j < rows.length; j++) {
    const r = rows[j];
    if (r === undefined || r.depth <= start.depth) break;
    out.push(r.id);
  }
  return out;
}

/**
 * Drops the descendants of every collapsed row and annotates what survives.
 *
 * Descendants are skipped by depth rather than by id, so collapsing a parent
 * hides its whole subtree in one pass — including grandchildren whose own
 * rows are not themselves marked collapsed.
 */
export function visibleRows(
  rows: readonly TreeRow[],
  collapsed: ReadonlySet<string>,
): VisibleRow[] {
  const out: VisibleRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row === undefined) continue;
    const kids = hasChildren(rows, i);
    const isCollapsed = kids && collapsed.has(row.id);
    out.push({ ...row, hasChildren: kids, expanded: kids && !isCollapsed });
    if (isCollapsed) {
      // Skip everything deeper than this row — the entire subtree.
      let next = rows[i + 1];
      while (next !== undefined && next.depth > row.depth) {
        i++;
        next = rows[i + 1];
      }
    }
  }
  return out;
}

/**
 * Maps a key press on the active row to an action.
 *
 * `activeId` may be null (nothing focused yet) or name a row that has since
 * been filtered or collapsed away; both fall back to the first visible row so
 * a stale id can never strand the keyboard user.
 */
export function navigate(
  rows: readonly VisibleRow[],
  activeId: string | null,
  key: string,
): NavResult {
  if (rows.length === 0) return null;

  const NAV_KEYS = new Set([
    'ArrowDown',
    'ArrowUp',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
    'Enter',
  ]);
  if (!NAV_KEYS.has(key)) return null;

  const first = rows[0];
  const last = rows[rows.length - 1];
  if (first === undefined || last === undefined) return null;

  const i = activeId === null ? -1 : rows.findIndex((r) => r.id === activeId);
  // No active row, or it vanished under a filter/collapse: an end of the list
  // is the safe landing spot for any navigation key.
  if (i === -1) {
    return key === 'End' ? { kind: 'move', id: last.id } : { kind: 'move', id: first.id };
  }
  const row = rows[i];
  if (row === undefined) return null;

  switch (key) {
    case 'ArrowDown': {
      const next = rows[i + 1];
      return next === undefined ? null : { kind: 'move', id: next.id };
    }
    case 'ArrowUp': {
      const prev = i > 0 ? rows[i - 1] : undefined;
      return prev === undefined ? null : { kind: 'move', id: prev.id };
    }
    case 'Home':
      return { kind: 'move', id: first.id };
    case 'End':
      return { kind: 'move', id: last.id };
    case 'Enter':
      return { kind: 'activate', id: row.id };
    case 'ArrowRight':
      // Expand first; on an already-open row (or a leaf) step into its
      // controls, per the treegrid pattern's "move to the first cell".
      if (row.hasChildren && !row.expanded) return { kind: 'expand', id: row.id };
      return { kind: 'enterRow', id: row.id };
    case 'ArrowLeft': {
      // Close first; on an already-closed row (or a leaf) climb to the parent.
      if (row.hasChildren && row.expanded) return { kind: 'collapse', id: row.id };
      const p = parentIndexOf(rows, i);
      const parent = p === -1 ? undefined : rows[p];
      return parent === undefined ? null : { kind: 'move', id: parent.id };
    }
    default:
      return null;
  }
}

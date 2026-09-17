import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Plus } from 'lucide-react';
import type { Requirement } from '@/lib/api';
import { descendantIds, navigate, visibleRows } from '@/lib/treegridNav';
import { RequirementRow } from './RequirementRow';

interface Props {
  requirements: Requirement[];
  /** True while the initial list is still loading. */
  loading?: boolean;
  /** Newly created requirement id that should mount in edit mode. */
  pendingEditId: string | null;
  onEditDone: () => void;
  onAcceptProposal: (req: Requirement) => void;
  onSendBack: (req: Requirement) => void;
  onUndoSendBack: (req: Requirement) => void;
  /** Ids this person sent back in this tab — the only rows offered Undo. */
  sentBack: ReadonlySet<string>;
  onUpdateDescription: (req: Requirement, text: string) => void;
  onAddChild: (parent: Requirement) => void;
  /** Create a new root-level requirement (the dashed add-row at the bottom). */
  onAddRoot: () => void;
  onDelete: (req: Requirement) => void;
  onRunTest: (req: Requirement) => void;
  /** Ids whose test is currently running (per-row or part of an all-run). */
  runningIds: ReadonlySet<string>;
}

/**
 * Flattens the requirements list (which only carries `parent` pointers)
 * into a DFS-ordered render list, attaching a `depth` to each row for
 * indentation. Orphans (requirements whose `parent` no longer exists,
 * e.g. after a non-cascade delete) surface at the root, matching how the
 * agent CLI's tree builder handles them.
 */
function flatten(reqs: Requirement[]): Array<{ req: Requirement; depth: number }> {
  const byParent = new Map<string, Requirement[]>();
  const ids = new Set(reqs.map((r) => r.id));
  for (const r of reqs) {
    // Treat a parent pointing at a missing id as root, so orphans don't
    // disappear from the view.
    const key = r.parent && ids.has(r.parent) ? r.parent : '';
    const arr = byParent.get(key) ?? [];
    arr.push(r);
    byParent.set(key, arr);
  }
  const out: Array<{ req: Requirement; depth: number }> = [];
  const walk = (parentId: string, depth: number) => {
    const kids = byParent.get(parentId);
    if (!kids) return;
    for (const r of kids) {
      out.push({ req: r, depth });
      walk(r.id, depth + 1);
    }
  };
  walk('', 0);
  return out;
}

/** The controls inside a row, in visual order, that ←/→ step through. */
function controlsOf(rowEl: HTMLElement): HTMLElement[] {
  return Array.from(rowEl.querySelectorAll<HTMLElement>('button')).filter(
    (el) => !el.hasAttribute('disabled'),
  );
}

/**
 * The requirements tree as an ARIA `treegrid` (#268).
 *
 * Keyboard model, following the WAI-ARIA Authoring Practices so it matches
 * what a screen-reader user already expects:
 *
 *   - the grid is a **single tab stop**. Exactly one row carries
 *     `tabIndex={0}`; every other row and every control inside a row is
 *     `-1`. Tab therefore steps over the whole table instead of visiting
 *     ~5 controls per requirement, which is the complaint in #268.
 *   - ↑/↓ move between visible rows, ←/→ fold and unfold a subtree,
 *     Home/End jump to the ends, Enter opens the description editor.
 *   - → on an already-open row (or a leaf) steps *into* the row's controls,
 *     where ←/→ move between them and Escape returns to the row.
 *
 * The decision logic lives in `lib/treegridNav.ts` so it can be unit-tested
 * without a DOM; this component only turns its results into real focus.
 */
export function RequirementsTable({
  requirements,
  loading = false,
  pendingEditId,
  onEditDone,
  onAcceptProposal,
  onSendBack,
  onUndoSendBack,
  sentBack,
  onUpdateDescription,
  onAddChild,
  onAddRoot,
  onDelete,
  onRunTest,
  runningIds,
}: Props) {
  const flat = useMemo(() => flatten(requirements), [requirements]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  // Enter on a focused row asks that row to open its editor. Kept separate
  // from the caller's `pendingEditId` (which marks a freshly created row) so
  // neither flow clears the other's intent.
  const [keyboardEditId, setKeyboardEditId] = useState<string | null>(null);

  const rows = useMemo(
    () => visibleRows(flat.map(({ req, depth }) => ({ id: req.id, depth })), collapsed),
    [flat, collapsed],
  );
  const byId = useMemo(() => new Map(flat.map(({ req }) => [req.id, req])), [flat]);

  const rowEls = useRef(new Map<string, HTMLDivElement>());
  const focusRow = (id: string) => rowEls.current.get(id)?.focus();

  // Exactly one row is tabbable. If the active row was filtered, deleted or
  // collapsed away, the tab stop falls back to the first visible row so the
  // grid is never unreachable by keyboard.
  const tabStopId = rows.some((r) => r.id === activeId) ? activeId : (rows[0]?.id ?? null);

  /**
   * Collapsing unmounts every row in the subtree. If focus is sitting in one
   * of them it would fall to `<body>`, stranding the keyboard user outside the
   * grid. `id` is by definition the nearest ancestor that stays visible, so
   * that is where focus goes.
   *
   * Chromium and Firefox happen to mask this by focusing the chevron when it
   * is clicked, but that is a per-engine courtesy — Safari does not do it, and
   * neither would a collapse triggered from anywhere other than the chevron.
   */
  const rescueFocusFrom = (id: string) => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    const focusedId = active.closest<HTMLElement>('[data-req-id]')?.dataset.reqId;
    if (focusedId === undefined || !descendantIds(rows, id).includes(focusedId)) return;
    setActiveId(id);
    // The ancestor row is already mounted, so this lands before React removes
    // the subtree underneath it.
    rowEls.current.get(id)?.focus();
  };

  const setExpanded = (id: string, open: boolean) => {
    if (!open) rescueFocusFrom(id);
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (open) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /**
   * After an edit closes, focus has nowhere to go — the textarea is gone.
   * Deferred and guarded on `body` so this only rescues that case: if the
   * edit ended because the user clicked something else, that something else
   * already holds focus and we leave it alone.
   */
  const restoreRowFocus = (id: string) => {
    window.setTimeout(() => {
      const act = document.activeElement;
      if (act === null || act === document.body) focusRow(id);
    }, 0);
  };

  const handleEditDone = (id: string) => {
    setKeyboardEditId((cur) => (cur === id ? null : cur));
    onEditDone();
    restoreRowFocus(id);
  };

  /** Keys pressed while focus is on a control *inside* a row. */
  const onControlKey = (
    e: KeyboardEvent<HTMLDivElement>,
    rowEl: HTMLElement,
    target: HTMLElement,
  ) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      rowEl.focus();
      return;
    }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const controls = controlsOf(rowEl);
    const i = controls.indexOf(target);
    if (i === -1) return;
    e.preventDefault();
    if (e.key === 'ArrowRight') {
      // Stop at the last control rather than wrapping — wrapping past the end
      // reads as "nothing happened" when you cannot see where focus went.
      controls[Math.min(i + 1, controls.length - 1)]?.focus();
    } else if (i === 0) {
      rowEl.focus();
    } else {
      controls[i - 1]?.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    // Never touch keys meant for the inline editor.
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return;
    const rowEl = target.closest<HTMLElement>('[data-req-id]');
    if (!rowEl) return; // the column header, or anything else in the grid
    const id = rowEl.dataset.reqId;
    if (!id) return;

    if (target !== rowEl) {
      onControlKey(e, rowEl, target);
      return;
    }

    const result = navigate(rows, id, e.key);
    if (!result) return; // not ours — Tab in particular must still escape
    e.preventDefault();
    switch (result.kind) {
      case 'move':
        setActiveId(result.id);
        focusRow(result.id);
        break;
      case 'collapse':
        setExpanded(result.id, false);
        break;
      case 'expand':
        setExpanded(result.id, true);
        break;
      case 'enterRow':
        controlsOf(rowEl)[0]?.focus();
        break;
      case 'activate':
        setKeyboardEditId(result.id);
        break;
    }
  };

  const placeholder =
    loading && rows.length === 0
      ? 'Loading…'
      : rows.length === 0
        ? 'No requirements match your filter.'
        : null;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-white">
      <div
        role="treegrid"
        aria-label="Testable requirements"
        aria-colcount={4}
        onKeyDown={onKeyDown}
      >
        {/* Column header — mirrors the design's requirements table chrome. */}
        <div
          role="row"
          className="flex items-center gap-3 border-b border-border bg-muted/40 px-3.5 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
        >
          <span role="columnheader" className="w-[70px] shrink-0">
            ID
          </span>
          <span role="columnheader" className="w-16 shrink-0">
            Status
          </span>
          <span role="columnheader" className="flex-1">
            Description
          </span>
          <span role="columnheader" className="w-[140px] shrink-0">
            <span className="sr-only">Actions</span>
          </span>
        </div>

        {rows.map((row) => {
          const req = byId.get(row.id);
          if (!req) return null;
          return (
            <RequirementRow
              key={req.id}
              req={req}
              depth={row.depth}
              active={tabStopId === req.id}
              hasChildren={row.hasChildren}
              expanded={row.expanded}
              onToggleCollapse={() => setExpanded(req.id, !row.expanded)}
              rowRef={(el) => {
                if (el) rowEls.current.set(req.id, el);
                else rowEls.current.delete(req.id);
              }}
              onFocusRow={() => setActiveId(req.id)}
              editOnMount={pendingEditId === req.id || keyboardEditId === req.id}
              onEditDone={() => handleEditDone(req.id)}
              onAcceptProposal={() => onAcceptProposal(req)}
              onSendBack={() => onSendBack(req)}
              onUndoSendBack={() => onUndoSendBack(req)}
              canUndoSendBack={req.status === 'retest' && sentBack.has(req.id)}
              onUpdateDescription={(text) => onUpdateDescription(req, text)}
              onAddChild={() => onAddChild(req)}
              onDelete={() => onDelete(req)}
              onRunTest={() => onRunTest(req)}
              running={runningIds.has(req.id)}
            />
          );
        })}
      </div>

      {placeholder && (
        <div className="px-5 py-10 text-center text-xs text-muted-foreground">{placeholder}</div>
      )}

      {/* Inline add-row — create a new root requirement (design's dashed
          skeleton row at the foot of the table). Deliberately outside the
          treegrid: it is not a row, and it stays an ordinary tab stop so the
          keyboard path out of the grid lands on it. */}
      <button
        type="button"
        onClick={onAddRoot}
        className="flex w-full items-center gap-2 border-t border-dashed border-border px-3.5 py-2.5 text-left text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted/40"
      >
        <Plus className="size-3.5" aria-hidden />
        New requirement
      </button>
    </div>
  );
}

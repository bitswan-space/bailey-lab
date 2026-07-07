import { useMemo } from 'react';
import { Plus } from 'lucide-react';
import type { Requirement } from '@/lib/api';
import { RequirementRow } from './RequirementRow';

interface Props {
  requirements: Requirement[];
  /** True while the initial list is still loading. */
  loading?: boolean;
  /** Newly created requirement id that should mount in edit mode. */
  pendingEditId: string | null;
  onEditDone: () => void;
  onCycleStatus: (req: Requirement) => void;
  onUpdateDescription: (req: Requirement, text: string) => void;
  onAddChild: (parent: Requirement) => void;
  /** Create a new root-level requirement (the dashed add-row at the bottom). */
  onAddRoot: () => void;
  onDelete: (req: Requirement) => void;
  onRunAgent: (req: Requirement) => void;
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

export function RequirementsTable({
  requirements,
  loading = false,
  pendingEditId,
  onEditDone,
  onCycleStatus,
  onUpdateDescription,
  onAddChild,
  onAddRoot,
  onDelete,
  onRunAgent,
  onRunTest,
  runningIds,
}: Props) {
  const rows = useMemo(() => flatten(requirements), [requirements]);
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-white">
      {/* Column header — mirrors the design's requirements table chrome. */}
      <div className="flex items-center gap-3 border-b border-border bg-muted/40 px-3.5 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span className="w-[70px] shrink-0">ID</span>
        <span className="w-16 shrink-0">Status</span>
        <span className="flex-1">Description</span>
        <span className="w-[140px] shrink-0" />
      </div>

      {loading && rows.length === 0 ? (
        <div className="px-5 py-10 text-center text-xs text-muted-foreground">
          Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="px-5 py-10 text-center text-xs text-muted-foreground">
          No requirements match your filter.
        </div>
      ) : (
        rows.map(({ req, depth }) => (
          <RequirementRow
            key={req.id}
            req={req}
            depth={depth}
            editOnMount={pendingEditId === req.id}
            onEditDone={onEditDone}
            onCycleStatus={() => onCycleStatus(req)}
            onUpdateDescription={(text) => onUpdateDescription(req, text)}
            onAddChild={() => onAddChild(req)}
            onDelete={() => onDelete(req)}
            onRunAgent={() => onRunAgent(req)}
            onRunTest={() => onRunTest(req)}
            running={runningIds.has(req.id)}
          />
        ))
      )}

      {/* Inline add-row — create a new root requirement (design's dashed
          skeleton row at the foot of the table). */}
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

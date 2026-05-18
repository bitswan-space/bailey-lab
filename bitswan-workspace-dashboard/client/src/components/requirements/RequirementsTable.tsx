import { useMemo } from 'react';
import type { Requirement } from '@/lib/api';
import { RequirementRow } from './RequirementRow';

interface Props {
  requirements: Requirement[];
  /** Newly created requirement id that should mount in edit mode. */
  pendingEditId: string | null;
  onEditDone: () => void;
  onCycleStatus: (req: Requirement) => void;
  onUpdateDescription: (req: Requirement, text: string) => void;
  onAddChild: (parent: Requirement) => void;
  onDelete: (req: Requirement) => void;
  onRunAgent: (req: Requirement) => void;
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
  pendingEditId,
  onEditDone,
  onCycleStatus,
  onUpdateDescription,
  onAddChild,
  onDelete,
  onRunAgent,
}: Props) {
  const rows = useMemo(() => flatten(requirements), [requirements]);
  return (
    <div className="rounded-md border border-border bg-background">
      {rows.length === 0 ? (
        <div className="px-5 py-10 text-center text-xs text-muted-foreground">
          No requirements yet. Click <strong>New requirement</strong> to add the first one.
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
          />
        ))
      )}
    </div>
  );
}

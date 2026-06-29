import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Bot, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Requirement } from '@/lib/api';
import { StatusBadge, nextStatus } from './StatusBadge';

interface Props {
  req: Requirement;
  depth: number;
  /**
   * Truthy when this row was just created and should mount in inline-edit
   * mode (matching the design's "New requirement" flow at
   * project/src/worktree.jsx:892-905). Cleared via `onEditDone`.
   */
  editOnMount?: boolean;
  onEditDone?: () => void;
  onCycleStatus: () => void;
  onUpdateDescription: (text: string) => void;
  onAddChild: () => void;
  onDelete: () => void;
  onRunAgent: () => void;
}

/**
 * One row in the requirements tree. Tree hierarchy is rendered via
 * `paddingLeft = 14 + depth * 18` per the design mockup; children come
 * after the parent in document order from the parent (`RequirementsTable`).
 */
export function RequirementRow({
  req,
  depth,
  editOnMount,
  onEditDone,
  onCycleStatus,
  onUpdateDescription,
  onAddChild,
  onDelete,
  onRunAgent,
}: Props) {
  const [editing, setEditing] = useState(!!editOnMount);
  const [draft, setDraft] = useState(req.description);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setDraft(req.description);
  }, [req.description]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== req.description) {
      onUpdateDescription(next);
    } else {
      // Reset draft to the canonical value so the cancelled edit doesn't
      // leak back into the textarea next time the user opens it.
      setDraft(req.description);
    }
    setEditing(false);
    onEditDone?.();
  };
  const cancel = () => {
    setDraft(req.description);
    setEditing(false);
    onEditDone?.();
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };

  const paddingLeft = 14 + depth * 18;

  return (
    <div
      className="group flex items-start gap-3 border-b border-border bg-background py-2.5 pr-3 transition-colors hover:bg-muted/40"
      style={{ paddingLeft }}
    >
      <div className="flex w-[70px] shrink-0 items-center pt-0.5">
        <span className="font-mono text-[11px] font-semibold text-foreground">{req.id}</span>
      </div>
      <div className="flex w-16 shrink-0 items-center pt-0.5">
        <StatusBadge status={req.status} onClick={onCycleStatus} />
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        {editing ? (
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            onBlur={commit}
            rows={Math.min(8, Math.max(1, draft.split('\n').length))}
            className="w-full resize-y rounded border border-border bg-background px-2 py-1 text-[13px] outline-none focus:border-foreground/30"
            placeholder="Describe the requirement…"
          />
        ) : (
          <button
            type="button"
            onDoubleClick={() => setEditing(true)}
            className="block w-full whitespace-pre-wrap break-words text-left text-[13px] leading-relaxed"
            // The button shape gives keyboard users an accessible edit entry —
            // double-click is the discoverable trigger but Enter (focused)
            // also opens the editor.
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setEditing(true);
              }
            }}
          >
            {req.description || (
              <span className="italic text-muted-foreground">(no description)</span>
            )}
          </button>
        )}
      </div>
      <div className="flex w-[112px] shrink-0 items-center justify-end gap-0.5 pt-0.5 opacity-70 transition-opacity group-hover:opacity-100">
        <IconButton title="Edit description" onClick={() => setEditing(true)}>
          <Pencil className="size-3.5" />
        </IconButton>
        <IconButton title="Add child requirement" onClick={onAddChild}>
          <Plus className="size-3.5" />
        </IconButton>
        <IconButton title="Run agent on this requirement" onClick={onRunAgent}>
          <Bot className="size-3.5" />
        </IconButton>
        <IconButton
          title="Delete requirement"
          onClick={onDelete}
          className="hover:text-destructive"
        >
          <Trash2 className="size-3.5" />
        </IconButton>
      </div>
    </div>
  );
}

function IconButton({
  title,
  onClick,
  className = '',
  children,
}: {
  title: string;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground ${className}`}
    >
      {children}
    </button>
  );
}

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  Undo2,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Requirement } from '@/lib/api';
import { StatusBadge } from './StatusBadge';

interface Props {
  req: Requirement;
  depth: number;
  /**
   * Truthy when this row should be in inline-edit mode: either it was just
   * created (the design's "New requirement" flow at
   * project/src/worktree.jsx:892-905) or the keyboard user pressed Enter on
   * the row. Cleared via `onEditDone`.
   */
  editOnMount?: boolean;
  onEditDone?: () => void;
  /** Accept an AI- proposal into the contract (`proposed` → `pending`). */
  onAcceptProposal: () => void;
  /** Put a passing requirement back in front of the agent (`pass` → `retest`). */
  onSendBack: () => void;
  /** Revert a send-back this person just made (`retest` → `pass`). */
  onUndoSendBack: () => void;
  /** True only while this row is still `retest` AND this person sent it back. */
  canUndoSendBack: boolean;
  onUpdateDescription: (text: string) => void;
  onAddChild: () => void;
  onDelete: () => void;
  /** Run the deterministic test for this requirement in the live-dev container. */
  onRunTest: () => void;
  /** True while this row's test (or an all-run that includes it) is executing. */
  running?: boolean;
  /** True when this row holds the treegrid's single tab stop (#268). */
  active: boolean;
  /** True when this row has children in the tree, collapsed or not. */
  hasChildren: boolean;
  /** Whether those children are currently shown. Meaningless without children. */
  expanded: boolean;
  onToggleCollapse: () => void;
  /** Registers the row element with the table, which owns focus movement. */
  rowRef: (el: HTMLDivElement | null) => void;
  /** Fired whenever focus lands anywhere in this row, to sync the active row. */
  onFocusRow: () => void;
}

/**
 * One row in the requirements tree. Tree hierarchy is rendered via
 * `paddingLeft = 14 + depth * 18` per the design mockup; children come
 * after the parent in document order from the parent (`RequirementsTable`).
 *
 * The row is a `role="row"` in the table's treegrid. Two things follow from
 * that and must not be "tidied" away:
 *
 *  - every control inside carries `tabIndex={-1}`, because the whole grid is a
 *    single tab stop — leaving one tabbable would put N tab stops back in a
 *    keyboard user's path, which is the bug #268 is about;
 *  - `aria-level` carries the depth that `paddingLeft` only draws, so a screen
 *    reader hears the nesting a sighted user sees as indentation.
 */
export function RequirementRow({
  req,
  depth,
  editOnMount,
  onEditDone,
  onAcceptProposal,
  onSendBack,
  onUndoSendBack,
  canUndoSendBack,
  onUpdateDescription,
  onAddChild,
  onDelete,
  onRunTest,
  running = false,
  active,
  hasChildren,
  expanded,
  onToggleCollapse,
  rowRef,
  onFocusRow,
}: Props) {
  const [editing, setEditing] = useState(!!editOnMount);
  const [draft, setDraft] = useState(req.description);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setDraft(req.description);
  }, [req.description]);

  // `editOnMount` is also raised after mount — pressing Enter on a focused row
  // asks this row to open its editor — so this reacts to the prop changing,
  // not just to the initial value.
  useEffect(() => {
    if (editOnMount) setEditing(true);
  }, [editOnMount]);

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
      ref={rowRef}
      role="row"
      data-req-id={req.id}
      aria-level={depth + 1}
      // Only a row that actually has children may claim an expanded state;
      // announcing "collapsed" on a leaf invites a user to open nothing.
      aria-expanded={hasChildren ? expanded : undefined}
      tabIndex={active ? 0 : -1}
      onFocus={onFocusRow}
      className="group flex items-start gap-3 border-b border-border bg-background py-2.5 pr-3 transition-colors hover:bg-muted/40 focus:outline-none focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground/40"
      style={{ paddingLeft }}
    >
      <div role="gridcell" className="flex w-[70px] shrink-0 items-center gap-0.5 pt-0.5">
        {/* Disclosure triangle. Rendered as a fixed-width slot even for leaves
            so ids stay aligned down the column. Mouse users get the same fold
            the keyboard's ←/→ gives. */}
        {hasChildren ? (
          <button
            type="button"
            tabIndex={-1}
            onClick={onToggleCollapse}
            aria-label={expanded ? `Collapse ${req.id}` : `Expand ${req.id}`}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {expanded ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
          </button>
        ) : (
          <span className="inline-block size-4 shrink-0" aria-hidden />
        )}
        <span className="font-mono text-[11px] font-semibold text-foreground">{req.id}</span>
      </div>
      {/* Undo sits beside the badge because it belongs to the row whose state it
          would change, and it disappears on its own the moment that state moves
          on (a test ran, someone else touched it). */}
      <div role="gridcell" className="flex w-24 shrink-0 items-center gap-1 pt-0.5">
        <StatusBadge status={req.status} />
        {canUndoSendBack && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                tabIndex={-1}
                onClick={onUndoSendBack}
                aria-label="Undo send-back"
                className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Undo2 className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              Undo — put it back to <b>pass</b> as the tests left it
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      <div role="gridcell" className="min-w-0 flex-1 pt-0.5">
        {editing ? (
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            onBlur={commit}
            rows={Math.min(8, Math.max(1, draft.split('\n').length))}
            aria-label={`Description of ${req.id}`}
            className="w-full resize-y rounded border border-border bg-background px-2 py-1 text-[13px] outline-none focus:border-foreground/30"
            placeholder="Describe the requirement…"
          />
        ) : (
          <button
            type="button"
            tabIndex={-1}
            onDoubleClick={() => setEditing(true)}
            className="block w-full whitespace-pre-wrap break-words text-left text-[13px] leading-relaxed"
            // Double-click stays the mouse trigger. Enter/Space open the editor
            // when this control itself holds focus; Enter on the *row* does the
            // same via `editOnMount`, so both levels of the grid agree.
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
      <div
        role="gridcell"
        className="flex w-[140px] shrink-0 items-center justify-end gap-0.5 pt-0.5 opacity-70 transition-opacity focus-within:opacity-100 group-hover:opacity-100"
      >
        {/* The two status changes a person can honestly make (#448). Neither is
            shown where it would not apply: a proposal is accepted, a passing
            requirement is sent back to be re-checked. `pass` and `fail` are the
            last test run's verdict and are no longer settable by hand. */}
        {req.status === 'proposed' && (
          <IconButton
            title="Accept this proposal — it joins the contract and gets tested"
            onClick={onAcceptProposal}
            className="hover:text-green-700"
          >
            <Check className="size-3.5" />
          </IconButton>
        )}
        {req.status === 'pass' && (
          <IconButton
            title="Send back to be re-checked — the agent picks it up again"
            onClick={onSendBack}
          >
            <RotateCcw className="size-3.5" />
          </IconButton>
        )}
        <IconButton title="Edit description" onClick={() => setEditing(true)}>
          <Pencil className="size-3.5" />
        </IconButton>
        <IconButton title="Add child requirement" onClick={onAddChild}>
          <Plus className="size-3.5" />
        </IconButton>
        {/* Radix tooltip (not `title`) because the no-test state must explain
            itself on hover, and native tooltips don't show on disabled
            controls. aria-disabled + click guard keeps hover events alive —
            same trick as SpecEditorToolbar. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              tabIndex={-1}
              aria-label={`Run test for ${req.id}`}
              aria-disabled={running || !req.hasTest}
              onClick={running || !req.hasTest ? undefined : onRunTest}
              className={`${ICON_BTN_CLASS} ${
                running || !req.hasTest
                  ? 'cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted-foreground'
                  : 'hover:text-foreground'
              }`}
            >
              {running ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Play className="size-3.5" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {running
              ? 'Running test…'
              : req.hasTest
                ? 'Run this requirement’s test'
                : 'No test written for this requirement yet — write one first (the “Write tests” agent can do it)'}
          </TooltipContent>
        </Tooltip>
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

const ICON_BTN_CLASS =
  'inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted';

function IconButton({
  title,
  onClick,
  className = '',
  disabled = false,
  children,
}: {
  title: string;
  onClick: () => void;
  className?: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      // `title` is the tooltip; it is not reliably announced, so it doubles as
      // the accessible name for these icon-only controls.
      aria-label={title}
      // The grid is one tab stop: controls are reached with ←/→ inside a row,
      // never by Tab. See RequirementsTable.
      tabIndex={-1}
      onClick={onClick}
      disabled={disabled}
      className={`${ICON_BTN_CLASS} hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent ${className}`}
    >
      {children}
    </button>
  );
}

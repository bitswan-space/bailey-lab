import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Pencil,
  Play,
  Plus,
  Trash2,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Requirement, RequirementTestResult } from '@/lib/api';
import { containerFor, rowVerdict } from '@/lib/testStatus';
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
  /** This requirement's state in the current run, or null if it has none. */
  result: RequirementTestResult | null;
  /** The whole run is stale — the code moved on since these verdicts. */
  stale: boolean;
  /** Accept an agent proposal into the contract (clears `origin`). */
  onAcceptProposal: () => void;
  onUpdateDescription: (text: string) => void;
  onAddChild: () => void;
  onDelete: () => void;
  /** Re-run this one requirement's test. */
  onRunTest: () => void;
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
  /** Whether this table renders a container column at all. */
  showContainer?: boolean;
  /**
   * The parent requirement when it is not shown in this same table. Rows are
   * grouped by verdict, so a blocked child and its failing parent end up apart
   * — and indentation, the usual way the tree reads, says nothing across that
   * boundary. Naming the parent keeps the row from looking unrelated.
   */
  parentElsewhere?: Requirement | null;
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
  result,
  stale,
  onAcceptProposal,
  onUpdateDescription,
  onAddChild,
  onDelete,
  onRunTest,
  active,
  hasChildren,
  expanded,
  onToggleCollapse,
  rowRef,
  onFocusRow,
  showContainer = true,
  parentElsewhere,
}: Props) {
  const [editing, setEditing] = useState(!!editOnMount);
  const [draft, setDraft] = useState(req.description);
  const [showOutput, setShowOutput] = useState(false);
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

  const running = result?.verdict === 'running';
  const shown = rowVerdict(result, req.hasTest, stale);
  const failureOutput = result?.verdict === 'fail' ? result.output : '';
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
            so ids stay aligned down the column. It is deliberately the row's
            *first* control: → steps into the row and lands here, so → Enter
            is the keyboard's unfold. (← still folds straight from the row.) */}
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
      <div role="gridcell" className="flex w-24 shrink-0 items-center gap-1 pt-0.5">
        {req.origin === 'proposed' ? (
          <span className="inline-flex items-center rounded-[3px] bg-violet-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-violet-700">
            proposed
          </span>
        ) : (
          <StatusBadge verdict={shown.verdict} stale={shown.stale} />
        )}
        {running && <Loader2 className="size-3 animate-spin text-blue-700" />}
      </div>
      <div role="gridcell" className="min-w-0 flex-1 pt-0.5">
        {parentElsewhere && (
          <p
            className="truncate pb-0.5 text-[11px] text-muted-foreground"
            title={`Parent — ${parentElsewhere.id}: ${parentElsewhere.description}`}
          >
            Parent — <span className="font-mono">{parentElsewhere.id}</span>
            {parentElsewhere.description ? `: ${parentElsewhere.description}` : ''}
          </p>
        )}
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
        {failureOutput && (
          <>
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setShowOutput((v) => !v)}
              className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {showOutput ? (
                <ChevronDown className="size-3" />
              ) : (
                <ChevronRight className="size-3" />
              )}
              {showOutput ? 'Hide failure' : 'Why it failed'}
            </button>
            {showOutput && (
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded bg-red-50 px-2 py-1.5 text-[11px] leading-relaxed text-red-900">
                {failureOutput}
              </pre>
            )}
          </>
        )}
      </div>
      {/* Which container this requirement's test runs in. Worth showing per
          row: a BP can have several, and "it passes" means little without
          knowing where. Read from the BP's own files, so it is known before
          anything has run. Blank for a requirement with no test — nothing runs
          anywhere for it. */}
      {showContainer && (
        <div role="gridcell" className="hidden w-24 shrink-0 items-center pt-0.5 sm:flex">
          {containerFor(req, result) && (
            <span className="truncate font-mono text-[10px] text-muted-foreground">
              {containerFor(req, result)}
            </span>
          )}
        </div>
      )}
      <div
        role="gridcell"
        className="flex w-[140px] shrink-0 items-center justify-end gap-0.5 pt-0.5 opacity-70 transition-opacity focus-within:opacity-100 group-hover:opacity-100"
      >
        {/* A verdict is produced by running a test, so nothing here sets one.
            Accepting a proposal is the one state change a person still makes. */}
        {req.origin === 'proposed' && (
          <IconButton
            title="Accept this proposal — it joins the contract and gets tested"
            onClick={onAcceptProposal}
            className="hover:text-green-700"
          >
            <Check className="size-3.5" />
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
              ? 'Running…'
              : req.hasTest
                ? 'Re-run this requirement’s test'
                : 'No test carries this requirement’s id yet — write one first (the “Write tests” agent can do it)'}
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

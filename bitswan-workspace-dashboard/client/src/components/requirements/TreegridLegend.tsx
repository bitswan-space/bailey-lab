import type { ReactNode } from 'react';

/**
 * One `keys — meaning` pair. Keys are drawn as separate caps so a two-step
 * shortcut (End, then Enter) reads as two presses rather than a chord.
 */
function Hint({ keys, children }: { keys: readonly string[]; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <span className="flex items-center gap-0.5">
        {keys.map((k) => (
          <kbd
            key={k}
            className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-border bg-background px-1 font-sans text-[10px] font-medium text-foreground/70"
          >
            {k}
          </kbd>
        ))}
      </span>
      <span>{children}</span>
    </span>
  );
}

/**
 * The requirements treegrid's key map, shown under the table (#268).
 *
 * The grid is a single tab stop and its controls are only reachable with →,
 * which is efficient but not guessable: in review, three actions were reported
 * missing that in fact worked — adding a requirement, managing children and
 * running a single test — because nothing on screen said how to reach them.
 * Icon-only buttons make that worse, since their `title` tooltips appear on
 * hover and never on keyboard focus. Hence a legend rather than more tooltips.
 *
 * `RequirementsTab` renders this *outside* the scrolling area on purpose — in
 * the scroller it would sit below the fold on any long list, which is exactly
 * the invisibility being fixed.
 */
export function TreegridLegend() {
  return (
    <div
      role="note"
      aria-label="Keyboard shortcuts for the requirements table"
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border bg-muted/30 px-6 py-2 text-[11px] text-muted-foreground"
    >
      <Hint keys={['↑', '↓']}>Move between requirements</Hint>
      <Hint keys={['→']}>Into the row’s buttons — add child, run test, delete</Hint>
      <Hint keys={['←']}>Fold, or out to the parent</Hint>
      <Hint keys={['Enter']}>Edit the description, or press the focused button</Hint>
      <Hint keys={['End', 'Enter']}>New requirement</Hint>
      <Hint keys={['Esc']}>Back to the row</Hint>
      <Hint keys={['Tab']}>Leave the table</Hint>
    </div>
  );
}

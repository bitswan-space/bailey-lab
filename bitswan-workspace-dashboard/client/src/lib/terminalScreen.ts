/**
 * "Is there anything on the terminal's visible screen?"
 *
 * The redraw watcher in Terminal.tsx nudges the remote whenever the answer is
 * no, so this predicate is the whole basis of that decision — and it is easy
 * to get subtly wrong in ways that only show up against a live agent. Both
 * ways were hit while fixing bailey-lab #456: counting *bytes received*
 * instead of *pixels drawn* reads ~325 bytes of ssh and dtach plumbing as a
 * painted screen, and reading the buffer without honouring `viewportY` finds
 * scrollback that is not on screen.
 */

/** The parts of xterm's `IBuffer` this needs — kept narrow so it can be tested. */
export interface ScreenBuffer {
  /** First line of the visible screen, as an index into the whole buffer. */
  viewportY: number;
  getLine(index: number): { translateToString(trimRight?: boolean): string } | undefined;
}

/**
 * True when any visible row holds something other than whitespace. A row of
 * spaces is blank: a full-screen TUI that has been cleared leaves exactly
 * that, and it is the state the watcher exists to notice.
 */
export function screenHasContent(buffer: ScreenBuffer, rows: number): boolean {
  for (let i = 0; i < rows; i++) {
    const line = buffer.getLine(buffer.viewportY + i);
    if ((line?.translateToString(true) ?? '').trim() !== '') return true;
  }
  return false;
}

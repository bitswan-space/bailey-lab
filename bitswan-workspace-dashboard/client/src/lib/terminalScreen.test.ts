import assert from 'node:assert/strict';
import { test } from 'node:test';
import { screenHasContent, type ScreenBuffer } from './terminalScreen.ts';

/** A buffer of literal lines, with the viewport starting at `viewportY`. */
function bufferOf(lines: string[], viewportY = 0): ScreenBuffer {
  return {
    viewportY,
    getLine: (i) =>
      i >= 0 && i < lines.length
        ? { translateToString: () => lines[i] ?? '' }
        : undefined,
  };
}

test('an empty screen has no content', () => {
  assert.equal(screenHasContent(bufferOf(['', '', '']), 3), false);
});

test('a screen of spaces is still empty', () => {
  // What a cleared full-screen TUI leaves behind, and the exact state the
  // redraw watcher exists to notice.
  assert.equal(screenHasContent(bufferOf(['   ', '     ', '  ']), 3), false);
});

test('one glyph anywhere on screen counts', () => {
  assert.equal(screenHasContent(bufferOf(['', ' x ', '']), 3), true);
  assert.equal(screenHasContent(bufferOf(['top', '', '']), 3), true);
  assert.equal(screenHasContent(bufferOf(['', '', 'bottom']), 3), true);
});

test('scrollback above the viewport does not count', () => {
  // The viewport is what the user is looking at. Content scrolled off the top
  // is not evidence that the screen was repainted.
  const buf = bufferOf(['old output', 'more old', '', '', ''], 2);
  assert.equal(screenHasContent(buf, 3), false);
});

test('nor does anything below the visible rows', () => {
  // The viewport is two rows tall here, so the third line is off screen.
  const buf = bufferOf(['', '', 'below the fold'], 0);
  assert.equal(screenHasContent(buf, 2), false);
  // …and comes into view when the viewport is that tall.
  assert.equal(screenHasContent(buf, 3), true);
});

test('a short buffer is not content', () => {
  // getLine returns undefined past the end; that must read as blank rather
  // than throw or count.
  assert.equal(screenHasContent(bufferOf([]), 24), false);
});

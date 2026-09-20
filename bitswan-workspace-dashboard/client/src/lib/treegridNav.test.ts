import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  descendantIds,
  hasChildren,
  navigate,
  parentIndexOf,
  visibleRows,
  type TreeRow,
  type VisibleRow,
} from './treegridNav.ts';

/**
 * REQ-1
 *   REQ-1.1
 *     REQ-1.1.1
 *   REQ-1.2
 * REQ-2
 * REQ-3
 */
const TREE: TreeRow[] = [
  { id: 'REQ-1', depth: 0 },
  { id: 'REQ-1.1', depth: 1 },
  { id: 'REQ-1.1.1', depth: 2 },
  { id: 'REQ-1.2', depth: 1 },
  { id: 'REQ-2', depth: 0 },
  { id: 'REQ-3', depth: 0 },
];

const ids = (rows: readonly VisibleRow[]) => rows.map((r) => r.id);
const open = (...collapsed: string[]) => visibleRows(TREE, new Set(collapsed));

test('depth alone recovers who has children and who is a parent', () => {
  assert.equal(hasChildren(TREE, 0), true); // REQ-1
  assert.equal(hasChildren(TREE, 2), false); // REQ-1.1.1, deepest leaf
  assert.equal(hasChildren(TREE, 5), false); // REQ-3, last row
  assert.equal(parentIndexOf(TREE, 2), 1); // REQ-1.1.1 -> REQ-1.1
  assert.equal(parentIndexOf(TREE, 3), 0); // REQ-1.2 -> REQ-1, skipping the nephew
  assert.equal(parentIndexOf(TREE, 4), -1); // REQ-2 is a root
});

test('collapsing a row hides its whole subtree, grandchildren included', () => {
  // REQ-1.1.1 is a grandchild and is not itself marked collapsed, but it must
  // still go — collapsing is by depth, not by membership in the set.
  assert.deepEqual(ids(open('REQ-1')), ['REQ-1', 'REQ-2', 'REQ-3']);
  assert.deepEqual(ids(open('REQ-1.1')), ['REQ-1', 'REQ-1.1', 'REQ-1.2', 'REQ-2', 'REQ-3']);
  assert.deepEqual(ids(open()), TREE.map((r) => r.id));
});

test('a leaf marked collapsed changes nothing and never reads as collapsed', () => {
  // Stale ids linger in the collapsed set after a delete or a filter change.
  assert.deepEqual(ids(open('REQ-3', 'REQ-GONE')), TREE.map((r) => r.id));
  assert.equal(open('REQ-3').find((r) => r.id === 'REQ-3')?.expanded, false);
  assert.equal(open('REQ-3').find((r) => r.id === 'REQ-3')?.hasChildren, false);
});

test('down and up step through visible rows and stop at the ends', () => {
  const rows = open();
  assert.deepEqual(navigate(rows, 'REQ-1', 'ArrowDown'), { kind: 'move', id: 'REQ-1.1' });
  assert.deepEqual(navigate(rows, 'REQ-1.1', 'ArrowUp'), { kind: 'move', id: 'REQ-1' });
  // Nothing beyond the last row and nothing above the first: return null so the
  // caller leaves the event alone rather than trapping focus.
  assert.equal(navigate(rows, 'REQ-3', 'ArrowDown'), null);
  assert.equal(navigate(rows, 'REQ-1', 'ArrowUp'), null);
});

test('down skips the hidden descendants of a collapsed row', () => {
  // This is the case the flat list gets wrong if you walk the unfiltered array:
  // from REQ-1 collapsed, the next row is REQ-2, not REQ-1.1.
  assert.deepEqual(navigate(open('REQ-1'), 'REQ-1', 'ArrowDown'), {
    kind: 'move',
    id: 'REQ-2',
  });
  assert.deepEqual(navigate(open(), 'REQ-1', 'ArrowDown'), {
    kind: 'move',
    id: 'REQ-1.1',
  });
});

test('left closes an open parent, then climbs to the parent once closed', () => {
  assert.deepEqual(navigate(open(), 'REQ-1.1', 'ArrowLeft'), {
    kind: 'collapse',
    id: 'REQ-1.1',
  });
  // Same row, now already collapsed: the second press moves up a level.
  assert.deepEqual(navigate(open('REQ-1.1'), 'REQ-1.1', 'ArrowLeft'), {
    kind: 'move',
    id: 'REQ-1',
  });
  // A leaf has nothing to close, so it climbs on the first press.
  assert.deepEqual(navigate(open(), 'REQ-1.2', 'ArrowLeft'), { kind: 'move', id: 'REQ-1' });
  // A root with nothing to close has nowhere to go.
  assert.equal(navigate(open(), 'REQ-2', 'ArrowLeft'), null);
});

test('right steps into the row whether or not it is folded', () => {
  // The point of the rule: a folded parent's buttons are reachable without
  // first dumping its whole subtree on screen. → never unfolds.
  assert.deepEqual(navigate(open('REQ-1'), 'REQ-1', 'ArrowRight'), {
    kind: 'enterRow',
    id: 'REQ-1',
  });
  assert.deepEqual(navigate(open(), 'REQ-1', 'ArrowRight'), {
    kind: 'enterRow',
    id: 'REQ-1',
  });
  // A leaf behaves identically, so there is only one rule to learn.
  assert.deepEqual(navigate(open(), 'REQ-3', 'ArrowRight'), {
    kind: 'enterRow',
    id: 'REQ-3',
  });
  // ← still folds straight from the row. The pair is deliberately not
  // symmetric: unfolding moved to the chevron (the row's first control),
  // collapsing stayed on the key because it never hides what you are on.
  assert.deepEqual(navigate(open(), 'REQ-1', 'ArrowLeft'), {
    kind: 'collapse',
    id: 'REQ-1',
  });
});

test('plus adds a requirement from anywhere in the grid', () => {
  const rows = open();
  assert.deepEqual(navigate(rows, 'REQ-2', '+'), { kind: 'addRoot' });
  // "=" is "+" without Shift on a US layout.
  assert.deepEqual(navigate(rows, 'REQ-2', '='), { kind: 'addRoot' });
  // It belongs to the grid, not to a row: no active row, or one that has been
  // filtered away, must not change the answer.
  assert.deepEqual(navigate(rows, null, '+'), { kind: 'addRoot' });
  assert.deepEqual(navigate(rows, 'filtered-away', '+'), { kind: 'addRoot' });
  // Anything else is still not ours.
  assert.equal(navigate(rows, 'REQ-2', 'p'), null);
  // Ctrl/Cmd + "+" must stay with the browser's zoom. navigate() is given only
  // the key name, so that guard lives in the component — see the browser tests.
});

test('home, end and enter address the grid and the row', () => {
  const rows = open();
  assert.deepEqual(navigate(rows, 'REQ-2', 'Home'), { kind: 'move', id: 'REQ-1' });
  assert.deepEqual(navigate(rows, 'REQ-2', 'End'), { kind: 'move', id: 'REQ-3' });
  assert.deepEqual(navigate(rows, 'REQ-2', 'Enter'), { kind: 'activate', id: 'REQ-2' });
});

test('a stale active row never strands the keyboard user', () => {
  const rows = open();
  // Filtered away, deleted, or hidden under a collapse: any navigation key
  // lands on a real row instead of doing nothing.
  assert.deepEqual(navigate(rows, 'REQ-DELETED', 'ArrowDown'), {
    kind: 'move',
    id: 'REQ-1',
  });
  assert.deepEqual(navigate(rows, null, 'ArrowUp'), { kind: 'move', id: 'REQ-1' });
  assert.deepEqual(navigate(rows, null, 'End'), { kind: 'move', id: 'REQ-3' });
});

test('keys the grid does not own are left to the browser', () => {
  const rows = open();
  // Tab above all: the grid must stay a single tab stop that can be escaped.
  for (const key of ['Tab', 'Escape', 'a', ' ', 'PageDown']) {
    assert.equal(navigate(rows, 'REQ-1', key), null, `expected ${key} to pass through`);
  }
  assert.equal(navigate([], 'REQ-1', 'ArrowDown'), null);
});

test('a subtree is every row nested under a parent, at any depth', () => {
  // The whole subtree, not just direct children — collapsing REQ-1 hides the
  // grandchild too, so focus rescue has to know about it.
  assert.deepEqual(descendantIds(TREE, 'REQ-1'), ['REQ-1.1', 'REQ-1.1.1', 'REQ-1.2']);
  assert.deepEqual(descendantIds(TREE, 'REQ-1.1'), ['REQ-1.1.1']);
  // Stops at the next row of equal-or-shallower depth: REQ-2 is not REQ-1.2's.
  assert.deepEqual(descendantIds(TREE, 'REQ-1.2'), []);
  assert.deepEqual(descendantIds(TREE, 'REQ-3'), []);
  assert.deepEqual(descendantIds(TREE, 'REQ-GONE'), []);
});

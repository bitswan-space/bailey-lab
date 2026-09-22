import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Requirement } from './api.ts';
import { flattenForDisplay } from './requirementTree.ts';

function req(id: string, parent = '', description = ''): Requirement {
  return {
    id,
    parent,
    description,
    origin: '',
    automation: '',
    runner: '',
    framework: '',
  };
}

test('a tree renders parents before children, indented', () => {
  const all = [req('C', 'B'), req('A'), req('B', 'A')];
  const rows = flattenForDisplay(all);
  assert.deepEqual(
    rows.map((r) => [r.req.id, r.depth]),
    [
      ['A', 0],
      ['B', 1],
      ['C', 2],
    ],
  );
});

test('a child shown without its parent names the parent instead', () => {
  // The case that prompted this: grouping is by verdict, so a blocked child
  // and the failing parent that blocked it land in different tables, where
  // indentation can say nothing.
  const all = [req('REQ-PPPP', '', 'Totals are correct'), req('REQ-CCCC', 'REQ-PPPP')];
  const rows = flattenForDisplay([all[1]!], all);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.depth, 0);
  assert.equal(rows[0]!.parentElsewhere?.id, 'REQ-PPPP');
  assert.equal(rows[0]!.parentElsewhere?.description, 'Totals are correct');
});

test('a child shown WITH its parent does not repeat it', () => {
  // Indentation already says it; a label too would be noise on every row.
  const all = [req('REQ-PPPP'), req('REQ-CCCC', 'REQ-PPPP')];
  const rows = flattenForDisplay(all, all);
  assert.equal(rows[1]!.parentElsewhere, null);
  assert.equal(rows[1]!.depth, 1);
});

test('a root requirement names no parent', () => {
  const rows = flattenForDisplay([req('A')]);
  assert.equal(rows[0]!.parentElsewhere, null);
});

test('an orphan surfaces at the root and names nothing', () => {
  // The parent was deleted — there is nothing to name, and the requirement
  // must not disappear.
  const rows = flattenForDisplay([req('A', 'GONE')]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.depth, 0);
  assert.equal(rows[0]!.parentElsewhere, null);
});

test('a grandchild shown alone names its immediate parent', () => {
  const all = [req('A'), req('B', 'A'), req('C', 'B')];
  const rows = flattenForDisplay([all[2]!], all);
  assert.equal(rows[0]!.parentElsewhere?.id, 'B');
});

test('a partial group keeps the subtree it does contain', () => {
  // B and C are in this group, A is not: B names A, and C stays nested under B.
  const all = [req('A'), req('B', 'A'), req('C', 'B')];
  const rows = flattenForDisplay([all[1]!, all[2]!], all);
  assert.deepEqual(
    rows.map((r) => [r.req.id, r.depth, r.parentElsewhere?.id ?? null]),
    [
      ['B', 0, 'A'],
      ['C', 1, null],
    ],
  );
});

test('every requirement is rendered exactly once', () => {
  const all = [req('A'), req('B', 'A'), req('C', 'GONE'), req('D')];
  const rows = flattenForDisplay(all, all);
  assert.deepEqual(
    rows.map((r) => r.req.id).sort(),
    ['A', 'B', 'C', 'D'],
  );
});

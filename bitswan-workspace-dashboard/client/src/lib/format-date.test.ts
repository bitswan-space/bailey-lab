import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatAbsolute, hasWhen, parseWhen } from './format-date.js';

test('an ISO instant from the wire is a real date', () => {
  assert.equal(parseWhen('2026-09-05T14:35:34+00:00'), Date.UTC(2026, 8, 5, 14, 35, 34));
});

test('an audit record written before gitops emitted ISO still reads as a time', () => {
  // What bitswan.yaml holds for every freeze and sign-off made before the fix:
  // a display string. Date.parse refuses it, so the UI showed "—".
  assert.equal(parseWhen('May 06, 2026 · 14:02'), Date.UTC(2026, 4, 6, 14, 2));
  assert.equal(hasWhen('May 06, 2026 · 14:02'), true);
  assert.match(formatAbsolute('May 06, 2026 · 14:02'), /May 6, 2026/);
});

test('a string that is neither shape has no date to show', () => {
  assert.equal(parseWhen('two tuesdays ago'), undefined);
  assert.equal(parseWhen(''), undefined);
  assert.equal(parseWhen(null), undefined);
});

test('the epoch and Go’s zero time are absent, not ancient', () => {
  assert.equal(parseWhen(0), undefined);
  assert.equal(parseWhen('0001-01-01T00:00:00Z'), undefined);
});

/**
 * The experiment name generator must respect the budget gitops reports for the
 * workspace it is talking to.
 *
 * The limit is not a constant: gitops derives it from the longest
 * business-process slug, because `copy_<name>_bp_<bp>` is truncated at 63
 * characters. The generator used to carry a hard-coded 40, so on a workspace
 * whose budget was smaller (e.g. 36, with a single `invoice-processing`
 * process) any title long enough to reach 40 produced a name gitops rejected
 * with a 400 — which is what "creating an experiment sometimes fails" was.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { experimentNameFromTitle } from './copies.ts';

const LONG_TITLE = 'Check vendor VAT-IDs against ARES';

test('the generated name never exceeds the budget it is given', () => {
  for (const maxLen of [12, 20, 36, 40, 63]) {
    const name = experimentNameFromTitle(LONG_TITLE, maxLen);
    assert.ok(
      name.length <= maxLen,
      `budget ${maxLen}: got ${name.length} chars (${name})`,
    );
  }
});

test('the real-world case that used to 400: budget 36, a 33-char title', () => {
  // 'exp-' + slug + '-' + 4 hex. With the old hard-coded 40 this produced a
  // 40-char name on a workspace whose budget was 36.
  const name = experimentNameFromTitle(LONG_TITLE, 36);
  assert.ok(name.length <= 36, `got ${name.length} chars: ${name}`);
  assert.match(name, /^exp-[a-z0-9-]*[a-z0-9]-[0-9a-f]{4}$/);
});

test('only the slug is trimmed — the prefix and the hex suffix survive', () => {
  const name = experimentNameFromTitle(LONG_TITLE, 12);
  assert.ok(name.startsWith('exp-'), name);
  assert.match(name, /-[0-9a-f]{4}$/, name);
});

test('a title with nothing sluggable still yields a usable name', () => {
  const name = experimentNameFromTitle('!!! ???', 36);
  assert.match(name, /^exp-experiment-[0-9a-f]{4}$/);
});

test('the name never contains the deployment-id separator', () => {
  // `-copy-` in a copy name would make deployment ids ambiguous; gitops
  // rejects it, so the generator must not produce it from a title either.
  const name = experimentNameFromTitle('my copy of the copy flow', 40);
  assert.ok(!name.includes('-copy-'), name);
});

test('names are unique across calls with the same title', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) seen.add(experimentNameFromTitle(LONG_TITLE, 36));
  assert.ok(seen.size > 40, `only ${seen.size} distinct names in 50 draws`);
});

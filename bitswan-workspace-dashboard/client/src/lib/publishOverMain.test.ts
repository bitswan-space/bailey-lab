import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  describeSuperseded,
  publishConfirmed,
  PUBLISH_OVER_MAIN_OUTCOME,
  type SupersededCommit,
} from './publishOverMain.ts';

function commit(
  sha: string,
  subject: string,
  author: string,
  author_name: string,
): SupersededCommit {
  return { sha, subject, author, author_name, date: '2026-08-07T10:00:00+00:00' };
}

test('the summary counts PEOPLE, not just commits', () => {
  const rows = [
    commit('a1', 'fix the tax rate', 'ada@x', 'Ada Lovelace'),
    commit('b2', 'tidy up', 'bo@x', 'Bo Chen'),
    commit('c3', 'and again', 'ada@x', 'Ada Lovelace'),
  ];
  assert.equal(
    describeSuperseded(rows),
    '3 commits by 2 people (Ada Lovelace, Bo Chen)',
  );
});

test('the same person under two spellings of their name is one person', () => {
  const rows = [
    commit('a1', 'one', 'Ada@X', 'ada'),
    commit('a2', 'two', 'ada@x', 'Ada Lovelace'),
  ];
  assert.equal(describeSuperseded(rows), '2 commits by 1 person (ada)');
});

test('nothing to supersede is said as nothing, never as an empty list', () => {
  assert.match(describeSuperseded([]), /^nothing —/);
});

test('the confirm needs the exact slug, forgiving only whitespace', () => {
  assert.equal(publishConfirmed('compost', 'compost'), true);
  assert.equal(publishConfirmed('  compost \n', 'compost'), true);
  assert.equal(publishConfirmed('Compost', 'compost'), false);
  assert.equal(publishConfirmed('compos', 'compost'), false);
  assert.equal(publishConfirmed('', 'compost'), false);
  assert.equal(publishConfirmed('compost extra', 'compost'), false);
});

test('the dialog states one outcome, and states the part that loses something', () => {
  const text = PUBLISH_OVER_MAIN_OUTCOME.join(' ');
  // The whole point of removing the two modes: there is one answer, and the
  // user is told the cost of it rather than asked to pick a merge rule.
  assert.match(text, /exactly your version/i);
  assert.match(text, /dropping anything main added that you do not have/i);
  // …and the history promise that makes it a replay rather than a snapshot.
  assert.match(text, /each one arrives on main as itself/i);
  assert.match(text, /nothing is force-pushed/i);
  // No merge-strategy vocabulary survives: it named a choice that no longer
  // exists, and "recommended" implied there was another one worth having.
  assert.doesNotMatch(text, /recommended|wins the overlaps|merge rule/i);
});

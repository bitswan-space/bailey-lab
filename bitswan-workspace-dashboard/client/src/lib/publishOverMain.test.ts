import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  describeSuperseded,
  publishConfirmed,
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

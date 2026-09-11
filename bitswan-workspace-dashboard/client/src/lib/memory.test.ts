import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fmtMiB, memoryPair } from './memory.ts';

test('both halves of the chip are in the same unit', () => {
  // The bug this pins: usage was rendered MiB (1024-based) and the reservation
  // labelled MB, so "45.5 MiB / 50 MB" read as a fraction of two different
  // units — 50 MB is 47.7 MiB — while the over-reservation flag next to it
  // fires on the MiB reading.
  const pair = memoryPair(47_710_208, 50);
  assert.equal(pair, '45.5 MiB / 50 MiB');
  const units = pair.match(/[KMG]i?B/g);
  assert.deepEqual(units, ['MiB', 'MiB']);
});

test('an unread usage is a dash, and a read zero is a zero', () => {
  // Same distinction the restart count makes: not having read a number is not
  // the same claim as having read nothing being used.
  assert.equal(memoryPair(undefined, 50), '— / 50 MiB');
  assert.equal(memoryPair(0, 50), '0 B / 50 MiB');
});

test('a container with no declared reservation says so on both halves', () => {
  assert.equal(memoryPair(1024 * 1024, undefined), '1 MiB / — MiB');
});

test('fmtMiB scales on 1024, matching what the daemon budgets in', () => {
  assert.equal(fmtMiB(1024), '1 KiB');
  assert.equal(fmtMiB(1024 * 1024), '1 MiB');
  assert.equal(fmtMiB(1536 * 1024 * 1024), '1.5 GiB');
});

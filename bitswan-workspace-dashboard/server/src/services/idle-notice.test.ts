import assert from 'node:assert/strict';
import { test } from 'node:test';
import { idleNoticeMessage } from './terminal-session.js';

test('the default 30-minute timeout says 30 min', () => {
  assert.equal(idleNoticeMessage(30 * 60_000), 'Closed after 30 min of inactivity');
});

test('an override that is not whole minutes is stated in seconds', () => {
  // The server must not name a duration it did not use. Rounding 90 s to the
  // nearest minute told the user "2 min" for a 90-second timeout.
  assert.equal(idleNoticeMessage(90_000), 'Closed after 90 s of inactivity');
  assert.equal(idleNoticeMessage(45_000), 'Closed after 45 s of inactivity');
});

test('whole minutes are still minutes', () => {
  assert.equal(idleNoticeMessage(60_000), 'Closed after 1 min of inactivity');
  assert.equal(idleNoticeMessage(5 * 60_000), 'Closed after 5 min of inactivity');
});

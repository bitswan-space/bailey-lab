import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SIDEBAR_MAX_ATTEMPTS,
  canMountPanel,
  shouldKeepPolling,
  sidebarStateAfterCheck,
} from './sidebarAvailability.ts';

/**
 * The bug this file exists for: the tab mounted the iframe without asking
 * whether there was a panel behind it, so the user was shown the /view route's
 * JSON refusal — `{"error":"sidebar not available"}` — rendered as the panel.
 * Mounting is now gated on a `ready` answer and nothing else.
 */
test('the panel is mounted only once the server says the extension is there', () => {
  assert.equal(canMountPanel(sidebarStateAfterCheck(true, 1)), true);

  for (const state of [
    sidebarStateAfterCheck(false, 1),
    sidebarStateAfterCheck(false, SIDEBAR_MAX_ATTEMPTS),
    { kind: 'checking' } as const,
    { kind: 'error', message: 'nope' } as const,
  ]) {
    assert.equal(canMountPanel(state), false, `must not mount while ${state.kind}`);
  }
});

test('available on the first check is ready immediately — no waiting state', () => {
  assert.deepEqual(sidebarStateAfterCheck(true, 1), { kind: 'ready' });
});

test('unavailable early is "preparing": the entrypoint downloads after the server answers', () => {
  assert.deepEqual(sidebarStateAfterCheck(false, 1), { kind: 'preparing' });
  assert.deepEqual(sidebarStateAfterCheck(false, SIDEBAR_MAX_ATTEMPTS - 1), { kind: 'preparing' });
});

test('past the window it stops claiming a download is in flight', () => {
  assert.deepEqual(sidebarStateAfterCheck(false, SIDEBAR_MAX_ATTEMPTS), { kind: 'unavailable' });
  assert.deepEqual(sidebarStateAfterCheck(false, SIDEBAR_MAX_ATTEMPTS + 5), { kind: 'unavailable' });
});

test('a sidebar that turns up late is still picked up', () => {
  // The whole point of polling: "not yet" must never be final before the cap.
  assert.deepEqual(sidebarStateAfterCheck(true, SIDEBAR_MAX_ATTEMPTS + 5), { kind: 'ready' });
});

test('only the waiting state is re-asked', () => {
  assert.equal(shouldKeepPolling({ kind: 'preparing' }), true);
  for (const state of [
    { kind: 'ready' } as const,
    { kind: 'unavailable' } as const,
    { kind: 'checking' } as const,
    // Not retried on purpose: getJson has already retried the blips, so an
    // error reaching us is real and must be shown, not spun on.
    { kind: 'error', message: 'boom' } as const,
  ]) {
    assert.equal(shouldKeepPolling(state), false, `${state.kind} must not poll`);
  }
});

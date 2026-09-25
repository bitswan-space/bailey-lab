import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OPENCODE_MAX_STARTING_CHECKS,
  canMountPanel,
  opencodeStateAfterCheck,
  shouldKeepPolling,
} from './opencodeAvailability.ts';

test('the panel mounts only on a ready answer that names a conversation', () => {
  assert.deepEqual(opencodeStateAfterCheck({ state: 'ready', sessionId: 'ses_1' }, 1), {
    kind: 'ready',
    sessionId: 'ses_1',
  });
  assert.equal(canMountPanel(opencodeStateAfterCheck({ state: 'ready', sessionId: 'ses_1' }, 1)), true);
  // "ready" with nothing to open is a server bug, shown as such rather than mounted.
  assert.equal(canMountPanel(opencodeStateAfterCheck({ state: 'ready' }, 1)), false);
  for (const state of [
    opencodeStateAfterCheck({ state: 'starting' }, 1),
    opencodeStateAfterCheck({ state: 'unavailable', reason: 'no binary' }, 1),
    opencodeStateAfterCheck({ state: 'error', reason: 'ssh failed' }, 1),
    { kind: 'checking' } as const,
  ]) {
    assert.equal(canMountPanel(state), false, state.kind);
  }
});

test('only "starting" is worth asking again about', () => {
  assert.equal(shouldKeepPolling(opencodeStateAfterCheck({ state: 'starting' }, 1)), true);
  assert.equal(shouldKeepPolling(opencodeStateAfterCheck({ state: 'error', reason: 'x' }, 1)), false);
  assert.equal(shouldKeepPolling(opencodeStateAfterCheck({ state: 'unavailable' }, 1)), false);
});

test('a start that never finishes becomes an error instead of a spinner forever', () => {
  assert.deepEqual(opencodeStateAfterCheck({ state: 'starting' }, OPENCODE_MAX_STARTING_CHECKS - 1), {
    kind: 'starting',
  });
  assert.equal(opencodeStateAfterCheck({ state: 'starting' }, OPENCODE_MAX_STARTING_CHECKS).kind, 'error');
});

test('"not installed" says so, with the server’s reason when it gives one', () => {
  assert.deepEqual(opencodeStateAfterCheck({ state: 'unavailable', reason: 'no opencode in image' }, 1), {
    kind: 'unavailable',
    reason: 'no opencode in image',
  });
  assert.equal(opencodeStateAfterCheck({ state: 'unavailable' }, 1).kind, 'unavailable');
});

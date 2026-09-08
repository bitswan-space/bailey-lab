import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decideAfterAgentExit,
  HEALTHY_SESSION_MS,
  RELAUNCH_BACKOFF_MS,
  type AgentExitFacts,
} from './agentSessionExit.ts';

/** A close of a socket that opened, ran, and ended normally. */
function ended(over: Partial<AgentExitFacts> = {}): AgentExitFacts {
  return {
    opened: true,
    closeCode: 1000,
    ageMs: HEALTHY_SESSION_MS + 1,
    failedAttempts: 0,
    ...over,
  };
}

test('an idle-closed session is replaced at once', () => {
  // The server closes with 1000 after 30 min of double-silence. That is the
  // timeout doing its job on a session that was working, so the tab starts
  // its replacement immediately — no backoff, no error.
  const d = decideAfterAgentExit(ended({ ageMs: 30 * 60_000 }));
  assert.deepEqual(d, { relaunch: 'immediately' });
});

test('a live session whose network dropped is replaced at once too', () => {
  // 1006, but the socket HAD opened: a real session, abnormally cut off
  // (laptop slept, wifi blipped). Same answer as any other healthy end.
  const d = decideAfterAgentExit(ended({ closeCode: 1006 }));
  assert.deepEqual(d, { relaunch: 'immediately' });
});

test('a socket that never opened is retried, not counted as a healthy end', () => {
  // bailey-lab #437, the whole point of this module. The gate declines the
  // upgrade (its oauth2-proxy session lapsed at the same 30-min mark), so the
  // browser reports a bare 1006 on a socket that never reached OPEN. Read by
  // close code alone it is indistinguishable from the case above — and
  // reading it that way relaunches on a dead gate forever. Read by age alone
  // it is a launch failure. It is neither: nothing ran, and a declined
  // handshake is often momentary, so it is worth another try shortly.
  const d = decideAfterAgentExit({
    opened: false,
    closeCode: 1006,
    ageMs: 40,
    failedAttempts: 0,
  });
  assert.deepEqual(d, { relaunch: 'after', delayMs: RELAUNCH_BACKOFF_MS[0] });
});

test('a socket that never opened is a launch failure however long it hung', () => {
  // A handshake can hang past HEALTHY_SESSION_MS before failing. Age must not
  // promote it to "a healthy session ended" — there was no session.
  const d = decideAfterAgentExit({
    opened: false,
    closeCode: 1006,
    ageMs: 10 * HEALTHY_SESSION_MS,
    failedAttempts: 1,
  });
  assert.deepEqual(d, { relaunch: 'after', delayMs: RELAUNCH_BACKOFF_MS[1] });
});

test('never-opened sockets give up as cannot-connect, not exits-immediately', () => {
  // Out of attempts. The message has to name what actually happened: nothing
  // answered the upgrade. "Exited immediately" would send the reader looking
  // at a container that never got asked to start anything.
  const d = decideAfterAgentExit({
    opened: false,
    closeCode: 1006,
    ageMs: 40,
    failedAttempts: RELAUNCH_BACKOFF_MS.length,
  });
  assert.deepEqual(d, { relaunch: 'no', failure: 'cannot-connect' });
});

test('a session that died on launch backs off, then gives up', () => {
  for (const [attempt, delayMs] of RELAUNCH_BACKOFF_MS.entries()) {
    assert.deepEqual(
      decideAfterAgentExit(ended({ ageMs: 500, failedAttempts: attempt })),
      { relaunch: 'after', delayMs },
      `attempt ${attempt}`,
    );
  }
  assert.deepEqual(
    decideAfterAgentExit(
      ended({ ageMs: 500, failedAttempts: RELAUNCH_BACKOFF_MS.length }),
    ),
    { relaunch: 'no', failure: 'exits-immediately' },
  );
});

test('a refusal is reported without spending an attempt', () => {
  // 1008 (bad request, forbidden resume, not authenticated) and 1011
  // (coding-agent host unreachable) are the server's answers to the request
  // itself. Re-sending it cannot change them.
  for (const closeCode of [1008, 1011]) {
    assert.deepEqual(
      decideAfterAgentExit(ended({ closeCode, ageMs: 200 })),
      { relaunch: 'no', failure: 'refused' },
      `close code ${closeCode}`,
    );
  }
});

test('a refusal on a long-lived session is still a refusal', () => {
  // Ordering guard: the age check must not outrank the close code, or a
  // forbidden resume arriving late would be retried forever.
  const d = decideAfterAgentExit(ended({ closeCode: 1008, ageMs: 60 * 60_000 }));
  assert.deepEqual(d, { relaunch: 'no', failure: 'refused' });
});

test('a close with no code at all is still routed', () => {
  // The browser always gives us one, but the type allows its absence and the
  // one thing we must never do is drop an exit on the floor — that is how
  // #437 left a dead terminal on screen.
  const d = decideAfterAgentExit({
    opened: true,
    ageMs: HEALTHY_SESSION_MS + 1,
    failedAttempts: 0,
  });
  assert.deepEqual(d, { relaunch: 'immediately' });
});

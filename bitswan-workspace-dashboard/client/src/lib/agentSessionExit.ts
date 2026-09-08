/**
 * What the Coding Agent tab does when its session's socket goes away.
 *
 * The tab autostarts the agent and keeps it running (bailey-lab #246), so
 * every close has to route to one of three answers: try again now, try again
 * after a backoff, or stop and tell the user. Getting that routing wrong is
 * how a session ends up dead on screen with no way back, which is exactly
 * what bailey-lab #437 reported: come back to an idle tab and the terminal
 * reads `[connection closed]` for good — reloading the page was the only
 * cure.
 *
 * Two facts drive the answer, and the second one is the one #437 turned on:
 *
 *   * WHY it closed. 1008 / 1011 mean the server refused to spawn anything at
 *     all (bad request, forbidden resume, coding-agent host unreachable);
 *     re-sending the same request cannot fix that, so it is reported rather
 *     than retried.
 *   * WHETHER THE SOCKET EVER OPENED. A socket that never reached OPEN never
 *     had a session behind it — the handshake itself failed, e.g. the Bailey
 *     gate declined the upgrade because the oauth2-proxy session had lapsed
 *     (the browser reports that as a bare 1006 with no server close frame).
 *     That is retryable — the dashboard's own `/api/*` traffic renews the gate
 *     session within seconds, and the next attempt then goes through — but it
 *     must NOT be read as "a session ran and ended", because a fresh session
 *     is younger than HEALTHY_SESSION_MS and would otherwise be counted
 *     against the launch-failure budget on age alone.
 *
 * Age only decides between the two retry flavours: a session that outlived
 * HEALTHY_SESSION_MS was a working agent that ended for its own reasons (the
 * user quit it, the server's idle timeout fired, the network blipped) and is
 * replaced at once with a clean slate of attempts. A younger one died on
 * launch and gets the backoff.
 */

/**
 * A session that dies sooner than this never really got going — the agent
 * failed to launch (bad resume, container wedged, claude not authenticated).
 * One that outlives it was a working agent that ended for its own reasons.
 */
export const HEALTHY_SESSION_MS = 20_000;

/**
 * Backoff before each *re*-launch after a failed one. Its length is also the
 * attempt budget: once it's exhausted we stop and show the error rather than
 * hammering the coding-agent container.
 */
export const RELAUNCH_BACKOFF_MS = [2_000, 8_000, 20_000];

/** Why the tab gave up, once the attempt budget ran out. */
export type AgentLaunchFailure =
  /** The server refused to spawn it — retrying the same request won't help. */
  | 'refused'
  /** Every attempt's socket failed to open: nothing is answering the upgrade. */
  | 'cannot-connect'
  /** The agent started and died on launch, every attempt we had. */
  | 'exits-immediately';

export interface AgentExitFacts {
  /**
   * True when the socket actually reached OPEN before closing. False means
   * the handshake never completed, so no session existed behind it.
   */
  opened: boolean;
  /** WebSocket close code, when the browser reported one. */
  closeCode?: number;
  /** How long the session had been up when it closed, in ms. */
  ageMs: number;
  /** Launch failures already counted against the budget for this scope. */
  failedAttempts: number;
}

export type AgentExitDecision =
  /** Relaunch at once; this session worked, so the attempt budget resets. */
  | { relaunch: 'immediately' }
  /** Relaunch after `delayMs`; this close spends one attempt from the budget. */
  | { relaunch: 'after'; delayMs: number }
  /** Out of attempts (or nothing a retry could fix) — show `failure`. */
  | { relaunch: 'no'; failure: AgentLaunchFailure };

/** The tab's response to one session close. */
export function decideAfterAgentExit(facts: AgentExitFacts): AgentExitDecision {
  if (facts.closeCode === 1008 || facts.closeCode === 1011) {
    return { relaunch: 'no', failure: 'refused' };
  }
  // Never opened: retryable, but never "healthy" — no session ran.
  if (!facts.opened) {
    return backoffOr(facts.failedAttempts, 'cannot-connect');
  }
  if (facts.ageMs >= HEALTHY_SESSION_MS) {
    return { relaunch: 'immediately' };
  }
  return backoffOr(facts.failedAttempts, 'exits-immediately');
}

function backoffOr(
  failedAttempts: number,
  failure: AgentLaunchFailure,
): AgentExitDecision {
  const delayMs = RELAUNCH_BACKOFF_MS[failedAttempts];
  if (delayMs === undefined) return { relaunch: 'no', failure };
  return { relaunch: 'after', delayMs };
}

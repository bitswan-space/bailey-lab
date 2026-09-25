/**
 * What the OpenCode panel shows while its server may not be there yet.
 *
 * The panel is an iframe pointed at the OpenCode UI on this origin. Before it
 * can be mounted the dashboard has to start (or find) the caller's OpenCode
 * server in the coding-agent container and open the port-forward to it, which
 * `/api/coding-agent/opencode/status` does on the caller's behalf and reports
 * on. The states mirror `sidebarAvailability.ts` for the Claude panel, with one
 * difference: "not there" is not a download that will finish on its own but a
 * server start — either it comes up within the window or the reason is shown.
 *
 * Pure, so the client's `node --test` run covers the decision table.
 */

/** The shape `/api/coding-agent/opencode/status` answers with. */
export interface OpenCodeStatusResponse {
  state: 'ready' | 'starting' | 'unavailable' | 'error';
  /** The conversation to open, when `ready` (the BP's latest, or one just created). */
  sessionId?: string;
  /** Why not, otherwise. */
  reason?: string;
  version?: string;
}

export type OpenCodeState =
  /** No answer yet — the first status call is in flight. */
  | { kind: 'checking' }
  /** The server is being started; worth asking again. */
  | { kind: 'starting' }
  /** The server answers; the iframe is safe to mount on the session's page. */
  | { kind: 'ready'; sessionId: string }
  /** OpenCode is not installed in this workspace's agent image. */
  | { kind: 'unavailable'; reason: string }
  /** The start failed, or the status call itself did. */
  | { kind: 'error'; message: string };

/** How often to re-ask while `starting`. */
export const OPENCODE_POLL_MS = 3_000;

/**
 * How many `starting` answers before it becomes an error. The status call
 * itself waits for the start (up to the ssh timeout), so `starting` is rare;
 * two minutes of it means something is stuck.
 */
export const OPENCODE_MAX_STARTING_CHECKS = 40;

/** The state after a status answer. `attempts` counts this call. */
export function opencodeStateAfterCheck(r: OpenCodeStatusResponse, attempts: number): OpenCodeState {
  if (r.state === 'ready' && r.sessionId) return { kind: 'ready', sessionId: r.sessionId };
  if (r.state === 'unavailable') {
    return { kind: 'unavailable', reason: r.reason ?? 'OpenCode is not installed in this workspace' };
  }
  if (r.state === 'starting') {
    if (attempts >= OPENCODE_MAX_STARTING_CHECKS) {
      return { kind: 'error', message: 'the OpenCode server did not come up in time' };
    }
    return { kind: 'starting' };
  }
  return { kind: 'error', message: r.reason ?? 'the OpenCode server could not be reached' };
}

/** Whether to schedule another status call. */
export function shouldKeepPolling(state: OpenCodeState): boolean {
  return state.kind === 'starting';
}

/** Whether the iframe may be mounted. */
export function canMountPanel(state: OpenCodeState): state is { kind: 'ready'; sessionId: string } {
  return state.kind === 'ready';
}

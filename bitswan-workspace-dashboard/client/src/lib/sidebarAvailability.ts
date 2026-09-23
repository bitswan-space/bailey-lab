/**
 * What the Coding Agent tab should show while the sidebar may not exist yet.
 *
 * The panel is an iframe pointed at `/api/coding-agent/sidebar/view`, and that
 * route refuses with a JSON 503 when the extension is not on disk. An iframe
 * has no way to render a refusal — the browser just displays the body — so
 * pointing it at the route before knowing the answer is how the tab came to
 * show a bare `{"error":"sidebar not available"}` to the user.
 *
 * `/status` already answers the question honestly; nothing consumed it. This
 * module is that consumer's decision table, kept pure so it can be tested
 * without a browser (the client's test runner only covers `lib/*.test.ts`).
 *
 * Unavailable is not one state but two, and conflating them is what makes the
 * waiting feel broken:
 *
 *  - `preparing` — the container's entrypoint downloads the extension after
 *    the server is already answering, so on a perfectly healthy workspace
 *    there is always a window where the answer is "not yet". Worth waiting
 *    through, and worth saying so.
 *  - `unavailable` — we have waited past any plausible download and it is
 *    still not there (an extension that was never wired up, a download that
 *    failed). More waiting will not help; say so and offer a retry.
 */

export type SidebarState =
  /** No answer yet — the first `/status` call is in flight. */
  | { kind: 'checking' }
  /** The extension is on disk; the iframe is safe to mount. */
  | { kind: 'ready' }
  /** Not there yet, but within the window where that is expected. */
  | { kind: 'preparing' }
  /** Waited past the window. Still not there. */
  | { kind: 'unavailable' }
  /** `/status` itself could not be reached or understood. */
  | { kind: 'error'; message: string };

/** How often to re-ask `/status` while `preparing`. */
export const SIDEBAR_POLL_MS = 3_000;

/**
 * How many checks before "still downloading" becomes "it is not coming".
 *
 * At a 3s interval this is roughly a minute — comfortably longer than an
 * extension download on a warm volume (the vsix is fetched once and the
 * directory is persistent), and short enough that a workspace whose sidebar
 * was never wired up says so rather than spinning forever.
 */
export const SIDEBAR_MAX_ATTEMPTS = 20;

/**
 * The state after a `/status` call that came back.
 *
 * `attempts` counts this call, so the first check is `attempts === 1`.
 */
export function sidebarStateAfterCheck(available: boolean, attempts: number): SidebarState {
  if (available) return { kind: 'ready' };
  if (attempts >= SIDEBAR_MAX_ATTEMPTS) return { kind: 'unavailable' };
  return { kind: 'preparing' };
}

/**
 * Whether to schedule another `/status` call.
 *
 * Only `preparing` is worth re-asking. A failed check is deliberately NOT
 * retried here: `getJson` already retries the blips that are not the caller's
 * business (a stale token, a router reconfigure), so an error that reaches us
 * is a real one and hiding it behind a spinner would misreport it as waiting.
 */
export function shouldKeepPolling(state: SidebarState): boolean {
  return state.kind === 'preparing';
}

/** Whether the iframe may be mounted. The one question the component asks. */
export function canMountPanel(state: SidebarState): boolean {
  return state.kind === 'ready';
}

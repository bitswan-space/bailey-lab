// App-wide session-expiry signal.
//
// The oauth2-proxy session can expire while the user is working. An API call
// then 401s even after a token refresh (see api.ts) — that's an expired
// SESSION, not just an expired access token. Rather than let every caller
// render that as its own confusing failure ("Failed to set up <bp>", "couldn't
// load …"), we collapse it into ONE signal: the api layer calls
// `notifySessionExpired()`, and a single top-level banner prompts the user to
// log in again (see SessionExpiredBanner).

/** Thrown by the api layer when a request 401s even after a token refresh —
 *  i.e. the oauth2-proxy session is gone. Callers can recognise it and stay
 *  silent (the banner owns the messaging) instead of reporting an operation
 *  failure. */
export class SessionExpiredError extends Error {
  constructor() {
    super('session expired');
    this.name = 'SessionExpiredError';
  }
}

type Listener = () => void;
const listeners = new Set<Listener>();
let expired = false;

/** Raise the session-expired signal. Idempotent: the first call notifies; the
 *  storm of other in-flight requests that also 401 collapses into nothing, so
 *  the banner shows once. Reset only by a full reload (after re-login). */
export function notifySessionExpired(): void {
  if (expired) return;
  expired = true;
  for (const l of listeners) l();
}

export function subscribeSessionExpired(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function isSessionExpired(): boolean {
  return expired;
}

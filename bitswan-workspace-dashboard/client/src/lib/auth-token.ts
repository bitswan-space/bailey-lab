// Access-token plumbing for talking to our own backend.
//
// The dashboard runs inside the Bailey iframe behind the platform
// oauth2-proxy. The Bailey gate strips forwarded-identity request headers from
// app upstreams, so the backend can't learn who we are from headers — it
// validates a Keycloak access token instead (see server/src/lib/user.ts).
//
// We obtain that token exactly like a business-process frontend does: fetch
// the proxy's `/oauth2/auth` endpoint (same-origin, cookie-authenticated) and
// read the token from the `X-Auth-Request-Access-Token` response header (the
// platform proxy sets it via --set-xauthrequest + --pass-access-token). The
// token is then sent as a Bearer header on `/api/*` calls, and as the
// `access_token` query param on WebSocket opens (which can't set headers).

let cachedToken: string | null = null;
let inflight: Promise<string | null> | null = null;

async function fetchToken(): Promise<string | null> {
  try {
    const r = await fetch('/oauth2/auth', { credentials: 'include', cache: 'no-store' });
    if (!r.ok) return null;
    return r.headers.get('X-Auth-Request-Access-Token');
  } catch {
    return null;
  }
}

/**
 * Return the current access token, fetching+caching it on first use.
 * De-duplicates concurrent callers so a burst of API calls triggers one
 * `/oauth2/auth` round-trip, not N.
 */
export async function getAccessToken(): Promise<string | null> {
  if (cachedToken) return cachedToken;
  if (!inflight) {
    inflight = fetchToken().then((t) => {
      cachedToken = t;
      inflight = null;
      return t;
    });
  }
  return inflight;
}

/**
 * Drop the cached token so the next getAccessToken() re-fetches from
 * `/oauth2/auth`. Called after a 401 — the token may have expired, and
 * re-fetching also refreshes the Keycloak session via the proxy cookie.
 */
export function clearAccessToken(): void {
  cachedToken = null;
}

/** Authorization header for fetch, or {} when no token is available. */
export async function authHeader(): Promise<Record<string, string>> {
  const t = await getAccessToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/**
 * Whether the Bailey gate still has a session for this browser.
 *
 * `/oauth2/auth` is the gate's own auth-check endpoint: same-origin, and it
 * ANSWERS rather than redirects — 401 when there is no session. That matters,
 * because it is the only way the page can find this out. An `/api/*` call
 * gets a 302 to Keycloak, which is cross-origin, so `fetch` cannot follow it
 * to a readable answer; and a WebSocket upgrade just fails. Measured against
 * a lapsed session (bailey-lab #437): `/oauth2/auth` → 401, `/api/…` → 302 to
 * the Keycloak authorize endpoint.
 *
 * Only a literal 401 is read as signed out. A network error, a 5xx, a
 * captive-portal HTML page — none of those are evidence that the user's
 * session is gone, and telling someone to sign in again when the real fault
 * was a dropped packet sends them the wrong way. Those are `unknown`, and
 * callers keep doing whatever they would have done without asking.
 */
export async function gateSessionState(
  fetchImpl: typeof fetch = fetch,
): Promise<'alive' | 'signed-out' | 'unknown'> {
  let r: Response;
  try {
    r = await fetchImpl('/oauth2/auth', { credentials: 'include', cache: 'no-store' });
  } catch {
    return 'unknown';
  }
  if (r.status === 401) {
    // The cached token belongs to the session that just ended.
    clearAccessToken();
    return 'signed-out';
  }
  return r.ok ? 'alive' : 'unknown';
}

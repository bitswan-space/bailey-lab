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

import type { FastifyRequest } from 'fastify';

/**
 * Identity for the dashboard comes from the user's Keycloak access token, NOT
 * from forwarded request headers. The dashboard runs inside the Bailey iframe
 * behind the platform protected-proxy, and the Bailey gate deliberately STRIPS
 * forwarded-identity headers (x-forwarded-email / x-auth-request-email) from
 * every app upstream as an anti-spoofing measure — so those headers never
 * reach us. Instead, like a business-process frontend, the SPA fetches the
 * access token from the platform proxy's `/oauth2/auth` endpoint and sends it
 * as a Bearer token (or, for WebSockets which can't set headers, as the
 * `access_token` query param). We validate that token against Keycloak's
 * userinfo endpoint, which both proves the token is genuine (Keycloak checks
 * the signature + expiry) and returns the email — so the identity cannot be
 * forged by a workspace member.
 *
 * BITSWAN_OIDC_ISSUER_URL is the Keycloak realm URL (e.g.
 * https://keycloak.example.com/realms/master), injected by the daemon. With no
 * issuer configured we cannot validate, so we fail closed (return null →
 * caller 401s) rather than trust an unverified token.
 */

const ISSUER = (process.env.BITSWAN_OIDC_ISSUER_URL ?? '').replace(/\/+$/, '');
const USERINFO_URL = ISSUER ? `${ISSUER}/protocol/openid-connect/userinfo` : '';

// Validated token → { email, expiry } cache, so we hit Keycloak once per token
// rather than on every request. Keyed on the opaque token string.
const tokenEmailCache = new Map<string, { email: string; expMs: number }>();
const MAX_CACHE_MS = 5 * 60 * 1000;

function bearerToken(req: FastifyRequest): string | null {
  const auth = req.headers['authorization'];
  const header = Array.isArray(auth) ? auth[0] : auth;
  if (header && header.startsWith('Bearer ')) {
    const t = header.slice('Bearer '.length).trim();
    if (t) return t;
  }
  // WebSocket upgrades can't carry an Authorization header, so the client
  // passes the token as a query param there.
  const q = (req.query as Record<string, unknown> | undefined)?.['access_token'];
  if (typeof q === 'string' && q) return q;
  return null;
}

// Best-effort read of the JWT `exp` (seconds) for cache TTL only — never used
// for trust (that's userinfo's job). Returns 0 if unparseable.
function tokenExpMs(token: string): number {
  try {
    const part = token.split('.')[1];
    if (!part) return 0;
    const payload = JSON.parse(Buffer.from(part, 'base64').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/**
 * Resolve the authenticated user's email by validating their access token
 * against Keycloak. Returns null when there's no token, no issuer is
 * configured, or the token is invalid/expired — callers must treat null as
 * "not authenticated" and 401. `log` is an optional logger so validation
 * failures are surfaced rather than swallowed.
 */
export async function emailFromRequest(
  req: FastifyRequest,
  log?: { warn: (obj: unknown, msg?: string) => void },
): Promise<string | null> {
  const token = bearerToken(req);
  if (!token) return null;

  const cached = tokenEmailCache.get(token);
  if (cached && cached.expMs > Date.now()) return cached.email;

  if (!USERINFO_URL) {
    log?.warn(
      {},
      'BITSWAN_OIDC_ISSUER_URL not set — cannot validate access token, denying',
    );
    return null;
  }

  let res: Response;
  try {
    res = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    log?.warn({ err }, 'Keycloak userinfo request failed');
    return null;
  }
  if (!res.ok) {
    log?.warn({ status: res.status }, 'access token rejected by Keycloak userinfo');
    return null;
  }
  const info = (await res.json()) as { email?: string };
  if (!info.email) {
    log?.warn({}, 'Keycloak userinfo returned no email claim');
    return null;
  }

  const exp = tokenExpMs(token);
  const ttl =
    exp > Date.now() ? Math.min(exp, Date.now() + MAX_CACHE_MS) : Date.now() + MAX_CACHE_MS;
  tokenEmailCache.set(token, { email: info.email, expMs: ttl });
  return info.email;
}

/**
 * Derive a user's personal copy name from their email. Copy names are git
 * branch names and filesystem path segments, so gitops requires
 * `^[a-zA-Z0-9][a-zA-Z0-9-]*$` (alphanumeric + hyphens, no leading hyphen).
 * Slugify the whole email so the name is unique per user (emails are unique):
 *   alice@acme.com -> alice-acme-com
 */
/**
 * Best-effort role for firewall RBAC: "admin" | "auditor" | "member". Read from
 * the Keycloak access token's group/role claims (validated via userinfo), mapped
 * with env-configurable group names. gitops is the hard backstop — it rejects
 * production rule changes unless the role is admin/auditor — so an unknown role
 * simply fails closed there. Returns "member" when no privileged group matches.
 */
const ADMIN_GROUPS = new Set(
  (process.env.BITSWAN_FW_ADMIN_GROUPS ?? 'admin,owner').split(',').map((s) => s.trim().toLowerCase()),
);
const AUDITOR_GROUPS = new Set(
  (process.env.BITSWAN_FW_AUDITOR_GROUPS ?? 'auditor').split(',').map((s) => s.trim().toLowerCase()),
);

export async function fwRoleFromRequest(
  req: FastifyRequest,
  log?: { warn: (obj: unknown, msg?: string) => void },
): Promise<'admin' | 'auditor' | 'member'> {
  const token = bearerToken(req);
  if (!token || !USERINFO_URL) return 'member';
  let info: Record<string, unknown>;
  try {
    const res = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return 'member';
    info = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    log?.warn({ err }, 'fwRole userinfo failed');
    return 'member';
  }
  const groups = new Set<string>();
  for (const g of (info.groups as string[] | undefined) ?? []) groups.add(String(g).replace(/^\//, '').toLowerCase());
  const ra = info.realm_access as { roles?: string[] } | undefined;
  for (const r of ra?.roles ?? []) groups.add(String(r).toLowerCase());
  if ([...groups].some((g) => ADMIN_GROUPS.has(g))) return 'admin';
  if ([...groups].some((g) => AUDITOR_GROUPS.has(g))) return 'auditor';
  return 'member';
}

export function copyNameForEmail(email: string): string {
  const slug = email
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // collapse non-alphanumeric runs to one hyphen
    .replace(/^-+/, '') // no leading hyphen (gitops rejects it)
    .replace(/-+$/, ''); // tidy trailing hyphen
  return slug || 'user';
}

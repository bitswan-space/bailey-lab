import type { FastifyRequest } from 'fastify';

/**
 * Auth model: the dashboard does NO authentication of its own. All protection
 * comes from the automation-server daemon's oauth gate (the Bailey gate, in
 * front via bitswan-protected-proxy). The gate authenticates every request,
 * strips any client-supplied identity headers (anti-spoofing), then forwards
 * the verified identity to this first-party dashboard as `X-Forwarded-Email`.
 * We simply trust that header — no Keycloak, no token validation, no OIDC
 * issuer. A request that reached the dashboard is, by construction, already
 * authenticated by the gate.
 */

/**
 * The authenticated user's email, taken from the identity the Bailey gate
 * forwards. ALL protection comes from the automation-server daemon's oauth gate
 * (bitswan-protected-proxy → the :9080 gate): it authenticates every request,
 * strips any client-supplied identity headers (anti-spoofing), and then sets a
 * trusted `X-Forwarded-Email` on the leg to this first-party dashboard. The
 * dashboard does NO OIDC of its own — no Keycloak, no token validation, no
 * issuer. A request that reached us is already authenticated by the gate.
 *
 * Returns null only when the header is absent (request that didn't come through
 * the gate) — callers treat null as unauthenticated.
 */
export async function emailFromRequest(
  req: FastifyRequest,
  log?: { warn: (obj: unknown, msg?: string) => void },
): Promise<string | null> {
  const raw =
    req.headers['x-forwarded-email'] ?? req.headers['x-auth-request-email'];
  const email = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (email) return email;
  log?.warn(
    {},
    'no X-Forwarded-Email from the Bailey gate — request not authenticated',
  );
  return null;
}

/**
 * Derive a user's personal copy name from their email. Copy names are git
 * branch names and filesystem path segments, so gitops requires
 * `^[a-zA-Z0-9][a-zA-Z0-9-]*$` (alphanumeric + hyphens, no leading hyphen).
 * Slugify the whole email so the name is unique per user (emails are unique):
 *   alice@acme.com -> alice-acme-com
 */
/**
 * The signed-in user's role: "admin" | "auditor" | "member". The AUTHORITATIVE
 * source is the automation-server's Bailey user-roles store (the same store the
 * People & roles admin view uses) — NOT Keycloak/SSO groups. We resolve it by:
 *   1. verifying the user's access token → email (emailFromRequest, above), and
 *   2. asking gitops, which bridges to the daemon over its trusted local socket.
 * This is the "shim verifies identity, daemon owns the role" model: a frontend
 * can't assert a role, and the role is never re-derived from SSO groups.
 *
 * Returns "member" (least privilege) when there's no verified identity or the
 * lookup fails — fail CLOSED, since this also gates production firewall / DR
 * policy changes.
 */
export interface RoleResolver {
  userRole(email: string): Promise<'admin' | 'auditor' | 'member'>;
}

export async function fwRoleFromRequest(
  req: FastifyRequest,
  gitops: RoleResolver | null,
  log?: { warn: (obj: unknown, msg?: string) => void },
): Promise<'admin' | 'auditor' | 'member'> {
  if (!gitops) return 'member';
  const email = await emailFromRequest(req, log);
  if (!email) return 'member';
  return gitops.userRole(email);
}

export function copyNameForEmail(email: string): string {
  const slug = email
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // collapse non-alphanumeric runs to one hyphen
    .replace(/^-+/, '') // no leading hyphen (gitops rejects it)
    .replace(/-+$/, ''); // tidy trailing hyphen
  return slug || 'user';
}

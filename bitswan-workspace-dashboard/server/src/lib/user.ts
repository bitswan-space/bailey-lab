import type { FastifyRequest } from 'fastify';

/**
 * The authenticated user's email, as forwarded by the oauth2-proxy that fronts
 * the dashboard. `x-forwarded-email` is on by default (`--pass-user-headers`);
 * `x-auth-request-email` requires `--set-xauthrequest=true`. Check both so we
 * work either way. Returns null when no identity is present (e.g. local dev
 * without the proxy).
 */
export function emailFromRequest(req: FastifyRequest): string | null {
  const raw =
    req.headers['x-auth-request-email'] ?? req.headers['x-forwarded-email'];
  if (typeof raw === 'string' && raw) return raw;
  if (Array.isArray(raw) && raw[0]) return raw[0];
  return null;
}

/**
 * Derive a user's personal copy name from their email. Copy names are git
 * branch names and filesystem path segments, so gitops requires
 * `^[a-zA-Z0-9][a-zA-Z0-9-]*$` (alphanumeric + hyphens, no leading hyphen).
 * Slugify the whole email so the name is unique per user (emails are unique):
 *   alice@acme.com -> alice-acme-com
 */
export function copyNameForEmail(email: string): string {
  const slug = email
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // collapse non-alphanumeric runs to one hyphen
    .replace(/^-+/, '') // no leading hyphen (gitops rejects it)
    .replace(/-+$/, ''); // tidy trailing hyphen
  return slug || 'user';
}

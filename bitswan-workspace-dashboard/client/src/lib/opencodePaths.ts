/**
 * The OpenCode UI's URL scheme, as far as the panel needs it.
 *
 * OpenCode's web UI is served on the dashboard's own origin (the server
 * forwards its paths). Its router (2.0.16) knows five pages: `/` (home),
 * `/settings`, `/connect`, `/new-session` and `/server/<key>/session/<id>`,
 * where `<key>` is the base64url of the server URL the app is connected to —
 * for the UI served by its own server, the page origin. A conversation is
 * addressed by session id alone; the session carries its directory, so the BP
 * is chosen by which session the panel opens, not by the URL.
 *
 * Home is the one page the panel must keep the frame away from: on this origin
 * `/` is the dashboard itself.
 */

/** base64url without padding — the encoding OpenCode's UI uses in its URLs. */
export function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The page of one conversation, for a UI connected to the server at `origin`. */
export function sessionPath(origin: string, sessionId: string): string {
  return `/server/${encodeBase64Url(origin)}/session/${encodeURIComponent(sessionId)}`;
}

const SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * Whether `pathname` is a page OpenCode's router recognises, other than its
 * home. Anywhere else — above all `/` — is where the panel must not let the
 * frame stay.
 */
export function isOpenCodeRoute(pathname: string): boolean {
  const trimmed = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (trimmed === '/settings' || trimmed === '/connect' || trimmed === '/new-session') return true;
  const parts = trimmed.split('/').slice(1);
  return (
    parts.length === 4 &&
    parts[0] === 'server' &&
    parts[2] === 'session' &&
    SEGMENT_RE.test(parts[1] ?? '') &&
    SEGMENT_RE.test(parts[3] ?? '')
  );
}

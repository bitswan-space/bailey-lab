/**
 * The URL surface the dashboard multiplexes for OpenCode, kept pure so it can
 * be tested without a server.
 *
 * OpenCode's web UI cannot be mounted under a path prefix: its assets are
 * absolute, its router owns the root, and its API base is the page origin. The
 * dashboard therefore serves it on its own origin and forwards, per request,
 * whatever belongs to OpenCode to the caller's OpenCode server. This module
 * decides what belongs to OpenCode, checks that a request stays inside the
 * copies tree, and builds the headers the upstream sees.
 *
 * Version-specific facts (OpenCode 2.0.16, read out of its own router): the
 * API lives entirely under `/api/*`; the UI's static files live under
 * `/_assets/*` and `/icons/*` plus a few root files; its pages are `/` (home),
 * `/settings`, `/connect`, `/new-session` and `/server/<key>/session/<id>`,
 * where `<key>` is the base64url of the server URL as the browser sees it. The
 * working directory is not in the URL at all — a session carries its own.
 */

/** Where the coding-agent container keeps every copy; a BP clone is `<root>/<copy>/<bp>`. */
export const COPIES_ROOT = '/workspace/copies';

/** The BP clone's absolute path inside the coding-agent container. */
export function bpDirectory(copy: string, bp: string): string {
  return `${COPIES_ROOT}/${copy}/${bp}`;
}

export type OpenCodePath =
  /** A page of the OpenCode UI. */
  | { kind: 'document' }
  /** A static file of the UI bundle. */
  | { kind: 'asset' }
  /** An API call. */
  | { kind: 'api' }
  /** Not OpenCode's. */
  | { kind: 'none' };

const ASSET_PREFIXES = ['/_assets/', '/icons/', '/web-app-manifest-'];
const ASSET_FILES = new Set(['/site.webmanifest', '/openapi.json', '/social-share.png']);
const DOCUMENT_PATHS = new Set(['/settings', '/connect', '/new-session']);
const SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * What an OpenCode request path is. Only the pathname is inspected; query
 * parameters are checked separately by `directoryParamsAllowed`.
 *
 * Document routes mirror the UI's own router (2.0.16): `/settings`,
 * `/connect`, `/new-session` and `/server/:key/session/:id`. Its home, `/`, is
 * never OpenCode's here — on this origin that path is the dashboard.
 */
export function classifyOpenCodePath(pathname: string): OpenCodePath {
  if (pathname.startsWith('/api/')) return { kind: 'api' };
  if (ASSET_FILES.has(pathname) || ASSET_PREFIXES.some((p) => pathname.startsWith(p))) {
    return { kind: 'asset' };
  }
  if (pathname.startsWith('/favicon')) return { kind: 'asset' };
  const trimmed = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (DOCUMENT_PATHS.has(trimmed)) return { kind: 'document' };
  const parts = trimmed.split('/').slice(1);
  if (
    parts.length === 4 &&
    parts[0] === 'server' &&
    parts[2] === 'session' &&
    !!parts[1] &&
    !!parts[3] &&
    SEGMENT_RE.test(parts[1]) &&
    SEGMENT_RE.test(parts[3])
  ) {
    return { kind: 'document' };
  }
  return { kind: 'none' };
}

const DIRECTORY_PARAMS = ['directory', 'location[directory]'];

/**
 * Whether every directory named in the query string is a path inside the
 * copies tree. OpenCode scopes API calls with `?directory=`; a call for a
 * directory the dashboard does not manage is refused rather than forwarded.
 */
export function directoryParamsAllowed(url: string): boolean {
  const search = url.includes('?') ? url.slice(url.indexOf('?')) : '';
  const params = new URLSearchParams(search);
  for (const name of DIRECTORY_PARAMS) {
    for (const value of params.getAll(name)) {
      if (!directoryAllowed(value)) return false;
    }
  }
  return true;
}

/** Whether one directory is inside the copies tree (and does not climb out of it). */
export function directoryAllowed(directory: string): boolean {
  if (!directory.startsWith(`${COPIES_ROOT}/`)) return false;
  return !directory.split('/').some((part) => part === '..');
}

/** The HTTP Basic credentials OpenCode's server expects. */
export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

/**
 * Request headers that may travel to the OpenCode server — an allowlist, not a
 * blocklist.
 *
 * The gate re-applies the visitor's identity headers and live access token to
 * every request it forwards here, and browsers add cookies and a possibly
 * user-supplied Authorization header. None of that may reach the coding-agent
 * container, where untrusted model-chosen code runs: the forwarded request
 * carries only what OpenCode needs, plus the per-user Basic credentials the
 * dashboard holds for that server.
 */
const FORWARDED_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'accept-encoding',
  'content-type',
  'content-length',
  'transfer-encoding',
  'range',
  'if-none-match',
  'if-modified-since',
  'last-event-id',
  'user-agent',
  'x-opencode-directory',
  'x-opencode-ticket',
]);

/** Build the outbound header set for a forwarded request. */
export function outboundHeaders(
  // eslint-disable-next-line no-restricted-syntax -- undefined = Node's incoming-header type
  incoming: Record<string, string | string[] | undefined>,
  upstream: { host: string; authorization: string },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming)) {
    const key = name.toLowerCase();
    if (!FORWARDED_REQUEST_HEADERS.has(key) || value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  out.host = upstream.host;
  out.authorization = upstream.authorization;
  return out;
}

/**
 * The WebSocket routes OpenCode's UI opens: its terminal. Everything else it
 * does over plain HTTP and server-sent events, which the HTTP forwarder
 * streams. @fastify/websocket upgrades only routes registered as such, so these
 * are spelled out rather than caught by a wildcard.
 */
export const OPENCODE_WS_ROUTES = [
  '/api/pty/:id/connect',
  '/api/experimental/persistent-pty/:id/connect',
];

/**
 * A state-changing request that a browser reports as coming from another
 * site. The gate's session cookie is SameSite=Lax by default, so such a
 * request should not carry a session at all; refusing it here is cheap
 * defence in depth for OpenCode's cookie-authenticated API.
 */
// eslint-disable-next-line no-restricted-syntax -- undefined = header absent
export function isCrossSiteMutation(method: string, secFetchSite: string | undefined): boolean {
  if (method === 'GET' || method === 'HEAD') return false;
  return secFetchSite === 'cross-site';
}

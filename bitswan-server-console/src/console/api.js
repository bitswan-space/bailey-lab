// api.js — centralized fetch helpers for the Bailey Server Console.
//
// All backend routes are same-origin under /bailey/* and /2fa-gate/*
// (the daemon serves them behind the gate on the console's origin, and
// /bailey/api/* + the gate prefix bypass the chrome wrap so a fetch()
// gets JSON/HTML rather than the SPA's index.html). See
// internal/daemon/bailey_dispatch.go for the route table.
//
// Two transports the backend actually speaks:
//   - JSON GET/POST for the simple endpoints.
//   - x-www-form-urlencoded POST for the device-remove + approve
//     handlers (they call r.ParseForm / r.FormValue, NOT json.Decode).
//   - NDJSON streams for create / empty-trash / update-workspace
//     (each line is one progress event; the last is event:done|error).
//
// No silent fallbacks: every helper throws on a non-OK response so the
// caller renders an explicit error state instead of a blank screen.

// getJSON performs a GET and parses the JSON body. Throws ApiError on
// any non-2xx status or a non-JSON body.
export async function getJSON(path) {
  const res = await fetch(path, {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
  });
  return parseJSONResponse(res, path);
}

// postJSON sends a JSON body and parses the JSON response.
export async function postJSON(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body ?? {}),
  });
  return parseJSONResponse(res, path);
}

// postForm sends an application/x-www-form-urlencoded body. Used by the
// device-remove and admin-device-remove handlers, which read r.FormValue.
// Parses a JSON response.
export async function postForm(path, fields) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields || {})) params.append(k, v);
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    credentials: 'same-origin',
    body: params.toString(),
  });
  return parseJSONResponse(res, path);
}

// postFormExpectStatus sends a form-encoded body to a handler that
// replies with HTML (not JSON) — e.g. /2fa-gate/approve. It only
// inspects the status code; on a non-2xx it throws with the response
// text so the caller can surface the backend's error message.
export async function postFormExpectStatus(path, fields) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields || {})) params.append(k, v);
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    credentials: 'same-origin',
    body: params.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(extractErrorText(text) || `${res.status} ${res.statusText}`, res.status, path);
  }
  return res;
}

// postNDJSON streams a POST whose body is newline-delimited JSON
// progress events (create-workspace / empty-trash / update-workspace).
// `onEvent(obj)` is called per line. Resolves with the final event
// (event:done) or rejects (event:error / network error).
export async function postNDJSON(path, body, onEvent) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(extractErrorText(text) || `${res.status} ${res.statusText}`, res.status, path);
  }
  if (!res.body) {
    // No streaming body available — the request still succeeded.
    return { event: 'done' };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let last = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch (e) { continue; }
      last = ev;
      if (onEvent) onEvent(ev);
      if (ev.event === 'error') {
        throw new ApiError(ev.error || 'operation failed', res.status, path);
      }
    }
  }
  return last || { event: 'done' };
}

// ApiError carries the HTTP status + path so callers can branch (e.g.
// treat 403 on an admin endpoint as "not an admin" rather than a crash).
export class ApiError extends Error {
  constructor(message, status, path) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
  }
}

async function parseJSONResponse(res, path) {
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new ApiError(extractErrorText(text) || `${res.status} ${res.statusText}`, res.status, path);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ApiError(`invalid JSON from ${path}`, res.status, path);
  }
}

// extractErrorText pulls a human message out of the daemon's error
// bodies, which come in two shapes: {"error":"..."} JSON, or a plain
// http.Error string. HTML bodies (gate redirects) collapse to ''.
function extractErrorText(text) {
  if (!text) return '';
  const t = text.trim();
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t);
      if (o && typeof o.error === 'string') return o.error;
    } catch (e) { /* fall through */ }
  }
  if (t.startsWith('<')) return '';
  return t.length > 200 ? t.slice(0, 200) : t;
}

// ─── Endpoint wrappers (one place per backend route) ────────────────────────

export const Api = {
  whoami: () => getJSON('/bailey/api/whoami'),
  // ── Device-trust GATE (callable by an authenticated but UNtrusted user) ──
  // These drive the full-screen onboarding/auth scenes. gateState picks the
  // scene; the rest are the per-scene actions. Success-with-trust responses
  // set the _bailey_device cookie and may return a redirect_path to follow.
  gateState: () => getJSON('/bailey/api/gate-state'),
  claim: () => postJSON('/bailey/api/claim', {}),
  pendingPair: () => getJSON('/bailey/api/pending-pair'),
  pendingPairPoll: () => getJSON('/bailey/api/pending-pair/poll'),
  selfTrust: (totp) => postJSON('/bailey/api/self-trust', { totp }),
  recover: (body) => postJSON('/bailey/api/recover', body),
  totpEnroll: () => getJSON('/bailey/api/totp/enroll'),
  totpVerify: (code) => postJSON('/bailey/api/totp/verify', { code }),
  regenerateBackupCodes: () => postJSON('/bailey/api/backup-codes/regenerate', {}),
  removeTotp: () => postJSON('/bailey/api/totp/remove', {}),
  devices: () => getJSON('/bailey/api/devices'),
  removeDevice: (id) => postForm('/bailey/api/devices/remove', { id }),
  approvals: () => getJSON('/bailey/api/approvals'),
  // Approve a pending pairing. The JSON variant isn't wired in the
  // dispatcher; the live route is the gate's form handler, which is
  // same-origin and bypasses the chrome wrap. Returns 2xx HTML on
  // success, 401 on a code mismatch.
  approvePair: (email, code) => postFormExpectStatus('/2fa-gate/approve', { email, code }),
  endpoints: () => getJSON('/bailey/api/endpoints'),
  workspaces: () => getJSON('/bailey/api/workspaces'),
  createWorkspace: (name, onEvent) => postNDJSON('/bailey/api/workspaces', { name }, onEvent),
  trashWorkspace: (name) => postJSON(`/bailey/api/workspaces/${encodeURIComponent(name)}/trash`),
  restoreWorkspace: (name) => postJSON(`/bailey/api/workspaces/${encodeURIComponent(name)}/restore`),
  updateWorkspace: (name, onEvent) =>
    postNDJSON(`/bailey/api/workspaces/${encodeURIComponent(name)}/update`, {}, onEvent),
  // Workspace membership = the ACL share state on the workspace's dashboard
  // endpoint host: owner_email + grants. Owner-only (403 otherwise). Returns
  // the updated listing on add/remove.
  workspaceMembers: (host) => getJSON(`/2fa-gate/api/share/${encodeURIComponent(host)}`),
  addWorkspaceMember: (host, email) =>
    postForm(`/2fa-gate/api/share/${encodeURIComponent(host)}`,
      { action: 'grant', principal_type: 'email', principal_value: email, role: 'access' }),
  removeWorkspaceMember: (host, principalType, principalValue, role) =>
    postForm(`/2fa-gate/api/share/${encodeURIComponent(host)}`,
      { action: 'revoke', principal_type: principalType, principal_value: principalValue, role }),
  emptyTrash: (onEvent) =>
    postNDJSON('/bailey/api/workspaces/empty-trash', { confirmation: 'empty trash' }, onEvent),
  notificationsCount: () => getJSON('/bailey/api/notifications-count'),
  // Admin-only (403 for non-admins).
  // Server overview: counts + server-identity card + recent-activity feed.
  overview: () => getJSON('/bailey/api/overview'),
  // People roster: every identity the daemon persists, with role/workspace/
  // device counts. Degrades to a 200 with an `error` field on partial
  // enumeration failure (the view surfaces it without dropping the roster).
  people: () => getJSON('/bailey/api/people'),
  // Invite is stubbed 501 on the backend (no Keycloak admin client yet), so
  // the People view keeps its control disabled rather than calling this.
  // Wired here for when the backend lands; throws ApiError(501) until then.
  invite: (email, role) => postJSON('/bailey/api/people/invite', { email, role }),
  adminDevices: () => getJSON('/bailey/api/admin/devices'),
  adminRemoveDevice: (email, id) => postForm('/bailey/api/admin/devices/remove', { email, id }),
  adminNetworkMap: () => getJSON('/bailey/api/admin/network-map'),
  // Read-only server-wide ACL tree: every endpoint + owner + grants (admin).
  adminACL: () => getJSON('/bailey/api/admin/acl'),
  adminDefaultImages: () => getJSON('/bailey/api/admin/default-images'),
  setAdminDefaultImages: (body) => postJSON('/bailey/api/admin/default-images', body),
};

// Expose on window for the non-ESM-import console modules (they read
// globals like window.SC_UI). main.jsx imports this module first so the
// global is set before the view modules run.
if (typeof window !== 'undefined') {
  window.SC_API = { getJSON, postJSON, postForm, postFormExpectStatus, postNDJSON, Api, ApiError };
}

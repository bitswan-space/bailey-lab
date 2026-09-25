import { fetchOpenCode, type OpenCodeConnection } from './opencode-server.js';

/**
 * The few OpenCode API calls the dashboard makes on its own behalf — finding
 * a BP's latest conversation to land the panel on, and creating a conversation
 * to hand a task to. Everything else the OpenCode UI does itself, through the
 * forwarder.
 *
 * Paths are OpenCode 2.x (`/api/*`). They are the only place the dashboard
 * spells an OpenCode endpoint, so a version bump that moves them is one edit
 * here. Verified against 2.0.16's /openapi.json.
 */

export interface OpenCodeSession {
  id: string;
  title?: string;
  time: { created: number; updated: number };
}

/**
 * `?directory=` filters a listing to one project. It does NOT scope a
 * creation: `POST /api/session` ignores it (verified on 2.0.16 — the session
 * landed in the server's working directory), so a new session names its
 * directory in the body, as `location.directory`.
 */
function directoryQuery(directory: string): string {
  return `directory=${encodeURIComponent(directory)}`;
}

async function readJson(r: Response, what: string): Promise<Record<string, unknown>> { // eslint-disable-line no-restricted-syntax -- JSON boundary
  if (!r.ok) throw new Error(`OpenCode ${what} failed: HTTP ${r.status}`);
  // eslint-disable-next-line no-restricted-syntax -- unknown = JSON boundary
  const raw: unknown = await r.json();
  if (!raw || typeof raw !== 'object') throw new Error(`OpenCode ${what} returned no object`);
  return raw as Record<string, unknown>; // eslint-disable-line no-restricted-syntax -- JSON boundary
}

// eslint-disable-next-line no-restricted-syntax -- unknown = JSON boundary
function asSession(raw: unknown): OpenCodeSession | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>; // eslint-disable-line no-restricted-syntax -- JSON boundary
  if (typeof o.id !== 'string') return undefined;
  const time = (o.time && typeof o.time === 'object' ? o.time : {}) as Record<string, unknown>; // eslint-disable-line no-restricted-syntax -- JSON boundary
  const session: OpenCodeSession = {
    id: o.id,
    time: {
      created: typeof time.created === 'number' ? time.created : 0,
      updated: typeof time.updated === 'number' ? time.updated : 0,
    },
  };
  if (typeof o.title === 'string') session.title = o.title;
  return session;
}

/** The newest session by last update; undefined for an empty list. */
// eslint-disable-next-line no-restricted-syntax -- undefined = no session
export function pickLatest(sessions: OpenCodeSession[]): OpenCodeSession | undefined {
  let best: OpenCodeSession | undefined;
  for (const s of sessions) {
    const at = s.time.updated || s.time.created;
    const bestAt = best ? best.time.updated || best.time.created : -Infinity;
    if (!best || at > bestAt) best = s;
  }
  return best;
}

/** Sessions of the project at `directory`, newest first. */
export async function listSessions(
  conn: OpenCodeConnection,
  directory: string,
  limit = 50,
): Promise<OpenCodeSession[]> {
  const r = await fetchOpenCode(conn, `/api/session?${directoryQuery(directory)}&limit=${limit}&order=desc`);
  const body = await readJson(r, 'session list');
  const data = Array.isArray(body.data) ? body.data : [];
  return data.map(asSession).filter((s): s is OpenCodeSession => s !== undefined);
}

/** The session the panel should land on for `directory`, if it has any. */
export async function latestSession(
  conn: OpenCodeConnection,
  directory: string,
  // eslint-disable-next-line no-restricted-syntax -- undefined = the BP has no conversation yet
): Promise<OpenCodeSession | undefined> {
  return pickLatest(await listSessions(conn, directory));
}

/**
 * Create a session in the project at `directory` — the BP clone the agent will
 * work in. The directory travels in the body (`location`); see `directoryQuery`.
 */
export async function createSession(
  conn: OpenCodeConnection,
  directory: string,
  title?: string,
): Promise<OpenCodeSession> {
  const r = await fetchOpenCode(conn, '/api/session', {
    method: 'POST',
    body: JSON.stringify({ ...(title ? { title } : {}), location: { directory } }),
  });
  const body = await readJson(r, 'session create');
  const session = asSession(body.data);
  if (!session) throw new Error('OpenCode session create returned no session');
  return session;
}

/**
 * Send `text` to a session and let the agent run. OpenCode's own words for
 * this endpoint: it "durably admits one session input and schedules agent-loop
 * execution" — the call returns as soon as the input is accepted.
 */
export async function promptSession(
  conn: OpenCodeConnection,
  directory: string,
  sessionId: string,
  text: string,
): Promise<void> {
  const r = await fetchOpenCode(
    conn,
    `/api/session/${encodeURIComponent(sessionId)}/prompt?${directoryQuery(directory)}`,
    { method: 'POST', body: JSON.stringify({ text }) },
  );
  if (!r.ok) throw new Error(`OpenCode prompt failed: HTTP ${r.status}`);
}

/** Ids of the sessions currently running an agent loop, across all projects. */
export async function activeSessions(conn: OpenCodeConnection): Promise<string[]> {
  const body = await readJson(await fetchOpenCode(conn, '/api/session/active'), 'active sessions');
  const data = body.data;
  if (!data || typeof data !== 'object') return [];
  return Object.keys(data);
}

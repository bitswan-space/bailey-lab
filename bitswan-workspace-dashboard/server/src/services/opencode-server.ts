import { agentSshTarget, sshExec, waitForAgentDns, type SshExecResult } from './agent-ssh.js';
import { basicAuthHeader } from './opencode-paths.js';
import { closeAllTunnels, closeTunnel, ensureTunnel, tunnelFor } from './opencode-tunnel.js';

/**
 * The dashboard's handle on each user's OpenCode server.
 *
 * The server itself runs in the coding-agent container, started and reported
 * by `bitswan-opencode-server start` over the wrapper's one-shot ssh path (see
 * that script for why there is one per user). What lives here is the map from
 * user to "how do I reach it": the port-forward to its loopback port and the
 * Basic credentials it was started with. Both are re-derived from the script's
 * output whenever they are missing or stop answering, so a container restart on
 * either side heals on the next request.
 */

const START_TIMEOUT_MS = 90_000;
const HEALTH_TIMEOUT_MS = 3_000;
const HEALTH_RETRIES = 20;
const HEALTH_RETRY_MS = 500;

export interface OpenCodeServerInfo {
  version: string;
  port: number;
  username: string;
  password: string;
  pid: number;
  startedAt: string;
}

export interface OpenCodeConnection {
  email: string;
  info: OpenCodeServerInfo;
  /** The loopback port on THIS container that forwards to the server. */
  localPort: number;
  baseUrl: string;
  authorization: string;
  lastUsedAt: number;
}

export type EnsureResult =
  | { state: 'ready'; conn: OpenCodeConnection }
  /** The image has no `opencode`: nothing will change until it is rebuilt. */
  | { state: 'unavailable'; reason: string }
  /** Something failed that a retry may fix (agent unreachable, slow start). */
  | { state: 'error'; reason: string };

/**
 * The server description `bitswan-opencode-server start` prints: the last line
 * of its stdout that is a JSON object with the fields we need. Anything the
 * remote shell printed before it is ignored.
 */
export function parseServerInfo(stdout: string): OpenCodeServerInfo {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.startsWith('{')) continue;
    // eslint-disable-next-line no-restricted-syntax -- unknown = JSON boundary
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>; // eslint-disable-line no-restricted-syntax -- JSON boundary
    if (typeof o.port !== 'number' || typeof o.password !== 'string' || typeof o.pid !== 'number') {
      continue;
    }
    return {
      version: typeof o.version === 'string' ? o.version : 'unknown',
      port: o.port,
      username: typeof o.username === 'string' && o.username ? o.username : 'opencode',
      password: o.password,
      pid: o.pid,
      startedAt: typeof o.started_at === 'string' ? o.started_at : '',
    };
  }
  throw new Error('bitswan-opencode-server printed no server description');
}

export type StartResult = { ok: true; info: OpenCodeServerInfo } | { ok: false; result: EnsureResult };

/**
 * What one run of `bitswan-opencode-server start` means. Exit 127 is the
 * script itself saying `opencode` is not installed — a fact about the image,
 * not a transient failure — and 255 is ssh never reaching the agent.
 */
export function classifyStartResult(r: SshExecResult): StartResult {
  if (r.code === 127) {
    return {
      ok: false,
      result: { state: 'unavailable', reason: 'OpenCode is not installed in this workspace’s coding-agent image' },
    };
  }
  if (r.code === 255) {
    return {
      ok: false,
      result: { state: 'error', reason: `the coding agent could not be reached over ssh: ${r.stderr.trim() || 'connection failed'}` },
    };
  }
  if (r.code !== 0) {
    return {
      ok: false,
      result: { state: 'error', reason: r.stderr.trim() || `bitswan-opencode-server exited with ${r.code}` },
    };
  }
  try {
    return { ok: true, info: parseServerInfo(r.stdout) };
  } catch (err) {
    return { ok: false, result: { state: 'error', reason: err instanceof Error ? err.message : String(err) } };
  }
}

const servers = new Map<string, OpenCodeConnection>();
const inflight = new Map<string, Promise<EnsureResult>>();

/** The cached connection for `email`, if its tunnel is still up. */
// eslint-disable-next-line no-restricted-syntax -- undefined = no cached connection
export function connectionFor(email: string): OpenCodeConnection | undefined {
  const conn = servers.get(email);
  if (!conn) return undefined;
  if (!tunnelFor(email)) {
    servers.delete(email);
    return undefined;
  }
  return conn;
}

/** Note activity, for the idle reaper. */
export function touchServer(email: string): void {
  const conn = servers.get(email);
  if (conn) conn.lastUsedAt = Date.now();
}

/**
 * Drop what we know about `email`'s server without stopping it — the next
 * request re-asks the script, which reports the still-running server if it is
 * there. Used when a forwarded request finds nobody listening.
 */
export function forgetServer(email: string): void {
  servers.delete(email);
  closeTunnel(email);
}

/** Connections idle for longer than `idleMs`. */
export function idleConnections(now: number, idleMs: number): OpenCodeConnection[] {
  return [...servers.values()].filter((c) => now - c.lastUsedAt > idleMs);
}

/** A request to the server through its tunnel, with the Basic credentials attached. */
export async function fetchOpenCode(
  conn: OpenCodeConnection,
  pathAndQuery: string,
  init: { method?: string; body?: string; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    ...(init.headers ?? {}),
    authorization: conn.authorization,
  };
  if (init.body !== undefined) headers['content-type'] = headers['content-type'] ?? 'application/json';
  const request: RequestInit = {
    method: init.method ?? 'GET',
    headers,
    signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
  };
  if (init.body !== undefined) request.body = init.body;
  return fetch(`${conn.baseUrl}${pathAndQuery}`, request);
}

/** Whether the server answers its health check through the tunnel. */
export async function healthy(conn: OpenCodeConnection): Promise<boolean> {
  try {
    const r = await fetchOpenCode(conn, '/api/info', { timeoutMs: HEALTH_TIMEOUT_MS });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Make sure `email`'s OpenCode server is running and reachable, starting it
 * and opening the port-forward as needed. Concurrent calls for one user share
 * a single attempt.
 */
export function ensureServer(email: string): Promise<EnsureResult> {
  const pending = inflight.get(email);
  if (pending) return pending;
  const attempt = doEnsure(email).finally(() => inflight.delete(email));
  inflight.set(email, attempt);
  return attempt;
}

async function doEnsure(email: string): Promise<EnsureResult> {
  const cached = connectionFor(email);
  if (cached) {
    if (await healthy(cached)) {
      cached.lastUsedAt = Date.now();
      return { state: 'ready', conn: cached };
    }
    forgetServer(email);
  }

  const target = agentSshTarget();
  if (!(await waitForAgentDns(target.host))) {
    return { state: 'error', reason: `coding agent host ${target.host} did not become reachable` };
  }
  const started = classifyStartResult(
    await sshExec({ email, command: 'bitswan-opencode-server start', timeoutMs: START_TIMEOUT_MS, target }),
  );
  if (!started.ok) return started.result;

  let localPort: number;
  try {
    localPort = await ensureTunnel(email, started.info.port, target);
  } catch (err) {
    return { state: 'error', reason: err instanceof Error ? err.message : String(err) };
  }
  const conn: OpenCodeConnection = {
    email,
    info: started.info,
    localPort,
    baseUrl: `http://127.0.0.1:${localPort}`,
    authorization: basicAuthHeader(started.info.username, started.info.password),
    lastUsedAt: Date.now(),
  };
  for (let i = 0; i < HEALTH_RETRIES; i++) {
    if (await healthy(conn)) {
      servers.set(email, conn);
      return { state: 'ready', conn };
    }
    await new Promise((r) => setTimeout(r, HEALTH_RETRY_MS));
  }
  closeTunnel(email);
  return { state: 'error', reason: 'the OpenCode server did not answer through the ssh port-forward' };
}

/** Stop `email`'s server in the coding-agent container and drop the tunnel. */
export async function stopServer(email: string): Promise<void> {
  servers.delete(email);
  closeTunnel(email);
  const r = await sshExec({ email, command: 'bitswan-opencode-server stop', timeoutMs: 30_000 });
  if (r.code !== 0 && r.code !== 127) {
    throw new Error(r.stderr.trim() || `bitswan-opencode-server stop exited with ${r.code}`);
  }
}

/** Forget every connection and close every tunnel (server shutdown). The servers keep running. */
export function closeAllServers(): void {
  servers.clear();
  closeAllTunnels();
}

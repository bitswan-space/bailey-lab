import fs from 'node:fs/promises';
import path from 'node:path';
import { configDirNameFor, configRoot } from './vscode-sidebar.js';

/**
 * Per-user dashboard preferences, kept server-side so they follow the person
 * across browsers.
 *
 * They live in the user's per-user directory under the config root — the same
 * directory that holds their Claude Code state and their OpenCode server, so
 * one directory per person carries everything the dashboard knows about them.
 * The dashboard already creates and owns that directory (services/vscode-sidebar.ts).
 */

export const AGENT_KINDS = ['claude-code', 'opencode'] as const;

/** Which coding agent the Coding Agent tab shows. */
export type AgentKind = (typeof AGENT_KINDS)[number];

/** Whether a value names a coding agent. */
// eslint-disable-next-line no-restricted-syntax -- unknown = JSON boundary
export function isAgentKind(value: unknown): value is AgentKind {
  // eslint-disable-next-line no-restricted-syntax -- as: widening a readonly tuple for includes()
  return typeof value === 'string' && (AGENT_KINDS as readonly string[]).includes(value);
}

export interface UserPreferences {
  /** Unset until the person has chosen an agent; the tab then asks. */
  codingAgent?: AgentKind;
}

export const PREFERENCES_FILE = 'dashboard-preferences.json';

/** Where `email`'s preferences file lives. */
export function preferencesPath(email: string): string {
  return path.join(configRoot(), configDirNameFor(email), PREFERENCES_FILE);
}

/**
 * Parse a preferences file. Anything malformed reads as "no preferences": a
 * corrupt file must not take the Coding Agent tab down, it just asks again.
 */
export function parsePreferences(text: string): UserPreferences {
  // eslint-disable-next-line no-restricted-syntax -- unknown = JSON boundary
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object') return {};
  const prefs: UserPreferences = {};
  const codingAgent = (raw as { codingAgent?: unknown }).codingAgent; // eslint-disable-line no-restricted-syntax -- JSON boundary
  if (isAgentKind(codingAgent)) prefs.codingAgent = codingAgent;
  return prefs;
}

/** Short cache so the per-request forwarder does not hit the disk for every asset. */
const CACHE_TTL_MS = 5_000;
const cache = new Map<string, { at: number; prefs: UserPreferences }>();

/** Read `email`'s preferences; missing or unreadable files read as none. */
export async function readPreferences(email: string): Promise<UserPreferences> {
  const cached = cache.get(email);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.prefs;
  let prefs: UserPreferences = {};
  try {
    prefs = parsePreferences(await fs.readFile(preferencesPath(email), 'utf8'));
  } catch {
    prefs = {};
  }
  cache.set(email, { at: Date.now(), prefs });
  return prefs;
}

/**
 * Merge `patch` into `email`'s preferences and persist them. The write is
 * atomic (temp file + rename) so a crash mid-write cannot leave a truncated
 * file behind to be read as "no preferences" on the next visit.
 */
export async function writePreferences(email: string, patch: UserPreferences): Promise<UserPreferences> {
  cache.delete(email);
  const current = await readPreferences(email);
  cache.delete(email);
  const next: UserPreferences = { ...current, ...patch };
  const file = preferencesPath(email);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
  cache.set(email, { at: Date.now(), prefs: next });
  return next;
}

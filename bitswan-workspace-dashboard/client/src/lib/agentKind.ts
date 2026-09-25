/**
 * Which coding agent the Coding Agent tab shows: Claude Code or OpenCode.
 *
 * The choice is the signed-in user's, stored server-side (`/api/me/preferences`)
 * so it follows them across browsers, and held here as a tiny external store so
 * the panel, the chooser, the Settings card and the hand-off buttons all read
 * one value without threading it through every component in between.
 *
 * Kept pure (no React) so the client's `node --test` run can cover it.
 */

export const AGENT_KINDS = ['claude-code', 'opencode'] as const;

/** A coding agent the dashboard can host. */
export type AgentKind = (typeof AGENT_KINDS)[number];

/** Whether a string names a coding agent. */
export function isAgentKind(value: string): value is AgentKind {
  // eslint-disable-next-line no-restricted-syntax -- as: widening a readonly tuple for includes()
  return (AGENT_KINDS as readonly string[]).includes(value);
}

export interface AgentKindMeta {
  label: string;
  tagline: string;
  description: string;
}

/** How each agent is presented in the chooser and the Settings card. */
export const AGENT_KIND_META: Record<AgentKind, AgentKindMeta> = {
  'claude-code': {
    label: 'Claude Code',
    tagline: 'Anthropic’s agent, with your Anthropic account',
    description:
      'Sign in with an Anthropic account or subscription. The chat is Claude Code’s own, ' +
      'and the agent runs inside this workspace’s coding-agent container.',
  },
  opencode: {
    label: 'OpenCode',
    tagline: 'Open-source agent, bring your own model provider',
    description:
      'Connect the provider you want — including EU-hosted ones — with an API key or an ' +
      'account. Sessions and credentials stay in this workspace, in a server that is yours alone.',
  },
};

/**
 * What the dashboard knows about the choice: nothing yet (`/api/me` has not
 * answered), that none was made (the tab asks), or which agent it is.
 */
export type AgentChoice =
  | { state: 'loading' }
  | { state: 'unchosen' }
  | { state: 'chosen'; kind: AgentKind };

const LOADING: AgentChoice = { state: 'loading' };
const UNCHOSEN: AgentChoice = { state: 'unchosen' };

let current: AgentChoice = LOADING;
const listeners = new Set<() => void>();

/** The current choice. Stable object identity between changes, for useSyncExternalStore. */
export function getAgentChoice(): AgentChoice {
  return current;
}

/** Record a choice (or its absence) and notify subscribers. */
export function setAgentChoice(next: AgentChoice): void {
  const same =
    next.state === current.state && (next.state !== 'chosen' || current.state !== 'chosen' || next.kind === current.kind);
  if (same) return;
  current = next.state === 'loading' ? LOADING : next.state === 'unchosen' ? UNCHOSEN : next;
  for (const l of listeners) l();
}

/** The choice `/api/me` reports: a known agent, or none. */
// eslint-disable-next-line no-restricted-syntax -- undefined = the preference is optional on the wire
export function agentChoiceFromPreference(codingAgent: string | undefined): AgentChoice {
  return codingAgent !== undefined && isAgentKind(codingAgent) ? { state: 'chosen', kind: codingAgent } : UNCHOSEN;
}

/** Subscribe to changes; returns the unsubscribe. */
export function subscribeAgentChoice(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

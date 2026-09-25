import { useSyncExternalStore } from 'react';
import { api } from '@/lib/api';
import {
  getAgentChoice,
  setAgentChoice,
  subscribeAgentChoice,
  type AgentChoice,
  type AgentKind,
} from '@/lib/agentKind';

/** The signed-in user's coding-agent choice, live. See `lib/agentKind.ts`. */
export function useAgentChoice(): AgentChoice {
  return useSyncExternalStore(subscribeAgentChoice, getAgentChoice, getAgentChoice);
}

/**
 * Record the person's choice: saved server-side first, so it follows them to
 * their next browser, then applied here so every panel and button sees it.
 */
export async function chooseAgent(kind: AgentKind): Promise<void> {
  await api.setPreferences({ codingAgent: kind });
  setAgentChoice({ state: 'chosen', kind });
}

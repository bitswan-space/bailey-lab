import { api } from '@/lib/api';

const SEEDED = 'bitswan:agent-prompt';

export interface AgentHandoff {
  copy: string;
  bp: string;
}

/**
 * Give the coding agent the task, not just the tab.
 *
 * The prompt is seeded for the agent panel's next load and typed into its
 * composer there — the person reads it and presses send. A panel that is
 * already mounted would not pick it up, so the seeding is announced and the
 * panel for that copy reloads itself.
 */
export async function handOffToAgent(copy: string, bp: string, prompt: string): Promise<void> {
  await api.seedAgentPrompt(copy, bp, prompt);
  window.dispatchEvent(new CustomEvent<AgentHandoff>(SEEDED, { detail: { copy, bp } }));
}

export function onAgentHandoff(listener: (h: AgentHandoff) => void): () => void {
  const wrapped = (e: Event) => {
    const detail = (e as CustomEvent<AgentHandoff>).detail;
    if (detail) listener(detail);
  };
  window.addEventListener(SEEDED, wrapped);
  return () => window.removeEventListener(SEEDED, wrapped);
}

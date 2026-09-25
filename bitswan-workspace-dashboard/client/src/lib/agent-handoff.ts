import { api } from '@/lib/api';
import { getAgentChoice } from '@/lib/agentKind';

/**
 * Giving the coding agent a task from another tab — Sync, Build automation,
 * Write tests, Merge back, or an ask the caller wrote.
 *
 * The two agents take a task differently, and callers should not care which
 * one the person uses:
 *  - Claude Code's extension prefills its composer; the person reads the
 *    prompt and presses send (the extension offers no way to send for them).
 *  - OpenCode's API can create a conversation and send the prompt, but cannot
 *    prefill its UI — so the task is sent, and the panel is pointed at the new
 *    conversation through `subscribeOpenCodeEntry`.
 */

/** The canned jobs the server knows the wording of (services/agent-prompts.ts). */
export type TaskKind = 'sync' | 'merge-parent' | 'write-tests' | 'automation';

export type AgentHandOff =
  /** A canned job; `parent` is the branch a merge-back rebases onto. */
  | { kind: TaskKind; parent?: string }
  /** An ask written by the caller. */
  | { text: string };

export interface OpenCodeEntryEvent {
  copy: string;
  bp: string;
  /** The conversation the task went to. */
  sessionId: string;
}

const entryListeners = new Set<(event: OpenCodeEntryEvent) => void>();

/** Hear where an OpenCode hand-off landed, so the panel for that BP can show it. */
export function subscribeOpenCodeEntry(listener: (event: OpenCodeEntryEvent) => void): () => void {
  entryListeners.add(listener);
  return () => {
    entryListeners.delete(listener);
  };
}

/** Hand the person's agent a task for one BP. Resolves once the agent has it. */
export async function handOffToAgent(copy: string, bp: string, handOff: AgentHandOff): Promise<void> {
  const choice = getAgentChoice();
  if (choice.state === 'chosen' && choice.kind === 'opencode') {
    const { sessionId } = await api.codingAgent.opencodePrompt(
      copy,
      bp,
      'text' in handOff
        ? { text: handOff.text }
        : { kind: handOff.kind, ...(handOff.parent ? { parent: handOff.parent } : {}) },
    );
    for (const l of entryListeners) l({ copy, bp, sessionId });
    return;
  }
  // Claude Code — also the path while no choice is recorded yet: the sidebar
  // parks the prompt until a panel attaches, so nothing is lost.
  if ('text' in handOff) {
    await api.codingAgent.handOffPrompt(copy, bp, handOff.text);
  } else {
    await api.codingAgent.handOffTask(copy, bp, handOff.kind, handOff.parent);
  }
}

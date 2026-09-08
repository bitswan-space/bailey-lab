import { api } from '@/lib/api';

export async function handOffToAgent(copy: string, bp: string, prompt: string): Promise<void> {
  await api.codingAgent.handOffPrompt(copy, bp, prompt);
}

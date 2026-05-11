import type { BusinessProcess, DeployedAutomation, Worktree } from './types';

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: 'include', cache: 'no-store' });
  if (!r.ok) throw new Error(`${url} returned ${r.status}`);
  return (await r.json()) as T;
}

export const api = {
  businessProcesses: () => getJson<BusinessProcess[]>('/api/business-processes'),
  worktrees: () => getJson<Worktree[]>('/api/worktrees'),
  automations: () => getJson<DeployedAutomation[]>('/api/automations'),
};

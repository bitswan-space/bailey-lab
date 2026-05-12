import type { BusinessProcess, DeployedAutomation, DockerInspect, Worktree } from './types';

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: 'include', cache: 'no-store' });
  if (!r.ok) throw new Error(`${url} returned ${r.status}`);
  return (await r.json()) as T;
}

async function postEmpty(url: string): Promise<void> {
  const r = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
  });
  if (!r.ok) throw new Error(`${url} returned ${r.status}`);
}

export const api = {
  businessProcesses: () => getJson<BusinessProcess[]>('/api/business-processes'),
  worktrees: () => getJson<Worktree[]>('/api/worktrees'),
  automations: () => getJson<DeployedAutomation[]>('/api/automations'),

  startAutomation: (id: string) => postEmpty(`/api/automations/${encodeURIComponent(id)}/start`),
  stopAutomation: (id: string) => postEmpty(`/api/automations/${encodeURIComponent(id)}/stop`),
  restartAutomation: (id: string) =>
    postEmpty(`/api/automations/${encodeURIComponent(id)}/restart`),

  inspectAutomation: (id: string) =>
    getJson<DockerInspect[]>(`/api/automations/${encodeURIComponent(id)}/inspect`),

  readme: async (bpId: string): Promise<string | null> => {
    const { content } = await getJson<{ content: string | null }>(
      `/api/business-processes/${encodeURIComponent(bpId)}/readme`,
    );
    return content;
  },
};

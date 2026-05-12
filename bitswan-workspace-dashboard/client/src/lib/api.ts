import type {
  BusinessProcess,
  DeployedAutomation,
  DockerInspect,
  Worktree,
} from '@/types';

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: 'include', cache: 'no-store' });
  if (!r.ok) throw new Error(`${url} returned ${r.status}`);
  return (await r.json()) as T;
}

async function postEmpty(url: string): Promise<void> {
  // Retry once on transient network errors. Container-state actions trigger
  // a Traefik route reconfigure that briefly tears down the shared HTTP/2
  // connection — the in-flight POST surfaces as `TypeError: Failed to fetch`
  // (Chromium reports `net::ERR_NETWORK_CHANGED`) even though the upstream
  // call usually succeeded. A short backoff is enough for the new connection
  // to be ready.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
      });
      if (!r.ok) throw new Error(`${url} returned ${r.status}`);
      return;
    } catch (err) {
      if (attempt === 1 || !isTransientNetworkError(err)) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

// eslint-disable-next-line no-restricted-syntax -- catch parameter is genuinely unknown
function isTransientNetworkError(err: unknown): boolean {
  // Fetch surfaces network failures as `TypeError` with a vague message.
  // Match both Chrome ("Failed to fetch") and Firefox ("NetworkError ...").
  if (!(err instanceof TypeError)) return false;
  return /failed to fetch|networkerror/i.test(err.message);
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

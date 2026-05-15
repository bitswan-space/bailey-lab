import type { DockerInspect } from '@/types';

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: 'include', cache: 'no-store' });
  if (!r.ok) throw new Error(`${url} returned ${r.status}`);
  return (await r.json()) as T;
}

// Retry once on transient network errors. Container-state actions trigger a
// Traefik route reconfigure that briefly tears down the shared HTTP/2
// connection — the in-flight request surfaces as `TypeError: Failed to fetch`
// (Chromium reports `net::ERR_NETWORK_CHANGED`) even though the upstream call
// usually succeeded. A short backoff is enough for the new connection to be
// ready.
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        ...init,
      });
      if (!r.ok) throw new Error(`${url} returned ${r.status}`);
      return r;
    } catch (err) {
      if (attempt === 1 || !isTransientNetworkError(err)) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

async function postEmpty(url: string): Promise<void> {
  await fetchWithRetry(url, { method: 'POST' });
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await r.json()) as T;
}

async function deleteEmpty(url: string): Promise<void> {
  await fetchWithRetry(url, { method: 'DELETE' });
}

/**
 * True for the `TypeError: Failed to fetch` / `NetworkError ...` surface
 * that Chromium and Firefox raise when a connection is torn down mid-flight
 * (we hit this routinely when Traefik reconfigures routes after a container
 * state change). Exported so UI callers can decide to treat post-retry
 * network failures as success (the SSE feed will deliver the real state).
 */
// eslint-disable-next-line no-restricted-syntax -- catch parameter is genuinely unknown
export function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  return /failed to fetch|networkerror/i.test(err.message);
}

export interface DeployRequest {
  relative_path: string;
  stage: 'dev' | 'live-dev';
  worktree?: string;
}

export interface DeployResponse {
  deployment_id: string;
  task_id: string;
  checksum: string;
  url?: string;
  status?: string;
}

export interface CreateBusinessProcessRequest {
  name: string;
  worktree?: string;
}

export interface CreateBusinessProcessResponse {
  id: string;
  name: string;
  in_main: boolean;
  worktrees: string[];
  has_worktrees: boolean;
}

export interface CreateWorktreeRequest {
  branch_name: string;
  base_branch?: string;
}

export interface TemplateEntry {
  id: string;
  name: string;
  shortDescription: string;
  iconSvg: string;
}

export interface TemplateGroupEntry extends TemplateEntry {
  automations: string[];
}

export interface TemplatesResponse {
  templates: TemplateEntry[];
  groups: TemplateGroupEntry[];
}

export interface CreateAutomationRequest {
  template_id?: string;
  group_id?: string;
  name?: string;
  bp: string;
  worktree?: string;
}

export interface CreateAutomationResponse {
  created: { name: string; relativePath: string }[];
}

export const api = {
  createBusinessProcess: (body: CreateBusinessProcessRequest) =>
    postJson<CreateBusinessProcessResponse>('/api/business-processes', body),

  createWorktree: (body: CreateWorktreeRequest) =>
    postJson<{ status?: string; worktree_path?: string }>('/api/worktrees', body),
  deleteWorktree: (name: string) =>
    deleteEmpty(`/api/worktrees/${encodeURIComponent(name)}`),

  templates: () => getJson<TemplatesResponse>('/api/templates'),
  createAutomationFromTemplate: (body: CreateAutomationRequest) =>
    postJson<CreateAutomationResponse>('/api/automations/from-template', body),

  startAutomation: (id: string) => postEmpty(`/api/automations/${encodeURIComponent(id)}/start`),
  stopAutomation: (id: string) => postEmpty(`/api/automations/${encodeURIComponent(id)}/stop`),
  restartAutomation: (id: string) =>
    postEmpty(`/api/automations/${encodeURIComponent(id)}/restart`),

  deployAutomation: (body: DeployRequest) =>
    postJson<DeployResponse>('/api/automations/deploy', body),
  removeAutomation: (id: string) =>
    deleteEmpty(`/api/automations/${encodeURIComponent(id)}`),

  inspectAutomation: (id: string) =>
    getJson<DockerInspect[]>(`/api/automations/${encodeURIComponent(id)}/inspect`),

  /**
   * Ensure the coding-agent container is up. Idempotent on the gitops side.
   * Returns when the container is at least in `running` state — `dev-coding-agent`
   * still needs a moment to register with Docker's embedded DNS after that,
   * which the /ws/coding-agent handler waits for separately.
   */
  ensureCodingAgent: () => postEmpty('/api/coding-agent/ensure'),

  readme: async (bpId: string, worktree?: string): Promise<string | null> => {
    const qs = worktree ? `?worktree=${encodeURIComponent(worktree)}` : '';
    const { content } = await getJson<{ content: string | null }>(
      `/api/business-processes/${encodeURIComponent(bpId)}/readme${qs}`,
    );
    return content;
  },
};

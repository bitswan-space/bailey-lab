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

async function patchJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetchWithRetry(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await r.json()) as T;
}

/**
 * PUT with a JSON body that may legitimately return a 4xx with a JSON
 * body (e.g. 409 on save-conflict) — we want to surface those instead of
 * throwing. Callers narrow the return via the union type.
 */
async function putJsonAllow4xx<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'PUT',
    credentials: 'include',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // Parse JSON regardless of status — the body carries the structured
  // error shape (binary / too-large / conflict / …).
  return (await r.json()) as T;
}

/**
 * Multipart POST without our retry layer (retrying an upload would
 * double-write files and break browser progress tracking).
 */
async function postMultipart<T>(url: string, form: FormData): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    body: form,
  });
  if (!r.ok) throw new Error(`${url} returned ${r.status}`);
  return (await r.json()) as T;
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

export interface DeployBPRequest {
  /** Business-process directory name. */
  bp: string;
  stage: 'dev' | 'live-dev';
  worktree?: string;
}

export interface DeployBPResponse {
  task_id: string;
  bp: string;
  deployment_ids: string[];
  status?: string;
}

/** Gitops deploy-task snapshot from `GET /automations/deploy-status/{task_id}`. */
export interface DeployStatusResponse {
  task_id: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  step?: string | null;
  message?: string;
  error?: string | null;
  bp?: string | null;
  total?: number | null;
  current?: number;
}

export interface PromoteRequest {
  automation_name: string;
  /** BP name; becomes the deployment context (and a prefix on the new id). */
  context?: string;
  stage: 'staging' | 'production';
  /** Source-stage checksum to re-deploy. */
  checksum: string;
  /** Workspace-relative path of the source — required so the new yaml entry
   *  carries it, otherwise the dashboard's per-BP filter hides the card. */
  relative_path?: string;
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
  deployBusinessProcess: (body: DeployBPRequest) =>
    postJson<DeployBPResponse>('/api/automations/deploy-bp', body),
  deployStatus: (taskId: string) =>
    getJson<DeployStatusResponse>(
      `/api/automations/deploy-status/${encodeURIComponent(taskId)}`,
    ),
  promoteAutomation: (body: PromoteRequest) =>
    postJson<DeployResponse>('/api/automations/promote', body),
  removeAutomation: (id: string) =>
    deleteEmpty(`/api/automations/${encodeURIComponent(id)}`),

  inspectAutomation: (id: string) =>
    getJson<DockerInspect[]>(`/api/automations/${encodeURIComponent(id)}/inspect`),

  readme: async (bpId: string, worktree?: string): Promise<string | null> => {
    const qs = worktree ? `?worktree=${encodeURIComponent(worktree)}` : '';
    const { content } = await getJson<{ content: string | null }>(
      `/api/business-processes/${encodeURIComponent(bpId)}/readme${qs}`,
    );
    return content;
  },

  worktreeFiles: {
    tree: (name: string) =>
      getJson<FileTreeNode[]>(`/api/worktrees/${encodeURIComponent(name)}/files`),
    content: (name: string, p: string) =>
      getJson<FileContentResponse>(
        `/api/worktrees/${encodeURIComponent(name)}/files/content?path=${encodeURIComponent(p)}`,
      ),
    save: (
      name: string,
      p: string,
      body: { content: string; etag?: FileEtag },
    ) =>
      putJsonAllow4xx<FileSaveResponse>(
        `/api/worktrees/${encodeURIComponent(name)}/files/content?path=${encodeURIComponent(p)}`,
        body,
      ),
    upload: (name: string, p: string, files: File[]) => {
      const form = new FormData();
      for (const f of files) form.append('files', f, f.name);
      return postMultipart<FileUploadResponse>(
        `/api/worktrees/${encodeURIComponent(name)}/files/upload?path=${encodeURIComponent(p)}`,
        form,
      );
    },
    status: (name: string) =>
      getJson<{ changed: ChangedFile[] }>(
        `/api/worktrees/${encodeURIComponent(name)}/status`,
      ),
    diff: (name: string, p?: string) =>
      getJson<{ diff: string }>(
        `/api/worktrees/${encodeURIComponent(name)}/diff${p ? `?path=${encodeURIComponent(p)}` : ''}`,
      ),
  },

  requirements: {
    list: (bpId: string, worktree: string) =>
      getJson<Requirement[]>(
        `/api/business-processes/${encodeURIComponent(bpId)}/requirements?worktree=${encodeURIComponent(worktree)}`,
      ),
    add: (bpId: string, worktree: string, body: AddRequirementRequest) =>
      postJson<Requirement>(
        `/api/business-processes/${encodeURIComponent(bpId)}/requirements?worktree=${encodeURIComponent(worktree)}`,
        body,
      ),
    update: (
      bpId: string,
      worktree: string,
      id: string,
      patch: UpdateRequirementRequest,
    ) =>
      patchJson<Requirement>(
        `/api/business-processes/${encodeURIComponent(bpId)}/requirements/${encodeURIComponent(id)}?worktree=${encodeURIComponent(worktree)}`,
        patch,
      ),
    remove: (bpId: string, worktree: string, id: string) =>
      deleteEmpty(
        `/api/business-processes/${encodeURIComponent(bpId)}/requirements/${encodeURIComponent(id)}?worktree=${encodeURIComponent(worktree)}`,
      ),
  },
};

export interface FileTreeNode {
  name: string;
  kind: 'file' | 'folder';
  /** Workspace-relative path (without the `worktrees/<name>/` prefix). */
  path: string;
  children?: FileTreeNode[];
}

export type ChangedKind = 'A' | 'M' | 'D';

export interface ChangedFile {
  path: string;
  kind: ChangedKind;
  adds: number;
  dels: number;
}

export interface FileEtag {
  mtimeMs: number;
  size: number;
}

export type FileContentResponse =
  | { content: string; truncated: boolean; etag: FileEtag }
  | { error: 'binary' | 'too-large' | 'not-found' | string };

export type FileSaveResponse =
  | { ok: true; etag: FileEtag }
  | { error: 'conflict'; expected?: FileEtag; actual?: FileEtag }
  | { error: 'binary' | 'too-large' | 'not-found' | string };

export interface FileUploadResponse {
  written: { name: string; size: number }[];
}

export type ReqStatus = 'pending' | 'pass' | 'fail' | 'retest' | 'proposed';

export interface Requirement {
  id: string;
  description: string;
  status: ReqStatus;
  parent: string;
}

export interface AddRequirementRequest {
  text: string;
  parent?: string;
  status?: ReqStatus;
}

export interface UpdateRequirementRequest {
  description?: string;
  status?: ReqStatus;
}

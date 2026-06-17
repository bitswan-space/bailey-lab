import type {
  DockerInspect,
  SnapshotListResponse,
  SnapshotEligibility,
  SnapshotStage,
  SnapshotTask,
} from '@/types';
import { authHeader, clearAccessToken } from './auth-token';

async function getJson<T>(url: string): Promise<T> {
  let r = await fetch(url, {
    credentials: 'include',
    cache: 'no-store',
    headers: await authHeader(),
  });
  if (r.status === 401) {
    // Token may have expired — refetch from /oauth2/auth and retry once.
    clearAccessToken();
    r = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      headers: await authHeader(),
    });
  }
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
  let refreshedToken = false;
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        ...init,
        headers: { ...(init.headers as Record<string, string>), ...(await authHeader()) },
      });
      if (r.status === 401 && !refreshedToken) {
        // Token may have expired — refetch from /oauth2/auth and retry once.
        refreshedToken = true;
        clearAccessToken();
        continue;
      }
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
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
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
    headers: await authHeader(),
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
  copy?: string;
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
  copy?: string;
}

export interface DeployBPResponse {
  task_id: string;
  bp: string;
  deployment_ids: string[];
  status?: string;
}

export interface PromoteBPRequest {
  /** Business-process directory name. */
  bp: string;
  stage: 'staging' | 'production';
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
  copy?: string;
}

export interface CreateBusinessProcessResponse {
  id: string;
  name: string;
  in_main: boolean;
  copies: string[];
  has_copies: boolean;
  /** Automations scaffolded from the default template group (auto-setup). */
  automations_created?: string[];
  /** Deploy task for the auto-deploy of the scaffolded automations. */
  deploy_task_id?: string | null;
  /** Auto-setup failure detail (BP itself was still created). */
  setup_error?: string | null;
}

/** One commit row in the copy/main history. */
export interface HistoryCommit {
  sha: string;
  short: string;
  author_name: string;
  author_email: string;
  date: string;
  subject: string;
  /** Deploy markers ("<email> deployed <date>") for main commits left at the
   *  tip by a Sync & Deploy. Absent/empty on non-deploy commits. */
  deploys?: string[];
}

/** Gitops `GET /copies/{name}/history` response. */
export interface CopyHistory {
  copy: HistoryCommit[];
  main: HistoryCommit[];
}

/** One member's baked image in a BP deployment-history entry. */
export interface BpHistoryMember {
  image?: string | null;
  image_id?: string | null;
}

/** One deployment in a BP stage's history (newest-first). Derived from the git
 *  log of bitswan.yaml. */
export interface BpHistoryEntry {
  /** bitswan.yaml commit sha = the deploy-event id (the rollback key). */
  commit: string;
  // eslint-disable-next-line no-restricted-syntax -- nullable: the deployed source version
  source_commit: string | null;
  deployed_at: string;
  // eslint-disable-next-line no-restricted-syntax -- nullable wire field
  deployed_by: string | null;
  status: string; // "deployed" | "rolled-back"
  source: string; // "deploy" | "dev" | "staging" | "rollback"
  members: Record<string, BpHistoryMember>;
}

/** Gitops `GET /automations/business-processes/{bp}/history` response. */
export interface BpHistory {
  bp: string;
  stage: string;
  // eslint-disable-next-line no-restricted-syntax -- null = nothing deployed
  current: string | null;
  history: BpHistoryEntry[];
}

/** A file's content from a BP's source at a commit (Inspect → Files). */
export interface BpFileContent {
  path: string;
  content: string;
  truncated: boolean;
}

/** Gitops `POST /copies/{name}/sync` response. */
export interface SyncCopyResult {
  status: 'success' | 'needs_rebase';
  /** "fast-forward" when synced server-side. */
  method?: string | null;
  message: string;
}

/** Gitops `GET /copies/{name}/divergence?bp=` — commit counts vs main, split
 *  into the viewed business process vs all other business processes. */
export interface BpDivergence {
  bp: string;
  ahead_bp: number;
  ahead_other: number;
  behind_bp: number;
  behind_other: number;
}

/** Gitops `POST /copies/create` response (plus auto-deploy fields). */
export interface CreateCopyResponse {
  name: string;
  path: string;
  postgres_db?: string;
  /** Deploy task for the auto live-dev of the copy's automations. */
  deploy_task_id?: string | null;
  deploy_error?: string | null;
}

export interface CreateCopyRequest {
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
  copy?: string;
}

export interface CreateAutomationResponse {
  created: { name: string; relativePath: string }[];
}

export const api = {
  /**
   * Identify the logged-in user and ensure their personal copy exists
   * (created on first login, reused after). The client auto-selects `copy`.
   */
  getMe: () => getJson<{ email: string; copy: string; created: boolean }>('/api/me'),

  createBusinessProcess: (body: CreateBusinessProcessRequest) =>
    postJson<CreateBusinessProcessResponse>('/api/business-processes', body),

  createCopy: (body: CreateCopyRequest) =>
    postJson<CreateCopyResponse>('/api/copies', body),
  // No deleteCopy: deleting a copy (one's own or another user's) is not a
  // user-facing action — the dashboard never exposes it.

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
  promoteBusinessProcess: (body: PromoteBPRequest) =>
    postJson<DeployBPResponse>('/api/automations/promote-bp', body),
  /** Per-stage deployment history for a business process (newest-first). */
  bpHistory: (bp: string, stage: string) =>
    getJson<BpHistory>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/history?stage=${encodeURIComponent(stage)}`,
    ),
  /** Roll a whole BP stage back to a prior deployment (all members together). */
  bpRollback: (bp: string, stage: string, gitCommit: string) =>
    postJson<{ message: string }>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/rollback`,
      { stage, git_commit: gitCommit },
    ),
  /** Unified diff of a BP's source between two commits (history "diff vs current"). */
  bpDiff: (bp: string, from: string, to: string) =>
    getJson<{ diff: string }>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),
  /** Inspect → Scale: scale every member container of a BP stage. */
  bpScale: (bp: string, stage: string, replicas: number) =>
    postJson<{ replicas: number; members: string[] }>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/scale`,
      { stage, replicas },
    ),
  /** Inspect → Files: the full source tree of a BP at a commit. */
  bpFileTree: (bp: string, commit: string) =>
    getJson<{ entries: FileTreeNode[] }>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/files?commit=${encodeURIComponent(commit)}`,
    ),
  /** Inspect → Files: a single file's content at a commit. */
  bpFileContent: (bp: string, commit: string, path: string) =>
    getJson<BpFileContent>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/file-content?commit=${encodeURIComponent(commit)}&path=${encodeURIComponent(path)}`,
    ),
  /** Inspect → Download image: direct href for the deployment bundle download. */
  bpBundleUrl: (bp: string, stage: string, commit: string) =>
    `/api/automations/business-processes/${encodeURIComponent(bp)}/bundle?stage=${encodeURIComponent(stage)}&commit=${encodeURIComponent(commit)}`,
  deployStatus: (taskId: string) =>
    getJson<DeployStatusResponse>(
      `/api/automations/deploy-status/${encodeURIComponent(taskId)}`,
    ),
  promoteAutomation: (body: PromoteRequest) =>
    postJson<DeployResponse>('/api/automations/promote', body),
  removeAutomation: (id: string) =>
    deleteEmpty(`/api/automations/${encodeURIComponent(id)}`),

  // Stage 1.5: scaffold frontends / worker containers into a BP directly from
  // the baked templates (no gallery picker). One frontend kind; workers by
  // type (only "go" today).
  addFrontend: (body: { bp: string; name: string; copy?: string }) =>
    postJson<CreateAutomationResponse>('/api/automations/frontend', body),
  addWorker: (body: {
    bp: string;
    name: string;
    type: string;
    copy?: string;
  }) => postJson<CreateAutomationResponse>('/api/automations/worker', body),
  renameAutomation: (body: {
    bp: string;
    old_name: string;
    new_name: string;
    copy?: string;
  }) => postJson<CreateAutomationResponse>('/api/automations/rename', body),

  inspectAutomation: (id: string) =>
    getJson<DockerInspect[]>(`/api/automations/${encodeURIComponent(id)}/inspect`),

  readme: async (bpId: string, copy?: string): Promise<string | null> => {
    const qs = copy ? `?copy=${encodeURIComponent(copy)}` : '';
    const { content } = await getJson<{ content: string | null }>(
      `/api/business-processes/${encodeURIComponent(bpId)}/readme${qs}`,
    );
    return content;
  },

  copyFiles: {
    tree: (name: string) =>
      getJson<FileTreeNode[]>(`/api/copies/${encodeURIComponent(name)}/files`),
    content: (name: string, p: string) =>
      getJson<FileContentResponse>(
        `/api/copies/${encodeURIComponent(name)}/files/content?path=${encodeURIComponent(p)}`,
      ),
    save: (
      name: string,
      p: string,
      body: { content: string; etag?: FileEtag },
    ) =>
      putJsonAllow4xx<FileSaveResponse>(
        `/api/copies/${encodeURIComponent(name)}/files/content?path=${encodeURIComponent(p)}`,
        body,
      ),
    upload: (name: string, p: string, files: File[]) => {
      const form = new FormData();
      for (const f of files) form.append('files', f, f.name);
      return postMultipart<FileUploadResponse>(
        `/api/copies/${encodeURIComponent(name)}/files/upload?path=${encodeURIComponent(p)}`,
        form,
      );
    },
    remove: (name: string, p: string) =>
      deleteEmpty(
        `/api/copies/${encodeURIComponent(name)}/files?path=${encodeURIComponent(p)}`,
      ),
    /** URL that streams a file's raw bytes (downloads, binary attachments). */
    rawUrl: (name: string, p: string) =>
      `/api/copies/${encodeURIComponent(name)}/files/raw?path=${encodeURIComponent(p)}`,
    status: (name: string) =>
      getJson<{ changed: ChangedFile[] }>(
        `/api/copies/${encodeURIComponent(name)}/status`,
      ),
    /** Commit divergence from main split into this BP vs every other BP, so the
     *  per-BP Sync & Deploy screen reflects the BP being viewed. */
    divergence: (name: string, bp: string) =>
      getJson<BpDivergence>(
        `/api/copies/${encodeURIComponent(name)}/divergence?bp=${encodeURIComponent(bp)}`,
      ),
    diff: (name: string, p?: string) =>
      getJson<{ diff: string }>(
        `/api/copies/${encodeURIComponent(name)}/diff${p ? `?path=${encodeURIComponent(p)}` : ''}`,
      ),
    /** Unified diff introduced by a single commit (`git show`), for the
     *  clickable rows in the History view. */
    commitDiff: (name: string, sha: string) =>
      getJson<{ diff: string }>(
        `/api/copies/${encodeURIComponent(name)}/commit/${encodeURIComponent(sha)}/diff`,
      ),
    /**
     * Sync the copy into main. Commits WIP and, when the copy is a pure
     * fast-forward of main (no rebase needed), fast-forwards main to it
     * server-side. Returns `needs_rebase` when main has diverged — the caller
     * then hands off to the coding agent to rebase.
     */
    sync: (name: string, bp?: string) =>
      postJson<SyncCopyResult>(
        `/api/copies/${encodeURIComponent(name)}/sync`,
        bp ? { bp } : {},
      ),
    history: (name: string) =>
      getJson<CopyHistory>(`/api/copies/${encodeURIComponent(name)}/history`),
  },

  snapshots: {
    /** Snapshots + eligibility + disk usage + in-flight tasks for one BP. */
    list: (bp: string) =>
      getJson<SnapshotListResponse>(`/api/snapshots/${encodeURIComponent(bp)}`),
    /** Registry flags + live service availability per stage. */
    eligibility: (bp: string) =>
      getJson<SnapshotEligibility>(
        `/api/snapshots/${encodeURIComponent(bp)}/eligibility`,
      ),
    /** Opt the BP into per-BP databases at one stage (starts empty). */
    provision: (bp: string, stage: SnapshotStage, bpName?: string) =>
      postJson<{ bp: string; stage: string; services: Record<string, string> }>(
        `/api/snapshots/${encodeURIComponent(bp)}/provision`,
        { stage, ...(bpName ? { bp_name: bpName } : {}) },
      ),
    /** Start a background snapshot. 202 + task_id. */
    create: (bp: string, stage: SnapshotStage, label?: string) =>
      postJson<{ task_id: string }>(
        `/api/snapshots/${encodeURIComponent(bp)}/${encodeURIComponent(stage)}`,
        { label: label ?? '' },
      ),
    /** Restore a snapshot into a target stage (replace semantics). */
    restore: (
      bp: string,
      body: {
        snapshot_id: string;
        source_stage: SnapshotStage;
        target_stage: SnapshotStage;
      },
    ) =>
      postJson<{ task_id: string }>(
        `/api/snapshots/${encodeURIComponent(bp)}/restore`,
        body,
      ),
    /** One-click stage→stage data clone. */
    clone: (
      bp: string,
      body: { source_stage: SnapshotStage; target_stage: SnapshotStage },
    ) =>
      postJson<{ task_id: string }>(
        `/api/snapshots/${encodeURIComponent(bp)}/clone`,
        body,
      ),
    remove: (bp: string, stage: SnapshotStage, snapshotId: string) =>
      deleteEmpty(
        `/api/snapshots/${encodeURIComponent(bp)}/${encodeURIComponent(stage)}/${encodeURIComponent(snapshotId)}`,
      ),
    /** Snapshot-task poll endpoint (the SSE event is a freshness bonus). */
    taskStatus: (taskId: string) =>
      getJson<SnapshotTask>(
        `/api/snapshots/tasks/${encodeURIComponent(taskId)}`,
      ),
  },

  requirements: {
    list: (bpId: string, copy: string) =>
      getJson<Requirement[]>(
        `/api/business-processes/${encodeURIComponent(bpId)}/requirements?copy=${encodeURIComponent(copy)}`,
      ),
    add: (bpId: string, copy: string, body: AddRequirementRequest) =>
      postJson<Requirement>(
        `/api/business-processes/${encodeURIComponent(bpId)}/requirements?copy=${encodeURIComponent(copy)}`,
        body,
      ),
    update: (
      bpId: string,
      copy: string,
      id: string,
      patch: UpdateRequirementRequest,
    ) =>
      patchJson<Requirement>(
        `/api/business-processes/${encodeURIComponent(bpId)}/requirements/${encodeURIComponent(id)}?copy=${encodeURIComponent(copy)}`,
        patch,
      ),
    remove: (bpId: string, copy: string, id: string) =>
      deleteEmpty(
        `/api/business-processes/${encodeURIComponent(bpId)}/requirements/${encodeURIComponent(id)}?copy=${encodeURIComponent(copy)}`,
      ),
  },
};

export interface FileTreeNode {
  name: string;
  kind: 'file' | 'folder';
  /** Workspace-relative path (without the `copies/<name>/` prefix). */
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

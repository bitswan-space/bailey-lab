import type {
  DockerInspect,
  GitTask,
  Snapshot,
  SnapshotListResponse,
  SnapshotEligibility,
  SnapshotStage,
  SnapshotTask,
} from '@/types';
import { authHeader, clearAccessToken } from './auth-token';
import { notifySessionExpired, SessionExpiredError } from './session';

// When the oauth2-proxy SESSION expires, it answers API calls with a 302 to the
// Keycloak auth endpoint — NOT a 401. With the default `redirect: 'follow'` the
// browser chases that cross-origin redirect, the page CSP `connect-src` blocks
// it, and the fetch throws an opaque `TypeError: Failed to fetch` that looks
// like a transient network blip. So every request uses `redirect: 'manual'`:
// an auth redirect then comes back as an *opaque-redirect response*
// (`type === 'opaqueredirect'`, status 0) we can detect cleanly — and the CSP
// violation never happens. That (or a 401) means "session gone → re-login".
const FETCH_BASE: RequestInit = {
  credentials: 'include',
  cache: 'no-store',
  redirect: 'manual',
};

function isSessionGone(r: Response): boolean {
  return r.type === 'opaqueredirect' || r.status === 0 || r.status === 401;
}

async function getJson<T>(url: string): Promise<T> {
  let r = await fetch(url, { ...FETCH_BASE, headers: await authHeader() });
  if (isSessionGone(r)) {
    // Access token may just be stale — refetch from /oauth2/auth and retry once.
    clearAccessToken();
    r = await fetch(url, { ...FETCH_BASE, headers: await authHeader() });
  }
  // Still redirected/401 after a refresh → the oauth2-proxy SESSION is gone, not
  // just the token. Raise the app-wide signal (one banner prompts re-login) and
  // throw a typed error so callers stay silent instead of rendering a failure.
  if (isSessionGone(r)) {
    notifySessionExpired();
    throw new SessionExpiredError();
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
        ...FETCH_BASE,
        ...init,
        headers: { ...(init.headers as Record<string, string>), ...(await authHeader()) },
      });
      if (isSessionGone(r) && !refreshedToken) {
        // Token may just be stale — refetch from /oauth2/auth and retry once.
        refreshedToken = true;
        clearAccessToken();
        continue;
      }
      // Still redirected/401 after the refresh → expired session (see getJson).
      if (isSessionGone(r)) {
        notifySessionExpired();
        throw new SessionExpiredError();
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

async function delJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetchWithRetry(url, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await r.json()) as T;
}

async function putJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetchWithRetry(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await r.json()) as T;
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
  status: string; // "deployed" | "rolled-back" | "firewall" | "backup"
  source: string; // "deploy" | "dev" | "staging" | "rollback" | "firewall" | "backup"
  members: Record<string, BpHistoryMember>;
  /** Present on firewall-change events: the realm + a one-line summary of the
   *  change and the resulting allowed/denied counts (for the audit-log row). */
  firewall?: {
    realm: string;
    summary: string;
    allowed: number;
    denied: number;
  };
  /** Present on backup-domain events (snapshot create / restore-to-DR / DR
   *  swap / retention change): the action + a one-line detail for the row. */
  backup?: {
    action: string; // created | restored | swapped | retention
    // eslint-disable-next-line no-restricted-syntax -- nullable wire field
    detail: string | null;
    summary: string;
  };
}

/** Gitops `GET /automations/business-processes/{bp}/history` response. */
export interface BpHistory {
  bp: string;
  stage: string;
  // eslint-disable-next-line no-restricted-syntax -- null = nothing deployed
  current: string | null;
  history: BpHistoryEntry[];
}

/** One stage's secret values: {KEY: value}. */
export type StageSecrets = Record<string, string>;

/** A BP's decrypted secrets, keyed by realm (dev / staging / production; dev
 *  covers live-dev). Secret NAMES are shared across stages; VALUES are per
 *  stage, so this is the full per-stage map. */
export type BpSecrets = Record<string, StageSecrets>;

/** Disaster-recovery cadence policy: how often a manual recovery test is
 *  expected. Maps to a window in days (monthly 30, quarterly 91,
 *  semi-annually 182, annually 365). */
export type DrPolicy = 'monthly' | 'quarterly' | 'semi-annually' | 'annually';

/** One hand-performed recovery-test log entry. `at` is a human date string
 *  (e.g. "Jun 17, 2026"); `date` is the ISO yyyy-mm-dd used for the overdue
 *  calculation. */
export interface DrTest {
  id: string;
  by: string;
  at: string;
  date: string;
  // eslint-disable-next-line no-restricted-syntax -- null = test without a specific backup
  snapshot: string | null;
  note: string;
  verified: boolean;
}

/** A BP's disaster-recovery status: cadence policy, the manual recovery-test
 *  log (newest-first), and the derived overdue flag. `last`/`days_since` are
 *  null when no test has been recorded; `overdue` is true then too. */
export interface DrStatus {
  policy: DrPolicy;
  window_days: number;
  tests: DrTest[];
  // eslint-disable-next-line no-restricted-syntax -- null = never tested
  last: { by: string; at: string; date: string } | null;
  // eslint-disable-next-line no-restricted-syntax -- null = never tested
  days_since: number | null;
  overdue: boolean;
  /** The Production backup currently restored into the DR standby db — the
   *  only backup that may be marked recovery-tested. Null when nothing has
   *  been restored into DR yet. */
  // eslint-disable-next-line no-restricted-syntax -- null = nothing restored into DR
  restored: { snapshot: string; by: string; at: string; date: string } | null;
}

/** One snapshot item from `bpSnapshots` (the gitops snapshot manifest). Alias
 *  of {@link Snapshot} — the DR panel's "tested against" picker renders
 *  `label` / `created_at` / `total_size_bytes` (and `id` / `stage`). */
export type BpSnapshot = Snapshot;

/** One audited backup-domain event (created / restored / swapped / retention). */
export interface BackupEvent {
  id: string;
  action: 'created' | 'restored' | 'swapped' | 'retention' | string;
  detail: string;
  by: string;
  at: string;
  date: string;
}

export type AppSlot = 'a' | 'b' | 'c';

/** A BP's blue-green production state: 3 app slots (a/b/c) over 2 persistent
 *  DBs. live_db is which DB is Production (the other is the DR standby);
 *  live_slot is which app slot the ingress serves; dr_slot is the slot wired
 *  to the standby DB; the idle slots are the zero-downtime-promote buffer. */
export interface BackupState {
  bp: string;
  live_db: 1 | 2;
  standby_db: 1 | 2;
  live_slot: AppSlot;
  // eslint-disable-next-line no-restricted-syntax -- null = no DR slot provisioned
  dr_slot: AppSlot | null;
  idle_slots: AppSlot[];
  /** Active app slots → the DB each is wired to. */
  slots: Record<string, { db: number; state?: string }>;
  retention: { daily: number; weekly: number; monthly: number };
  log: BackupEvent[];
}

/** Supply chain: CVE severity buckets the UI renders. */
export type CveSeverity = 'critical' | 'high' | 'medium' | 'low';
export interface SupplyChainCve {
  id: string;
  severity: CveSeverity;
}
export interface SupplyChainPackage {
  name: string;
  version: string;
  type: string;
  cves: SupplyChainCve[];
}
/** An out-of-scope marking (who/when/why) — logged in bitswan.yaml. */
export interface CveWaiver {
  package: string;
  cve: string;
  by: string;
  at: string;
  comment: string;
}
/** `supplyChain(bp, stage)` — SBOM + CVEs + waivers for a stage's deployed image(s). */
export interface SupplyChainReport {
  bp: string;
  stage: string;
  /** ok | pending (scan not done) | unavailable (scan failed) | not-deployed */
  status: string;
  // eslint-disable-next-line no-restricted-syntax -- null until first scan
  scanned_at: string | null;
  image_count: number;
  packages: SupplyChainPackage[];
  waivers: CveWaiver[];
}

/** Egress firewall (outbound allow-list). */
/** GDPR data-processing record for an allowed 3rd-party host (the wireframe's
 *  approval form). `dpaFile` is the original name of an uploaded DPA PDF stored
 *  in the gitops repo (downloadable via firewallDpaUrl); empty when none. */
export interface GdprRecord {
  noUserData: boolean;
  dataSent?: string;
  purpose?: string;
  stored?: 'no' | 'transient' | 'yes';
  jurisdiction?: string;
  dpaFile?: string;
}

export interface FirewallRule {
  host: string;
  status: 'allowed' | 'denied';
  purpose?: string;
  by?: string;
  at?: string;
  gdpr?: GdprRecord | null;
}
export interface FirewallAttempt {
  host: string;
  count: number;
  // eslint-disable-next-line no-restricted-syntax -- nullable telemetry
  last: string | null;
  proto?: string;
}
export interface FirewallReport {
  bp: string;
  stage: string;
  posture: 'monitor' | 'enforce' | string;
  rules: FirewallRule[];
  attempts: FirewallAttempt[]; // "needs review" — observed hosts with no rule yet
  allowed: string[];
}

/** Infra services shown in the Containers tab's "Stage services" row. */
export type ServiceType = 'postgres' | 'minio' | 'couchdb';

/** Status of one infra service at a stage (subset we use — gitops returns more
 *  when show_passwords=true). `connection_info.admin_ui` is the admin console. */
export interface ServiceStatus {
  service: string;
  enabled: boolean;
  running: boolean;
  // eslint-disable-next-line no-restricted-syntax -- nullable upstream field
  connection_info?: { admin_ui?: string | null } | null;
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
  /** Task id of the dev-stage redeploy the sync ALREADY spawned server-side so
   *  the deployed dev stage tracks main. The client must TRACK this task — not
   *  fire its own deploy, which would collide with it (409). Null when nothing
   *  was deployed (no change, or no deployable members). */
  // eslint-disable-next-line no-restricted-syntax -- null = sync deployed nothing
  deploy_task_id?: string | null;
}

/** Gitops `POST /copies/{name}/rebase` response — pulling main into a copy. */
export interface RebaseCopyResult {
  status: 'success' | 'needs_rebase' | 'noop';
  message: string;
  /** BPs whose image dir changed in the pull and were redeployed. */
  redeployed_bps?: string[];
  /** Task ids of the live-dev redeploys spawned for those BPs. */
  deploy_task_ids?: string[];
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
  getMe: () =>
    getJson<{ email: string; copy: string; created?: boolean; role?: 'admin' | 'auditor' | 'member' }>(
      '/api/me',
    ),

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
  /** Roll a BP stage back to a prior state. `kind=deploy` (default) re-points the
   *  member deployments; `kind=firewall` restores the egress allow-list to that
   *  commit (production needs admin/auditor — gated server-side). */
  bpRollback: (bp: string, stage: string, gitCommit: string, kind: 'deploy' | 'firewall' = 'deploy') =>
    postJson<{ message: string }>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/rollback`,
      { stage, git_commit: gitCommit, kind },
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
  /** Deployments → Secrets: a BP's decrypted per-stage secrets. */
  bpSecrets: (bp: string) =>
    getJson<BpSecrets>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/secrets`,
    ),
  /** Apply a BP's secrets (all stages) — encrypts + versions them in
   *  bitswan.yaml as one commit. Names are shared; values are per stage. */
  setBpSecrets: (bp: string, values: BpSecrets) =>
    putJson<BpSecrets>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/secrets`,
      { values },
    ),
  /** Disaster Recovery: a BP's recovery-test cadence + manual test log. */
  drStatus: (bp: string) =>
    getJson<DrStatus>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/dr`,
    ),
  /** Disaster Recovery: set the recovery-test cadence policy. */
  setDrPolicy: (bp: string, policy: DrPolicy) =>
    putJson<DrStatus>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/dr/policy`,
      { policy },
    ),
  /** Disaster Recovery: record a hand-performed recovery test (versioned). */
  recordDrTest: (
    bp: string,
    body: { by?: string; note?: string; snapshot?: string },
  ) =>
    postJson<DrStatus>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/dr/tests`,
      body,
    ),
  /** Backups: blue-green slot state (live vs standby/DR), retention, audit log. */
  backups: (bp: string) =>
    getJson<BackupState>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/backups`,
    ),
  /** Backups: set the production retention policy (daily/weekly/monthly). */
  setBackupRetention: (
    bp: string,
    retention: { daily: number; weekly: number; monthly: number },
  ) =>
    putJson<BackupState>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/backups/retention`,
      retention,
    ),
  /** Backups: DR go-live swap — flip live_db to the standby and repoint the
   *  ingress to the DR slot (zero downtime, no data moved). */
  swapProductionDr: (bp: string) =>
    postJson<BackupState>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/backups/swap`,
      {},
    ),
  /** Backups: zero-downtime promote — stage the new version on the idle slot
   *  (current live db), repoint the ingress to it, retire the old slot. */
  zeroDowntimePromote: (bp: string) =>
    postJson<BackupState>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/backups/promote`,
      {},
    ),
  /** Firewall: egress allow-list rules + blocked/observed attempts for a stage. */
  firewall: (bp: string, stage: string) =>
    getJson<FirewallReport>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/firewall?stage=${encodeURIComponent(stage)}`,
    ),
  /** Firewall: allow or deny an outbound host (versioned + audited). */
  setFirewallRule: (
    bp: string,
    body: { stage: string; host: string; status: 'allowed' | 'denied'; purpose?: string; gdpr?: GdprRecord },
  ) =>
    putJson<FirewallReport>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/firewall/rules`,
      body,
    ),
  /** Firewall: remove a rule (revoke an allow / clear a deny). */
  deleteFirewallRule: (bp: string, body: { stage: string; host: string }) =>
    delJson<FirewallReport>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/firewall/rules`,
      body,
    ),
  /** Firewall: pull rules forward (dev→staging→production). */
  promoteFirewall: (bp: string, body: { from_stage: string; to_stage: string }) =>
    postJson<FirewallReport>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/firewall/promote`,
      body,
    ),
  /** Firewall: upload a host's GDPR data-processing-agreement PDF (stored +
   *  versioned in the gitops repo). Returns the stored filename. */
  uploadFirewallDpa: (bp: string, body: { stage: string; host: string; file: File }) => {
    const form = new FormData();
    form.set('stage', body.stage);
    form.set('host', body.host);
    form.set('file', body.file, body.file.name);
    return postMultipart<{ stored: string; filename: string }>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/firewall/dpa`,
      form,
    );
  },
  /** Firewall: download URL for a host's stored DPA PDF (open in a new tab). */
  firewallDpaUrl: (bp: string, host: string) =>
    `/api/automations/business-processes/${encodeURIComponent(bp)}/firewall/dpa?host=${encodeURIComponent(host)}`,
  /** Supply chain: SBOM packages + CVEs + waiver log for a stage's image(s). */
  supplyChain: (bp: string, stage: string) =>
    getJson<SupplyChainReport>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/supply-chain?stage=${encodeURIComponent(stage)}`,
    ),
  /** Supply chain: CVEs for the image a deploy of this BP would build from the
   *  current copy's source (Sync & Deploy → Checks). Builds + scans on demand. */
  supplyChainPreview: (bp: string, copy: string | null) =>
    getJson<SupplyChainReport>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/supply-chain/preview${copy ? `?copy=${encodeURIComponent(copy)}` : ''}`,
    ),
  /** Supply chain: mark a CVE out of scope. Stored in the copy's source tree
   *  (cve-waivers.yaml, committed) — authored from the Checks tab, so it carries
   *  to main with the code. Returns the refreshed Checks preview. */
  addCveWaiver: (
    bp: string,
    body: { copy: string | null; package: string; cve: string; comment: string },
  ) =>
    postJson<SupplyChainReport>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/supply-chain/waivers`,
      body,
    ),
  /** Supply chain: restore a previously out-of-scope CVE to in-scope (in the copy). */
  removeCveWaiver: (bp: string, body: { copy: string | null; package: string; cve: string }) =>
    delJson<SupplyChainReport>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/supply-chain/waivers`,
      body,
    ),
  /** Disaster Recovery: the BP's snapshot list (the "tested against" picker). */
  bpSnapshots: (bp: string) =>
    getJson<SnapshotListResponse>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/snapshots`,
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

  /** Infra-service status for a stage (Containers tab "Stage services" row).
   *  Returns enabled/running + the admin-console URL when present. */
  serviceStatus: (type: ServiceType, stage: string) =>
    getJson<ServiceStatus>(
      `/api/services/${encodeURIComponent(type)}/status?stage=${encodeURIComponent(stage)}`,
    ),

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
    /** Full-text search across the copy's files (optionally scoped to a dir). */
    search: (name: string, q: string, scope?: string) =>
      getJson<FileSearchResponse>(
        `/api/copies/${encodeURIComponent(name)}/files/search?q=${encodeURIComponent(q)}` +
          (scope ? `&scope=${encodeURIComponent(scope)}` : ''),
      ),
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
    /** Per-BP ahead/behind for the whole copy in one call (only diverging BPs
     *  are present). Lets the switcher show ↑/↓ on each BP at a glance. */
    divergenceAll: (name: string) =>
      getJson<Record<string, { ahead: number; behind: number }>>(
        `/api/copies/${encodeURIComponent(name)}/divergence-all`,
      ),
    diff: (name: string, p?: string) =>
      getJson<{ diff: string }>(
        `/api/copies/${encodeURIComponent(name)}/diff${p ? `?path=${encodeURIComponent(p)}` : ''}`,
      ),
    /** Unified diff introduced by a single commit (`git show`), for the
     *  clickable rows in the History view. `bp` names the business-process
     *  repo the commit lives in (each BP is its own repo). */
    commitDiff: (name: string, sha: string, bp?: string) =>
      getJson<{ diff: string }>(
        `/api/copies/${encodeURIComponent(name)}/commit/${encodeURIComponent(sha)}/diff${bp ? `?bp=${encodeURIComponent(bp)}` : ''}`,
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
    /**
     * Pull main's new commits INTO the copy (rebase the whole copy onto main).
     * The opposite direction from `sync`. A clean rebase advances the copy and
     * redeploys live-dev only for BPs whose image dir changed; `needs_rebase`
     * means a conflict that the coding agent must resolve.
     */
    rebase: (name: string) =>
      postJson<RebaseCopyResult>(
        `/api/copies/${encodeURIComponent(name)}/rebase`,
        {},
      ),
    /** Copy-branch + main commit logs with deploy tags, scoped to one
     *  business process's repo. */
    history: (name: string, bp: string) =>
      getJson<CopyHistory>(
        `/api/copies/${encodeURIComponent(name)}/history?bp=${encodeURIComponent(bp)}`,
      ),
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
        // 'dr' = restore into Production's standby (DR) slot — never live prod.
        target_stage: SnapshotStage | 'dr';
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

  /** Git task queue. The live feed comes over the `/api/events` SSE stream;
   *  this is the initial snapshot fetch on mount. */
  tasks: () => getJson<{ tasks: GitTask[] }>('/api/tasks'),
  /** Admin-only: cancel all queued/running git tasks (gitops 403s non-admins,
   *  and the server route gates it too). Returns the cancelled count. */
  clearTasks: () => postJson<{ cancelled: number }>('/api/tasks/clear', {}),
};

export interface FileTreeNode {
  name: string;
  kind: 'file' | 'folder';
  /** Workspace-relative path (without the `copies/<name>/` prefix). */
  path: string;
  children?: FileTreeNode[];
}

/** One line matching a full-text file search. */
export interface FileSearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface FileSearchResponse {
  matches: FileSearchMatch[];
  truncated: boolean;
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

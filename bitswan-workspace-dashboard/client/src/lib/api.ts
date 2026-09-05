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

/**
 * The request never reached the dashboard: the WORKSPACE ROUTER answered it.
 *
 * Every route this app calls exists on the dashboard server and every one of
 * its answers — success or failure, including its own 404 handler and every
 * error it forwards from gitops — is JSON. So a 404/502/503/504 carrying
 * something that is NOT JSON did not come from us; it is Traefik's plain-text
 * "404 page not found" (or a gateway page), served while it has no router for
 * this host.
 *
 * That window is routine here rather than exotic: creating a business process
 * starts containers, which reconfigures Traefik, and requests in flight across
 * the reload get one of these. A user creating a business process was shown
 * "Couldn't read whether main has changes bp hasn't pulled yet: 404 page not
 * found" for it (bailey-lab #362) — a scary sentence about their git state
 * that was really "the router blinked". Detecting it is what lets us retry
 * instead of reporting it, and name it honestly when the retries run out.
 */
function isEdgeUnavailable(r: Response): boolean {
  if (r.status !== 404 && r.status !== 502 && r.status !== 503 && r.status !== 504) {
    return false;
  }
  return !(r.headers.get('content-type') ?? '').includes('json');
}

/** Thrown when the request never reached the dashboard — see
 *  {@link isEdgeUnavailable}. Typed so callers can tell "the router blinked"
 *  from "the server answered and said no". */
export class EdgeUnavailableError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(
      `the dashboard was not reachable through the workspace router (HTTP ${status}) — ` +
        'this usually clears within a few seconds of a container starting or stopping',
    );
    this.name = 'EdgeUnavailableError';
    this.status = status;
  }
}

/** Retries for an edge blip. Two more attempts over ~1.2s: a Traefik
 *  reconfigure is measured in hundreds of milliseconds, and a router that is
 *  still missing after this is not a blip. */
const EDGE_RETRY_DELAYS_MS = [300, 900];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson<T>(url: string): Promise<T> {
  const r = await getOnce(url);
  if (!r.ok) await throwHttpError(url, r);
  return jsonBody<T>(url, r);
}

/**
 * One GET, with the two retries that are never the caller's business: a stale
 * access token (refetched once) and an edge blip (see `isEdgeUnavailable`).
 * Returns the last response; the caller decides what a non-2xx means.
 */
async function getOnce(url: string): Promise<Response> {
  let refreshedToken = false;
  let edgeAttempt = 0;
  for (;;) {
    const r = await fetch(url, { ...FETCH_BASE, headers: await authHeader() });
    if (isSessionGone(r) && !refreshedToken) {
      // Access token may just be stale — refetch from /oauth2/auth and retry
      // once.
      refreshedToken = true;
      clearAccessToken();
      continue;
    }
    // Still redirected/401 after a refresh → the oauth2-proxy SESSION is gone,
    // not just the token. Raise the app-wide signal (one banner prompts
    // re-login) and throw a typed error so callers stay silent instead of
    // rendering a failure.
    if (isSessionGone(r)) {
      notifySessionExpired();
      throw new SessionExpiredError();
    }
    const delay = EDGE_RETRY_DELAYS_MS[edgeAttempt];
    if (!isEdgeUnavailable(r) || delay === undefined) return r;
    edgeAttempt += 1;
    await sleep(delay);
  }
}

/**
 * getJson that returns null on 404 instead of throwing — for endpoints where
 * "not found" is a typed state, not a failure (e.g. the data explorer's
 * "this BP has no database/bucket yet").
 */
async function getJsonOr404<T>(url: string): Promise<T | null> {
  const r = await getOnce(url);
  // Only OUR 404 is the typed "not found" state. A router 404 means the
  // question was never asked, and answering it with "there is no database
  // here" would be an invention — `getOnce` has already retried it, so let
  // `throwHttpError` name it.
  if (r.status === 404 && !isEdgeUnavailable(r)) return null;
  if (!r.ok) await throwHttpError(url, r);
  return jsonBody<T>(url, r);
}

// Turn a non-2xx response into an Error that carries the server's own message
// (the dashboard proxy forwards gitops errors as `{error, status, body:{detail}}`;
// gitops itself uses `{detail}`), so callers can surface the REAL failure — e.g.
// a Docker build error from the supply-chain preview — instead of a generic
// "returned 502". Never swallow the reason.
async function throwHttpError(url: string, r: Response): Promise<never> {
  // The workspace router answered, not us. Its body ("404 page not found") is
  // a fact about routing, and pasting it into a sentence about the user's git
  // state is how #362 read. Say what actually happened instead.
  if (isEdgeUnavailable(r)) throw new EdgeUnavailableError(r.status);
  let detail = '';
  try {
    const ct = r.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      const j = (await r.json()) as Record<string, unknown>;
      const nested = j.body as Record<string, unknown> | undefined;
      detail =
        (typeof nested?.detail === 'string' && nested.detail) ||
        (typeof j.detail === 'string' && j.detail) ||
        (typeof j.error === 'string' && j.error) ||
        '';
    } else {
      detail = (await r.text()).trim().slice(0, 800);
    }
  } catch {
    // Body unreadable — fall back to the status-only message below.
  }
  throw new Error(detail || `${url} returned ${r.status}`);
}

/** The message a caught error carries, without the `Error: ` prefix that
 *  `String(err)` prepends — what the user is shown in a toast. Errors from
 *  this module already hold the server's own detail (see `throwHttpError`). */
// eslint-disable-next-line no-restricted-syntax -- catch parameter is genuinely unknown
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Retry once on transient network errors. Container-state actions trigger a
// Traefik route reconfigure that briefly tears down the shared HTTP/2
// connection — the in-flight request surfaces as `TypeError: Failed to fetch`
// (Chromium reports `net::ERR_NETWORK_CHANGED`) even though the upstream call
// usually succeeded. A short backoff is enough for the new connection to be
// ready.
async function sendOnce(url: string, init: RequestInit): Promise<Response> {
  let refreshedToken = false;
  let retriedEdge = false;
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
      // A router 404 (see isEdgeUnavailable) means NO backend was contacted —
      // Traefik matched no route at all — so even a POST is safe to send
      // again. Deliberately only the 404: a gateway 5xx may well mean the
      // request reached an upstream and died there, and re-sending a deploy or
      // a delete on that guess is not a trade we make.
      if (r.status === 404 && isEdgeUnavailable(r) && !retriedEdge) {
        retriedEdge = true;
        await sleep(EDGE_RETRY_DELAYS_MS[0] ?? 300);
        continue;
      }
      return r;
    } catch (err) {
      if (attempt === 1 || !isTransientNetworkError(err)) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/**
 * A write with the same edge/session handling as `sendOnce`, plus the GET
 * helpers' contract that a non-2xx carries the server's own message — never a
 * bare "returned 502". Every mutating call (deploy, sync, merge, delete)
 * reports failures through here, and a status code alone tells the user
 * nothing about what actually went wrong.
 */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  const r = await sendOnce(url, init);
  if (!r.ok) await throwHttpError(url, r);
  return r;
}

/**
 * Read a response body as JSON, and say what arrived when it isn't.
 *
 * Every route this app calls answers in JSON, so a body that will not parse
 * came from something in front of the dashboard — Traefik's plain-text page
 * during a route reconfigure, a proxy's own error, a login page. Handing the
 * parser's message ("Unexpected non-whitespace character after JSON at
 * position 4") to the user names none of that; it reads like corruption in
 * their own document.
 *
 * A router page is exactly what `isEdgeUnavailable` describes, so it gets the
 * same sentence the read path already uses. Anything else reports the status,
 * the content type and what the body said — and NOT the url: these messages
 * are rendered to the user, and a url carries the business process's directory
 * name into a screen that must show its title.
 */
async function jsonBody<T>(url: string, r: Response): Promise<T> {
  const text = await r.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    if (isEdgeUnavailable(r)) throw new EdgeUnavailableError(r.status);
    const type = r.headers.get('content-type') ?? 'no content-type';
    const snippet = text.trim().slice(0, 120) || '(empty body)';
    throw new Error(
      `the dashboard answered HTTP ${r.status} with a body that is not JSON (${type}): ${snippet}`,
    );
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
  return jsonBody<T>(url, r);
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
  return jsonBody<T>(url, r);
}

async function putJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetchWithRetry(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return jsonBody<T>(url, r);
}

async function patchJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetchWithRetry(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return jsonBody<T>(url, r);
}

/**
 * PUT with a JSON body that may legitimately return a 4xx with a JSON
 * body (e.g. 409 on save-conflict) — we want to surface those instead of
 * throwing. Callers narrow the return via the union type.
 */
async function putJsonAllow4xx<T>(url: string, body: unknown): Promise<T> {
  const r = await sendOnce(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // Parse JSON regardless of status — the body carries the structured
  // error shape (binary / too-large / conflict / …).
  return jsonBody<T>(url, r);
}

/**
 * DELETE that may legitimately return a 4xx with a JSON body (e.g. the BP
 * delete's 409 guard listing blocking staging/production deployments) — we
 * surface those instead of throwing. Callers narrow via a union type on
 * `status`.
 */
async function deleteAllow4xx<T>(url: string): Promise<T & { status: number }> {
  const r = await sendOnce(url, { method: 'DELETE' });
  let body: unknown = {};
  try {
    body = await jsonBody<T>(url, r);
  } catch {
    // non-JSON error body
  }
  return { ...(body as T), status: r.status };
}

/**
 * Multipart POST without our retry layer (retrying an upload would
 * double-write files and break browser progress tracking).
 */
async function postMultipart<T>(url: string, form: FormData): Promise<T> {
  const r = await fetch(url, {
    ...FETCH_BASE,
    method: 'POST',
    headers: await authHeader(),
    body: form,
  });
  if (isSessionGone(r)) {
    notifySessionExpired();
    throw new SessionExpiredError();
  }
  if (!r.ok) await throwHttpError(url, r);
  return jsonBody<T>(url, r);
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
  /** Append-only history of every progress line (image build steps, build.sh
   *  output, per-member "Prepared N/M", …). `message` is only the latest line;
   *  this keeps them all so the UI can render a scrollable deploy log. */
  log?: string[];
  error?: string | null;
  bp?: string | null;
  total?: number | null;
  current?: number;
}

export interface CreateBusinessProcessRequest {
  /** Human-readable display name; the server derives the slug from it. */
  name: string;
  copy?: string;
}

export interface CreateBusinessProcessResponse {
  id: string;
  /** The slug the server derived from the requested display name. */
  name: string;
  display_name?: string;
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

export interface RenameBusinessProcessRequest {
  /** The new human-readable display name; the slug does not change. */
  name: string;
  /** Scope holding the process.toml to edit — omit for main. */
  copy?: string;
}

export interface RenameBusinessProcessResponse {
  id: string;
  /** The immutable slug. */
  name: string;
  display_name?: string;
  in_main: boolean;
  copies: string[];
  has_copies: boolean;
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
   *  tip by a Deploy. Absent/empty on non-deploy commits. */
  deploys?: string[];
}

/** Gitops `GET /copies/{name}/history` response. */
/** One commit as a confirm dialog needs to show it: who wrote it, and what
 *  they said they were doing. */
export interface CommitRow {
  sha: string;
  subject: string;
  /** The author's email (or name, when git recorded no email). */
  author: string;
  author_name: string;
  date: string;
}

export interface AdoptResult {
  /** The experiment your previous work was saved as, or null when there was
   *  nothing to save. Never invented. */
  parked: { name: string; title: string } | null;
  adopted: 'main' | 'experiment' | 'commit';
  /** "fast-forward" (the source's own commits came across), "restore" (one
   *  commit on top of main carries its content), "already-main", or
   *  "unchanged" (your copy already held exactly this). */
  method: 'fast-forward' | 'restore' | 'already-main' | 'unchanged';
  bp: string;
  message: string;
  teardown_task_id: string | null;
  redeployed_bps: string[];
  deploy_task_ids: string[];
}

export interface RevertDevResult {
  status: string;
  method: 'restore' | 'already-main';
  bp: string;
  commit: string;
  subject: string | null;
  message: string;
  deploy_task_id: string | null;
}

export interface DeployOverMainPreview {
  bp: string;
  /** Main's tip as the dialog saw it — sent back on confirm so a main that
   *  moved in between is a 409 rather than a silent superseding of work the
   *  user was never shown. */
  main: string;
  blocked: boolean;
  superseded: CommitRow[];
  mine: CommitRow[];
}

export interface DeployOverMainResult {
  status: 'success' | 'needs_rebase';
  method: 'replay' | 'replay+reconcile' | 'fast-forward' | 'noop' | null;
  bp: string;
  message: string;
  superseded: CommitRow[];
  replayed: CommitRow[];
  deploy_task_id: string | null;
}

export interface CopyHistory {
  copy: HistoryCommit[];
  main: HistoryCommit[];
}

/** Gitops `GET /copies/{name}/incoming?bp=` — what pulling main into ONE
 *  business process brings in, measured from the merge base (so the copy's own
 *  work, which a pull replays on top, is not reported as arriving). */
export interface Incoming {
  bp: string;
  /** Newest first. Capped — see `commits_truncated`. */
  commits: HistoryCommit[];
  /** Every file the pull changes. Complete regardless of the commit cap: it is
   *  one diff, not a walk. */
  files: ChangedFile[];
  /** The commit list hit its cap; the file list did not. */
  commits_truncated: boolean;
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
  status: string; // "deployed" | "rolled-back" | "firewall" | "backup" | "secret"
  source: string; // "deploy" | "dev" | "staging" | "rollback" | "firewall" | "backup" | "secret"
  members: Record<string, BpHistoryMember>;
  /** Auditors who signed off the image this deploy promoted (production promotes
   *  only) — {who, at, note}. Empty for unaudited deploys. Drives the "audited
   *  by" badge on the history row. */
  audit?: { who: string; at: string; note?: string | null }[];
  /** Present on secret-change events: the realm + a one-line summary. The value
   *  itself is never sent — only that it changed (this is a rollback point). */
  secret?: {
    realm: string;
    summary: string;
  };
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

/** One freeze/unfreeze/policy governance event in the staging gate's history
 *  (persisted in bitswan.yaml under staging_gate[bp].log). `event` discriminates
 *  the kind and `detail` is the human-readable summary. */
export interface StagingLogEntry {
  id: string;
  at: string;
  who: string;
  // eslint-disable-next-line no-restricted-syntax -- null = role unknown
  role: string | null;
  event: 'freeze' | 'unfreeze' | 'policy';
  detail: string;
  required?: number;
  previous?: number;
}

/** One audit sign-off on an image, from the stage-independent `audits` store
 *  (keyed by image content hash). Append-only; only each auditor's latest
 *  verdict counts. */
export interface StagingSignoff {
  id: string;
  who: string;
  // eslint-disable-next-line no-restricted-syntax -- null = role unknown
  role: string | null;
  kind: string; // 'human' (extensible)
  verdict: 'approve' | 'reject';
  at: string;
  // eslint-disable-next-line no-restricted-syntax -- null = no note left
  note?: string | null;
}

/** Gitops `GET .../business-processes/{bp}/staging-gate` — a BP's staging freeze
 *  + production-promotion audit state. `log` is the full audit trail (newest
 *  first); `signoffs` are the audit events on the frozen image; `promotable` is
 *  the derived gate used to enable staging→production. */
export interface StagingGate {
  bp: string;
  frozen: boolean;
  // eslint-disable-next-line no-restricted-syntax -- null when not frozen
  frozen_by: string | null;
  // eslint-disable-next-line no-restricted-syntax -- null when not frozen
  frozen_at: string | null;
  // eslint-disable-next-line no-restricted-syntax -- null when not frozen
  frozen_sha: string | null;
  // eslint-disable-next-line no-restricted-syntax -- null when nothing on staging
  current_sha: string | null;
  stale: boolean;
  required: number;
  /** Freeze/unfreeze/policy governance history (newest-first). */
  log: StagingLogEntry[];
  /** Sign-offs on the staging image (newest-first). */
  signoffs: StagingSignoff[];
  approvals: number;
  rejections: number;
  audits_met: boolean;
  promotable: boolean;
}

/** One stage's secret values: {KEY: value}. */
export type StageSecrets = Record<string, string>;

/** A BP's decrypted secrets, keyed by realm (dev / staging / production; dev
 *  covers live-dev). Secret NAMES are shared across stages; VALUES are per
 *  stage, so this is the full per-stage map. */
export type BpSecrets = Record<string, StageSecrets>;

/** Inspect → Secrets snapshot: a BP stage's decrypted secrets as they were at a
 *  bitswan.yaml revision. `values` is empty for production unless the caller is
 *  admin/auditor (redacted server-side). */
export interface BpSecretsSnapshot {
  bp: string;
  commit: string;
  stage: string;
  realm: string;
  values: StageSecrets;
}

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
  /** When `status` is unavailable: WHICH part of the scan broke —
   *  `db-missing` (the daemon-owned grype vuln DB isn't on this host yet),
   *  `db-unreadable` (it is here, but this workspace may not read it),
   *  `scanner-missing` (no grype in this gitops image), `sbom-failed` (syft, on
   *  the infra-driver, couldn't read the image) or `scan-failed` (grype ran and
   *  failed). Absent on older gitops builds. */
  // eslint-disable-next-line no-restricted-syntax -- mirrors the gitops wire shape
  code?: string | null;
  /** The underlying error (grype/syft stderr, the driver's message), shown
   *  verbatim so an operator has something to act on. */
  // eslint-disable-next-line no-restricted-syntax -- mirrors the gitops wire shape
  reason?: string | null;
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
export type ServiceType = 'postgres' | 'garage' | 'couchdb';

/** Status of one infra service at a stage (subset we use — gitops returns more
 *  when show_passwords=true). `connection_info.admin_ui` is the admin console. */
export interface ServiceStatus {
  service: string;
  enabled: boolean;
  running: boolean;
  // eslint-disable-next-line no-restricted-syntax -- nullable upstream field
  connection_info?: { admin_ui?: string | null } | null;
}

// ---------------------------------------------------------------------------
// Read-only data explorer (Object Storage / SQL panels)
// ---------------------------------------------------------------------------

/** What one explorer instance looks at: a BP at a stage, optionally narrowed
 *  to a live-dev copy sandbox (copy implies stage 'dev'). Callers map the DR
 *  stage to 'production' (DR mirrors production's data). */
export interface DataScope {
  bp: string;
  stage: 'dev' | 'staging' | 'production';
  copy?: string;
}

export interface DataOverview {
  bp: string;
  stage: string;
  copy: string;
  registered: boolean;
  postgres: { enabled: boolean; running: boolean; database?: string };
  garage: { enabled: boolean; running: boolean; bucket?: string };
  // eslint-disable-next-line no-restricted-syntax -- null = not blue-green
  db?: number | null;
}

export interface SqlTable {
  name: string;
  kind: 'table' | 'view' | 'matview';
  /** Planner estimate; -1 = never analyzed (render as unknown). */
  row_estimate: number;
  total_bytes: number;
}

export interface SqlColumn {
  name: string;
  type: string;
  nullable: boolean;
  position: number;
}

/** One page of rows. Cells arrive text-cast and server-truncated (2 KiB). */
export interface SqlRowsPage {
  table: string;
  columns: SqlColumn[];
  rows: Record<string, string | null>[];
  limit: number;
  offset: number;
  has_more: boolean;
  row_estimate: number;
}

export interface ObjectEntry {
  key: string;
  type: 'file' | 'folder';
  // eslint-disable-next-line no-restricted-syntax -- folders have no size
  size?: number | null;
  // eslint-disable-next-line no-restricted-syntax -- nullable upstream field
  last_modified?: string | null;
}

export interface ObjectListing {
  bucket: string;
  prefix: string;
  entries: ObjectEntry[];
}

export interface ObjectPreview {
  key: string;
  size: number;
  content_type: string;
  /** true = too large for inline preview; offer download instead. */
  truncated: boolean;
  content_base64?: string;
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

/** Gitops `GET /copies/{name}/merge-preview` — what merging an experiment back
 *  would carry into its PARENT copy (not into main). Experiments only. */
export interface MergePreview {
  parent: string;
  /** Commits on the experiment the parent's branch lacks. */
  ahead: number;
  /** Commits on the parent's branch the experiment lacks. */
  behind: number;
  /** Working-tree edits the merge commits before merging (`<bp>/<path>`). */
  uncommitted: string[];
  /** Business processes born in the experiment; the merge publishes these. */
  new_bps: string[];
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

/** Body of `POST /api/experiments`. The experiment's parent (the caller's own
 *  copy) and its slug are derived server-side from the verified identity — the
 *  user only names the thing they're trying out, and the business process they
 *  are trying it out on. */
export interface CreateExperimentRequest {
  title: string;
  /** The business process the experiment is FOR (its directory name, not the
   *  display name). Required: it is the only one cloned into the experiment —
   *  everything else materializes from the parent copy on first open — so an
   *  omitted `bp` would produce an empty experiment. The server rejects it. */
  bp: string;
}

/** Wire-mirror of the gitops DELETE /processes/{slug} responses: 202 carries
 *  task_id; a 409 guard carries body.detail with the blocking deployments
 *  (relayed verbatim through the proxy's `body` field). */
export interface DeleteBusinessProcessResponse {
  task_id?: string;
  bp?: string;
  error?: string;
  body?: {
    detail?: {
      error?: string;
      deployments?: { deployment_id: string; stage: string }[];
    };
  };
}

export interface DeleteCopyResponse {
  task_id?: string;
  copy?: string;
  error?: string;
  body?: { detail?: string };
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

/** `GET /api/audits/{bp}/copy` — this auditor's audit as it stands. */
export interface AuditState {
  frozen: boolean;
  bp: string;
  report_path: string;
  reason?: string;
  name?: string;
  exists?: boolean;
  audited_sha?: string;
  audited_commit?: string;
  report_exists?: boolean;
  /** Files the auditor has changed in their copy: a proposal, not a sign-off. */
  proposed_changes?: string[];
}

/** `POST /api/audits/{bp}/copy` — the copy the auditor works in. */
export interface OpenedAudit {
  name: string;
  created: boolean;
  bp: string;
  audited_sha: string;
  audited_commit: string;
  report_path: string;
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

  /** Restore a business process from a downloaded deployment bundle (the
   *  source-only tar.gz from Deployments → Inspect → Download bundle). `name`
   *  optionally overrides the bundle's display name; the restored BP gets
   *  fresh process/deployment ids and its deploy is kicked off server-side
   *  (same response shape as createBusinessProcess). */
  createBusinessProcessFromBundle: (body: { file: File; name?: string; copy?: string }) => {
    const form = new FormData();
    form.set('file', body.file, body.file.name);
    if (body.name) form.set('name', body.name);
    if (body.copy) form.set('copy', body.copy);
    return postMultipart<CreateBusinessProcessResponse>(
      '/api/business-processes/from-bundle',
      form,
    );
  },

  renameBusinessProcess: (slug: string, body: RenameBusinessProcessRequest) =>
    patchJson<RenameBusinessProcessResponse>(
      `/api/business-processes/${encodeURIComponent(slug)}`,
      body,
    ),

  // Guarded async teardown: 202 {task_id} on accept; 409 carries the guard
  // payload (body.detail.deployments = blocking staging/production deploys)
  // — surfaced, not thrown, so the dialog can render it.
  deleteBusinessProcess: (slug: string) =>
    deleteAllow4xx<DeleteBusinessProcessResponse>(
      `/api/business-processes/${encodeURIComponent(slug)}`,
    ),

  createCopy: (body: CreateCopyRequest) =>
    postJson<CreateCopyResponse>('/api/copies', body),
  /** Start an experiment off your own copy: a child copy carrying explicit
   *  `kind: 'experiment'` metadata, its parent, and the title shown for it
   *  everywhere. Only `body.bp` is cloned into it (the rest of the copy's
   *  business processes materialize lazily via `ensureBp` on first open), which
   *  is what keeps the create fast. Same response as createCopy (including the
   *  auto live-dev deploy task) plus the generated slug in `name`. */
  createExperiment: (body: CreateExperimentRequest) =>
    postJson<CreateCopyResponse>('/api/experiments', body),
  // Whole-copy delete. Experiments only ("Discard experiment"): gitops
  // refuses to delete main, user copies and metadata-less legacy copies, and
  // rejects anyone but the owner. Behind a warn+confirm dialog that lists the
  // unmerged/uncommitted work the discard would destroy.
  // 202 {task_id}; the `copies` SSE snapshot dropping the copy signals done.
  deleteCopy: (name: string) =>
    deleteAllow4xx<DeleteCopyResponse>(`/api/copies/${encodeURIComponent(name)}`),

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
  /** Rehydrate + LRU-touch a copy's live-dev instance when its BP is opened.
   *  Idempotent: a running instance is only marked recently-used (kept hot); an
   *  evicted one is restarted. Fire-and-forget from the UI. */
  wakeLiveDev: (bp: string, copy: string | null) =>
    postJson<{ context: string | null; deployment_ids: string[] }>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/wake-live-dev`,
      { copy: copy ?? undefined },
    ),
  /** Manually sleep (mark inactive + remove containers) or wake (re-activate +
   *  redeploy) a BP stage. Sleep frees memory now; an on-demand stage also wakes
   *  on URL access. */
  stagePower: (action: 'sleep' | 'wake', bp: string, stage: string, copy: string | null) =>
    postJson<{ context: string; slept?: string[]; deployment_ids?: string[] }>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/${action}`,
      { stage, copy: copy ?? undefined },
    ),
  promoteBusinessProcess: (body: PromoteBPRequest) =>
    postJson<DeployBPResponse>('/api/automations/promote-bp', body),
  /** Every workspace user who can audit (admin or auditor role) — so the Audits
   *  panel can tell a member who to ask to review a production promotion. */
  workspaceAuditors: () =>
    getJson<{ users: { email: string; role: string }[] }>(
      '/api/automations/workspace-auditors',
    ),
  /** A BP's staging freeze + production-promotion audit gate state. */
  stagingGate: (bp: string) =>
    getJson<StagingGate>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/staging-gate`,
    ),
  /** Freeze / unfreeze staging (admin/auditor only — gated server-side). Freezing
   *  locks the staging image for audit and closes dev→staging. */
  setStagingFreeze: (bp: string, frozen: boolean) =>
    putJson<StagingGate>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/staging-gate/freeze`,
      { frozen },
    ),
  /** Set how many auditor sign-offs a frozen staging image needs before it can be
   *  promoted to Production (admin/auditor only; 0 = gating off). */
  setAuditPolicy: (bp: string, required: number) =>
    putJson<StagingGate>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/staging-gate/policy`,
      { required },
    ),
  /** Record one audit sign-off (approve / request changes) on the frozen staging
   *  image (admin/auditor only; appended to the audit log in bitswan.yaml). */
  recordAudit: (bp: string, verdict: 'approve' | 'reject', note?: string) =>
    postJson<StagingGate>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/staging-gate/audits`,
      { verdict, ...(note ? { note } : {}) },
    ),
  /** Per-stage deployment history for a business process (newest-first). */
  bpHistory: (bp: string, stage: string) =>
    getJson<BpHistory>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/history?stage=${encodeURIComponent(stage)}`,
    ),
  /** Roll a BP stage back to a prior state. `kind=deploy` (default) re-points the
   *  member deployments; `kind=firewall` restores the egress allow-list to that
   *  commit (production needs admin/auditor — gated server-side). */
  bpRollback: (
    bp: string,
    stage: string,
    gitCommit: string,
    kind: 'deploy' | 'firewall' = 'deploy',
  ) =>
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
  /** Inspect → Secrets snapshot: a BP stage's decrypted secrets at a commit.
   *  Production values are redacted server-side unless the caller is
   *  admin/auditor (the BFF supplies the verified identity, same as bpSecrets). */
  bpSecretsSnapshot: (bp: string, commit: string, stage: string) =>
    getJson<BpSecretsSnapshot>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/secrets-snapshot?commit=${encodeURIComponent(commit)}&stage=${encodeURIComponent(stage)}`,
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
    body: { note?: string; snapshot?: string },
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
  /** Supply chain: SBOM packages + CVEs + waiver log for a stage's image(s).
   *  `force` is the panel's Retry — discard a cached failure and rescan NOW,
   *  instead of waiting out the cooldown that paces automatic refetches. */
  supplyChain: (bp: string, stage: string, force = false) =>
    getJson<SupplyChainReport>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/supply-chain?stage=${encodeURIComponent(stage)}${force ? '&force=true' : ''}`,
    ),
  /** Supply chain: CVEs for the image a deploy of this BP would build from the
   *  current copy's source (Deploy → Supply Chain Security). Builds + scans on
   *  demand; `force` as above. */
  supplyChainPreview: (bp: string, copy: string | null, force = false) => {
    const q = new URLSearchParams();
    if (copy) q.set('copy', copy);
    if (force) q.set('force', 'true');
    return getJson<SupplyChainReport>(
      `/api/automations/business-processes/${encodeURIComponent(bp)}/supply-chain/preview${q.size ? `?${q}` : ''}`,
    );
  },
  /** Supply chain: mark a CVE out of scope. Stored in the copy's source tree
   *  (cve-waivers.yaml, committed) — authored from the Supply Chain Security tab, so it carries
   *  to main with the code. Returns the refreshed Supply Chain Security preview. */
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
  removeAutomation: (id: string, opts?: { removeSource?: boolean }) =>
    deleteEmpty(
      `/api/automations/${encodeURIComponent(id)}${opts?.removeSource ? '?remove_source=true' : ''}`,
    ),

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

  /**
   * An audit happens in a copy of the version under audit. `state` reads where
   * this auditor's audit stands (creating nothing); `open` gives them the copy,
   * or returns the one they already have. gitops decides who may audit and
   * which version is under audit.
   */
  audits: {
    state: (bp: string) => getJson<AuditState>(`/api/audits/${encodeURIComponent(bp)}/copy`),
    open: (bp: string) =>
      postJson<OpenedAudit>(`/api/audits/${encodeURIComponent(bp)}/copy`, {}),
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
    /**
     * What pulling main into ONE business process would bring in: the arriving
     * commits AND the files they change. The Sync screen leads with the files —
     * a list of commit subjects alone answers "how many" but not "what", which
     * is the only question that screen exists for.
     */
    incoming: (name: string, bp: string) =>
      getJson<Incoming>(
        `/api/copies/${encodeURIComponent(name)}/incoming?bp=${encodeURIComponent(bp)}`,
      ),
    /** The diff of what that pull brings in — whole, or for the one file whose
     *  row was clicked (`<bp>/rest`, as `incoming` reports it). */
    incomingDiff: (name: string, bp: string, path?: string) =>
      getJson<{ diff: string; truncated: boolean }>(
        `/api/copies/${encodeURIComponent(name)}/incoming/diff?bp=${encodeURIComponent(bp)}` +
          (path ? `&path=${encodeURIComponent(path)}` : ''),
      ),
    /** Commit divergence from main split into this BP vs every other BP, so the
     *  per-BP Deploy screen reflects the BP being viewed. */
    divergence: (name: string, bp: string) =>
      getJson<BpDivergence>(
        `/api/copies/${encodeURIComponent(name)}/divergence?bp=${encodeURIComponent(bp)}`,
      ),
    /**
     * How many commits on main this copy lacks — `behind` in total, `bps`
     * broken down per business process (only the ones actually behind).
     * Cheap on the gitops side (ref comparison in the bare repos, no fetch),
     * and the ONLY source for "is there anything to pull": the `copies` SSE
     * snapshot carries no counts at all any more.
     */
    behind: (name: string) =>
      getJson<{ behind: number; bps: Record<string, number> }>(
        `/api/copies/${encodeURIComponent(name)}/behind`,
      ),
    /** Per-BP ahead/behind for the whole copy in one call (only diverging BPs
     *  are present). Lets the switcher show ↑/↓ on each BP at a glance. */
    divergenceAll: (name: string) =>
      getJson<Record<string, { ahead: number; behind: number }>>(
        `/api/copies/${encodeURIComponent(name)}/divergence-all`,
      ),
    /** Make a BP exist in a copy, cloning it fresh from main if the copy lacks
     *  it (idempotent). Lets the switcher offer EVERY copy for a BP — selecting
     *  a copy that doesn't carry the BP materializes it here. */
    ensureBp: (name: string, bp: string) =>
      postJson<{ ok: boolean; already: boolean; copy: string; bp: string }>(
        `/api/copies/${encodeURIComponent(name)}/bp/${encodeURIComponent(bp)}/ensure`,
        {},
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
    /**
     * Pull main into ONE business process of a copy (rebase that clone onto
     * its own main). Scoped for the same reason Deploy is: each business
     * process is its own repository, so "behind main" is a fact about a
     * process, not about a copy — and a pull must move only what the user was
     * shown and agreed to.
     */
    rebase: (name: string, bp: string) =>
      postJson<RebaseCopyResult>(
        `/api/copies/${encodeURIComponent(name)}/rebase`,
        { bp },
      ),
    /**
     * Merge an experiment back into the copy it branched off. Never touches
     * main and never deploys: it fast-forwards the parent's branch and
     * redeploys the parent's live-dev for the business processes whose image
     * changed. `needs_rebase` means the parent moved on and the experiment has
     * to be rebased onto it first (coding-agent handoff); `noop` means the
     * experiment has nothing the parent lacks.
     */
    mergeToParent: (name: string) =>
      postJson<RebaseCopyResult>(
        `/api/copies/${encodeURIComponent(name)}/merge-to-parent`,
        {},
      ),
    /**
     * What `mergeToParent` would actually carry into the parent copy, read
     * live. Measured against the PARENT's branch — `status()` measures against
     * MAIN, and an experiment inherits its parent's whole divergence from
     * main, so it reports changes even for an experiment whose work is already
     * merged. Everything empty means the merge would be a no-op.
     */
    mergePreview: (name: string) =>
      getJson<MergePreview>(
        `/api/copies/${encodeURIComponent(name)}/merge-preview`,
      ),
    /** Copy-branch + main commit logs with deploy tags, scoped to one
     *  business process's repo. */
    history: (name: string, bp: string) =>
      getJson<CopyHistory>(
        `/api/copies/${encodeURIComponent(name)}/history?bp=${encodeURIComponent(bp)}`,
      ),
    /**
     * TAKE A VERSION WHOLESALE into your copy, for ONE business process,
     * instead of merging it — from an experiment (which is then consumed by
     * becoming your copy), from main, or from a version this workspace
     * DEPLOYED (the hotpatch: "edit this version").
     *
     * Whatever your copy had that nothing else does is PARKED as a new
     * experiment first, so nothing here can lose work; `parked` is null when
     * there was genuinely nothing to save. Your copy always ends up on top of
     * main, so the next Deploy is a plain fast-forward.
     */
    adopt: (
      name: string,
      body: {
        bp: string;
        source: 'main' | 'experiment' | 'commit';
        experiment?: string;
        commit?: string;
        /** The business process's display name, for the parked experiment's
         *  title — gitops stores slugs and cannot invent this. */
        bpLabel: string;
      },
    ) => postJson<AdoptResult>(`/api/copies/${encodeURIComponent(name)}/adopt`, body),
    /**
     * Put the DEV stage back to a version it ran before. Dev deploys from
     * main, so this adds ONE commit on top of main and redeploys dev — which
     * means everybody else's copy goes one behind on this business process and
     * carries the revert on their next Sync. Dev only.
     */
    revertDev: (bp: string, body: { commit: string; bpLabel: string }) =>
      postJson<RevertDevResult>(
        `/api/copies/main/bp/${encodeURIComponent(bp)}/revert-dev`,
        body,
      ),
    /** Whose work publishing over main would supersede — main's commits this
     *  copy does not have, with their authors. */
    deployOverMainPreview: (name: string, bp: string) =>
      getJson<DeployOverMainPreview>(
        `/api/copies/${encodeURIComponent(name)}/deploy-over-main-preview?bp=${encodeURIComponent(bp)}`,
      ),
    /** Publish this copy's version over a main that moved on. */
    deployOverMain: (
      name: string,
      body: {
        bp: string;
        expectedMain?: string;
        /** The business process's display name, for the messages and the
         *  commit subject — gitops only knows the directory slug. */
        bpLabel: string;
      },
    ) =>
      postJson<DeployOverMainResult>(
        `/api/copies/${encodeURIComponent(name)}/deploy-over-main`,
        body,
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
    /**
     * Run the deterministic tests in the BP's live-dev container. Omit `id`
     * to run every non-proposed requirement. The server returns the updated
     * requirement list (the CLI writes pass/fail into the TOML) plus the run
     * output so the caller can show detail/errors.
     */
    runTests: (bpId: string, copy: string, id?: string) =>
      postJson<RunTestsResponse>(
        `/api/business-processes/${encodeURIComponent(bpId)}/requirements/run-tests?copy=${encodeURIComponent(copy)}`,
        id ? { id } : {},
      ),
  },

  /** Git task queue. The live feed comes over the `/api/events` SSE stream;
   *  this is the initial snapshot fetch on mount. */
  tasks: () => getJson<{ tasks: GitTask[] }>('/api/tasks'),

  /** Read-only data explorer (Object Storage / SQL panels). List endpoints
   *  return null on 404 = "this BP has no database/bucket at this scope". */
  data: {
    overview: (scope: DataScope) =>
      getJsonOr404<DataOverview>(dataUrl(scope, '')),
    sqlTables: (scope: DataScope) =>
      getJsonOr404<{ database: string; tables: SqlTable[] }>(
        dataUrl(scope, '/sql/tables'),
      ),
    sqlRows: (
      scope: DataScope,
      table: string,
      opts: { limit: number; offset: number; sort?: string; order?: 'asc' | 'desc' },
    ) =>
      getJsonOr404<SqlRowsPage>(
        dataUrl(scope, '/sql/rows', {
          table,
          limit: String(opts.limit),
          offset: String(opts.offset),
          ...(opts.sort ? { sort: opts.sort, order: opts.order ?? 'asc' } : {}),
        }),
      ),
    objects: (scope: DataScope, prefix: string) =>
      getJsonOr404<ObjectListing>(
        dataUrl(scope, '/objects', prefix ? { prefix } : {}),
      ),
    objectPreview: (scope: DataScope, key: string) =>
      getJsonOr404<ObjectPreview>(dataUrl(scope, '/objects/preview', { key })),
    /** Direct <a href> download URL (cookie-authed, like bpBundleUrl). */
    objectDownloadUrl: (scope: DataScope, key: string) =>
      dataUrl(scope, '/objects/download', { key }),
  },
};

/** Build a `/api/data-explorer/{bp}/{stage}{sub}?copy=…&…` URL. */
function dataUrl(
  scope: DataScope,
  sub: string,
  params: Record<string, string> = {},
): string {
  const qs = new URLSearchParams();
  if (scope.copy) qs.set('copy', scope.copy);
  for (const [k, v] of Object.entries(params)) qs.set(k, v);
  const q = qs.toString();
  return `/api/data-explorer/${encodeURIComponent(scope.bp)}/${encodeURIComponent(scope.stage)}${sub}${q ? `?${q}` : ''}`;
}

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

/**
 * How a file changed, in GITOPS'S OWN vocabulary — this mirrors the wire, it
 * is not a display choice. It was declared here as `'A' | 'M' | 'D'` while
 * gitops has always sent the words (`_NAME_STATUS_KIND` in copies.py), so
 * every badge that indexed a style table by it got `undefined` and rendered
 * the bare word "modified" inside a 20px square. Compilers can't catch a lie
 * about a wire format; the single-letter badge is now derived, in
 * {@link changedKindLetter}.
 */
export type ChangedKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied';

/** The one-letter badge for a change kind (git's own `--name-status` letter). */
export function changedKindLetter(kind: ChangedKind): string {
  return kind.charAt(0).toUpperCase();
}

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
  /**
   * True when a test file in the BP mentions this requirement's underscore
   * token (REQ-003 → REQ_003) — the same convention the test runner matches
   * on. Absent on add/update responses (only list/run-tests annotate); the
   * hook preserves the previous value across those.
   */
  hasTest?: boolean;
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

export interface RunTestsResponse {
  /** True when the run itself completed (exit 0); individual pass/fail is in
   *  the per-requirement statuses + `output`. False means the run errored
   *  (e.g. no live-dev container, or an SSH-level failure). */
  ok: boolean;
  exitCode: number;
  /** Combined stdout+stderr from `bitswan-coding-agent requirements test`. */
  output: string;
  /** The requirement list after the CLI wrote its verdicts. */
  requirements: Requirement[];
}

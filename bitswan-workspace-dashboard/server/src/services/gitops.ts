import { setTimeout as delay } from 'node:timers/promises';
import { currentEmail } from '../lib/requestContext.js';

export interface UpstreamEvent {
  event: string;
  /** JSON-decoded payload, or the raw string if it wasn't valid JSON. */
  data: unknown;
}

/**
 * One entry of `docker inspect` output. The server passes these through to the
 * client which renders them; we don't introspect the shape here, so a loose
 * record type is sufficient.
 */
export type DockerInspect = Record<string, unknown>;

type Listener = (ev: UpstreamEvent) => void;

const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Long-lived client for the bitswan-gitops HTTP API. Holds one persistent SSE
 * subscription to `/events/stream` (with reconnect/backoff) and exposes
 * one-shot REST calls for the Fastify routes to proxy.
 */
// Event names whose latest payload is worth replaying to a freshly-connected
// SSE consumer. Anything not in this list is purely fire-and-forget.
const REPLAYABLE_EVENTS = new Set([
  'automations',
  'images',
  'processes',
  'copies',
  // The git task queue. gitops sends a `task_queue_snapshot` once per upstream
  // stream open, but the dashboard server keeps a single long-lived
  // subscription — so a browser connecting mid-stream would otherwise never see
  // it. Caching the latest snapshot lets `/api/events` replay it on connect.
  'task_queue_snapshot',
]);


export class GitopsClient {
  private readonly baseUrl: string;
  private readonly secret: string;
  private abort: AbortController | null = null;
  private stopped = false;
  // Most-recent payload per event name, for replay-on-connect to downstream
  // SSE consumers. The dashboard server's `/api/events` route iterates this
  // when a browser connects, so a fresh page load gets the same initial
  // snapshot gitops itself delivers on `/events/stream` connect — without
  // tying the dashboard's response to gitops's roundtrip.
  private readonly lastByEvent = new Map<string, unknown>();
  private readonly listeners = new Set<Listener>();

  constructor(baseUrl: string, secret: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.secret = secret;
  }

  /**
   * Outbound headers for every gitops call: the API bearer token plus, when a
   * user request is in flight, their gate-verified email as X-Forwarded-Email —
   * gitops reads it to attribute the git task-queue entry to that user.
   */
  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${this.secret}` };
    const email = currentEmail();
    if (email) h['X-Forwarded-Email'] = email;
    return h;
  }

  /**
   * Return the most-recent payload per upstream event name (currently
   * `automations`, `images`, `processes`). Used by the downstream SSE route
   * to replay the initial snapshot when a browser connects mid-stream.
   */
  getCachedEvents(): Iterable<[string, unknown]> {
    return this.lastByEvent.entries();
  }

  /**
   * Whether a copy with this name is present in the latest cached
   * `copies` snapshot. Lets `/api/me` skip a redundant create when the
   * user's copy already exists. Returns false when no snapshot has arrived yet
   * — the caller then attempts an idempotent create (gitops 409s if present).
   */
  hasCopy(name: string): boolean {
    const wts = this.lastByEvent.get('copies');
    return (
      Array.isArray(wts) &&
      wts.some(
        (w) =>
          !!w &&
          typeof w === 'object' &&
          (w as { name?: unknown }).name === name,
      )
    );
  }

  /**
   * `GET /automations/user-role?email=` — the authoritative Bailey role for an
   * email, resolved by gitops from the automation-server daemon (the same store
   * People & roles uses, NOT SSO groups). Pass an email already verified from
   * the user's access token. Returns 'member' when the daemon can't resolve a
   * role or the lookup fails — fail CLOSED (least privilege) for gating.
   */
  async userRole(email: string): Promise<'admin' | 'auditor' | 'member'> {
    try {
      const r = await fetch(
        `${this.baseUrl}/automations/user-role?email=${encodeURIComponent(email)}`,
        { headers: { ...this.authHeaders() } },
      );
      if (!r.ok) return 'member';
      const body = (await r.json()) as { role?: string };
      const role = body?.role;
      if (role === 'admin' || role === 'auditor') return role;
      return 'member';
    } catch {
      return 'member';
    }
  }

  /**
   * `POST /automations/{id}/(start|stop|restart)`. gitops accepts an empty
   * JSON body; the status code is forwarded so the route handler can surface
   * 502s on upstream failure.
   */
  async actionAutomation(
    deploymentId: string,
    action: 'start' | 'stop' | 'restart',
  ): Promise<{ ok: boolean; status: number }> {
    const r = await fetch(
      `${this.baseUrl}/automations/${encodeURIComponent(deploymentId)}/${action}`,
      {
        method: 'POST',
        headers: {
          ...this.authHeaders(),
          'Content-Type': 'application/json',
        },
        body: '{}',
      },
    );
    return { ok: r.ok, status: r.status };
  }

  /**
   * `POST /processes/` — create a new business-process directory in the
   * main repo or a specific copy. Gitops scaffolds `process.toml` +
   * `README.md`, refreshes its in-memory cache, and broadcasts the new
   * `processes` snapshot over SSE so the dashboard sidebar updates
   * automatically.
   */
  async createProcess(input: {
    name: string;
    copy?: string;
  }): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(`${this.baseUrl}/processes/`, {
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // upstream may return non-JSON on error
    }
    return { ok: r.ok, status: r.status, body };
  }

  /**
   * `GET /templates/` — workspace-aware template gallery. Built-in templates
   * come from `/workspace/examples` (bind-mounted into gitops), with optional
   * overrides at `<workspace_repo>/templates/`.
   */
  async getTemplates(): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(`${this.baseUrl}/templates/`, {
      headers: { ...this.authHeaders() },
    });
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // upstream may return non-JSON on error
    }
    return { ok: r.ok, status: r.status, body };
  }

  /**
   * `POST /automations/from-template` — scaffold a new automation (or every
   * automation in a group) under a BP directory. Gitops handles the copy,
   * UUID injection into `automation.toml`, and the git commit.
   */
  async createAutomationFromTemplate(input: {
    template_id?: string;
    group_id?: string;
    name?: string;
    bp: string;
    copy?: string;
  }): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(`${this.baseUrl}/automations/from-template`, {
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // upstream may return non-JSON on error
    }
    return { ok: r.ok, status: r.status, body };
  }

  /**
   * `POST /automations/frontend` — scaffold a frontend (the only kind, always
   * exposed through Bailey) into a business process from the baked template.
   */
  async addFrontend(input: {
    bp: string;
    name: string;
    copy?: string;
  }): Promise<{ ok: boolean; status: number; body: unknown }> {
    return this.postJson('/automations/frontend', input);
  }

  /**
   * `POST /automations/worker` — scaffold a private worker container of the
   * given `type` (e.g. "go", "fastapi") into a business process.
   */
  async addWorker(input: {
    bp: string;
    name: string;
    type: string;
    copy?: string;
  }): Promise<{ ok: boolean; status: number; body: unknown }> {
    return this.postJson('/automations/worker', input);
  }

  /**
   * `POST /automations/rename` — rename a frontend or worker within a BP.
   */
  async renameAutomation(input: {
    bp: string;
    old_name: string;
    new_name: string;
    copy?: string;
  }): Promise<{ ok: boolean; status: number; body: unknown }> {
    return this.postJson('/automations/rename', input);
  }

  /** Shared POST-JSON helper for the simple scaffolding endpoints above. */
  private async postJson(
    path: string,
    input: unknown,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // upstream may return non-JSON on error
    }
    return { ok: r.ok, status: r.status, body };
  }

  /**
   * `GET /copies/{name}/status` — per-file change list for a copy
   * (path + A/M/D kind + +adds/-dels). Drives the dashboard's Diff +
   * Files tabs.
   */
  async copyStatus(
    name: string,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(
      `${this.baseUrl}/copies/${encodeURIComponent(name)}/status`,
      { headers: { ...this.authHeaders() } },
    );
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // ignore
    }
    return { ok: r.ok, status: r.status, body };
  }

  /**
   * `GET /copies/{name}/diff[?path=<rel>]` — unified diff of the
   * copy's working tree vs. its own HEAD. Optional path filter
   * narrows the diff to one file. Drives the dashboard's Diff tab.
   */
  async copyDiff(
    name: string,
    path?: string,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const qs = path ? `?path=${encodeURIComponent(path)}` : '';
    const r = await fetch(
      `${this.baseUrl}/copies/${encodeURIComponent(name)}/diff${qs}`,
      { headers: { ...this.authHeaders() } },
    );
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // ignore
    }
    return { ok: r.ok, status: r.status, body };
  }

  /**
   * `GET /copies/{name}/commit/{sha}/diff` — unified diff introduced by a
   * single commit (`git show`). Drives the clickable rows in the Sync &
   * Deploy History view; resolves commits on either side of the graph.
   */
  async copyCommitDiff(
    name: string,
    sha: string,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(
      `${this.baseUrl}/copies/${encodeURIComponent(name)}/commit/${encodeURIComponent(sha)}/diff`,
      { headers: { ...this.authHeaders() } },
    );
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // ignore
    }
    return { ok: r.ok, status: r.status, body };
  }

  /**
   * `POST /copies/create` — create a new git clone under the
   * workspace's `copies/` directory and check out a branch into it.
   * The new copy is picked up by gitops's filesystem watcher and
   * surfaces in the `copies` SSE event without a follow-up REST call.
   */
  async createCopy(input: {
    branch_name: string;
    base_branch?: string;
  }): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(`${this.baseUrl}/copies/create`, {
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // upstream may return non-JSON on error
    }
    return { ok: r.ok, status: r.status, body };
  }

  /**
   * `POST /copies/{name}/sync` — commit WIP and, when the copy is a pure
   * fast-forward of main, fast-forward main to it server-side. Returns
   * `needs_rebase` in the body when a rebase is required instead.
   */
  async syncCopy(
    name: string,
    deployer?: string,
    bp?: string,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    return this.postJson(`/copies/${encodeURIComponent(name)}/sync`, {
      deployer: deployer ?? null,
      bp: bp ?? null,
    });
  }

  /** `POST /copies/{name}/rebase` — pull main's new commits INTO the copy
   *  (rebase the whole copy onto main). Opposite direction from syncCopy. */
  async rebaseCopy(
    name: string,
    deployer?: string,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    return this.postJson(`/copies/${encodeURIComponent(name)}/rebase`, {
      deployer: deployer ?? null,
    });
  }

  /** `GET /copies/{name}/history` — copy + main commit logs with deploy tags. */
  async copyHistory(
    name: string,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(
      `${this.baseUrl}/copies/${encodeURIComponent(name)}/history`,
      { headers: { ...this.authHeaders() } },
    );
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // upstream may return non-JSON on error
    }
    return { ok: r.ok, status: r.status, body };
  }

  /** `GET /copies/{name}/divergence-all` — per-BP ahead/behind for the whole
   *  copy in one fetch (only diverging BPs are returned). */
  async copyDivergenceAll(
    name: string,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(
      `${this.baseUrl}/copies/${encodeURIComponent(name)}/divergence-all`,
      { headers: { ...this.authHeaders() } },
    );
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // upstream may return non-JSON on error
    }
    return { ok: r.ok, status: r.status, body };
  }

  async copyDivergence(
    name: string,
    bp: string,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(
      `${this.baseUrl}/copies/${encodeURIComponent(name)}/divergence?bp=${encodeURIComponent(bp)}`,
      { headers: { ...this.authHeaders() } },
    );
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // upstream may return non-JSON on error
    }
    return { ok: r.ok, status: r.status, body };
  }

  /**
   * `POST /automations/start-deploy` — workspace-bind-mount deploy. Body is
   * `{ relative_path, stage, copy? }`. Gitops resolves the source under
   * `/workspace-repo`, merges `bitswan_lib`, computes the checksum, and
   * spawns the deploy in the background.
   */
  async startDeploy(input: {
    relative_path: string;
    stage: 'dev' | 'live-dev';
    copy?: string;
  }): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(`${this.baseUrl}/automations/start-deploy`, {
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // upstream may return non-JSON on error
    }
    return { ok: r.ok, status: r.status, body };
  }

  /**
   * `POST /automations/deploy-bp` — deploy every automation under one business
   * process as a single unit. Body is `{ bp, stage, copy? }`. Gitops
   * enumerates the BP's members, reserves them atomically, and runs one
   * batched deploy in the background under a single BP-level deploy task.
   */
  async deployBusinessProcess(input: {
    bp: string;
    stage: 'dev' | 'live-dev';
    copy?: string;
    deployed_by?: string;
  }): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(`${this.baseUrl}/automations/deploy-bp`, {
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // upstream may return non-JSON on error
    }
    return { ok: r.ok, status: r.status, body };
  }

  /**
   * `POST /automations/promote-bp` — promote every automation under one
   * business process from the previous stage to `stage` as a single unit
   * (dev→staging or staging→production). Re-deploys recorded checksums; no
   * builds. Returns 202 with a single BP-level deploy task.
   */
  async promoteBusinessProcess(input: {
    bp: string;
    stage: 'staging' | 'production';
    deployed_by?: string;
  }): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(`${this.baseUrl}/automations/promote-bp`, {
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // upstream may return non-JSON on error
    }
    return { ok: r.ok, status: r.status, body };
  }

  /**
   * `GET /automations/deploy-status/{taskId}` — snapshot of a deploy task.
   * Poll fallback for clients that can't rely on the live `deploy_progress`
   * SSE event (it is fire-and-forget — not cached/replayed — so a dropped
   * stream loses the terminal event).
   */
  async getDeployStatus(
    taskId: string,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(
      `${this.baseUrl}/automations/deploy-status/${encodeURIComponent(taskId)}`,
      { headers: { ...this.authHeaders() } },
    );
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // upstream may return non-JSON on error
    }
    return { ok: r.ok, status: r.status, body };
  }

  async bpHistory(
    bp: string,
    stage: string,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(
      `${this.baseUrl}/automations/business-processes/${encodeURIComponent(bp)}/history?stage=${encodeURIComponent(stage)}`,
      { headers: { ...this.authHeaders() } },
    );
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // upstream may return non-JSON on error
    }
    return { ok: r.ok, status: r.status, body };
  }

  async bpDiff(
    bp: string,
    from: string,
    to: string,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(
      `${this.baseUrl}/automations/business-processes/${encodeURIComponent(bp)}/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      { headers: { ...this.authHeaders() } },
    );
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // upstream may return non-JSON on error
    }
    return { ok: r.ok, status: r.status, body };
  }

  async bpSecrets(
    bp: string,
    by?: string,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    // `by` is the gate-verified caller email; gitops resolves its role from the
    // daemon and redacts production secrets for non-admin/auditor callers.
    const q = by ? `?by=${encodeURIComponent(by)}` : '';
    const r = await fetch(
      `${this.baseUrl}/automations/business-processes/${encodeURIComponent(bp)}/secrets${q}`,
      { headers: { ...this.authHeaders() } },
    );
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // upstream may return non-JSON on error
    }
    return { ok: r.ok, status: r.status, body };
  }

  async bpSetSecrets(
    bp: string,
    values: Record<string, Record<string, string>>,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(
      `${this.baseUrl}/automations/business-processes/${encodeURIComponent(bp)}/secrets`,
      {
        method: 'PUT',
        headers: {
          ...this.authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ values }),
      },
    );
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // ignore
    }
    return { ok: r.ok, status: r.status, body };
  }

  /** `GET .../business-processes/{bp}/dr` — a BP's disaster-recovery status
   *  (cadence policy, manual recovery-test log, overdue flag). */
  async dr(bp: string): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(
      `${this.baseUrl}/automations/business-processes/${encodeURIComponent(bp)}/dr`,
      { headers: { ...this.authHeaders() } },
    );
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // upstream may return non-JSON on error
    }
    return { ok: r.ok, status: r.status, body };
  }

  /** `GET .../business-processes/{bp}/backups` — blue-green slot state (live vs
   *  standby/DR), retention policy, and the recent audit log. */
  async backups(bp: string): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(
      `${this.baseUrl}/automations/business-processes/${encodeURIComponent(bp)}/backups`,
      { headers: { ...this.authHeaders() } },
    );
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // ignore
    }
    return { ok: r.ok, status: r.status, body };
  }

  /** Backup writes: `path` is "/retention" (PUT) or "/swap" (POST). gitops
   *  versions + audits the change in bitswan.yaml. */
  async backupWrite(
    bp: string,
    path: string,
    method: 'PUT' | 'POST',
    payload: Record<string, unknown>,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(
      `${this.baseUrl}/automations/business-processes/${encodeURIComponent(bp)}/backups${path}`,
      {
        method,
        headers: {
          ...this.authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    );
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // ignore
    }
    return { ok: r.ok, status: r.status, body };
  }

  /** `GET .../business-processes/{bp}/firewall?stage=` — allow-list + attempts. */
  async firewall(
    bp: string,
    stage: string,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(
      `${this.baseUrl}/automations/business-processes/${encodeURIComponent(bp)}/firewall?stage=${encodeURIComponent(stage)}`,
      { headers: { ...this.authHeaders() } },
    );
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // ignore
    }
    return { ok: r.ok, status: r.status, body };
  }

  /** Firewall rule set/delete/promote. `path` selects /rules or /promote;
   *  `method` is PUT/DELETE/POST. gitops versions the change + enforces prod RBAC
   *  from the `role` in the payload. */
  async firewallWrite(
    bp: string,
    path: string,
    method: 'PUT' | 'DELETE' | 'POST',
    payload: Record<string, unknown>,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(
      `${this.baseUrl}/automations/business-processes/${encodeURIComponent(bp)}/firewall${path}`,
      {
        method,
        headers: {
          ...this.authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    );
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // ignore
    }
    return { ok: r.ok, status: r.status, body };
  }

  /** Upload a host's GDPR data-processing-agreement PDF (stored + versioned in
   *  the gitops repo). Forwards as multipart to gitops. */
  async firewallDpaUpload(
    bp: string,
    input: {
      stage: string;
      host: string;
      by?: string;
      role?: string;
      filename: string;
      content: Buffer;
      contentType?: string;
    },
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const form = new FormData();
    form.set('stage', input.stage);
    form.set('host', input.host);
    if (input.by) form.set('by', input.by);
    if (input.role) form.set('role', input.role);
    const blob = new Blob([new Uint8Array(input.content)], {
      type: input.contentType || 'application/pdf',
    });
    form.set('file', blob, input.filename);
    const r = await fetch(
      `${this.baseUrl}/automations/business-processes/${encodeURIComponent(bp)}/firewall/dpa`,
      { method: 'POST', headers: { ...this.authHeaders() }, body: form },
    );
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // ignore
    }
    return { ok: r.ok, status: r.status, body };
  }

  /** Download a host's stored DPA PDF (raw bytes for the dashboard to stream). */
  async firewallDpaDownload(
    bp: string,
    host: string,
  ): Promise<{ ok: boolean; status: number; body: Buffer; contentType: string }> {
    const r = await fetch(
      `${this.baseUrl}/automations/business-processes/${encodeURIComponent(bp)}/firewall/dpa?host=${encodeURIComponent(host)}`,
      { headers: { ...this.authHeaders() } },
    );
    const buf = Buffer.from(await r.arrayBuffer());
    return {
      ok: r.ok,
      status: r.status,
      body: buf,
      contentType: r.headers.get('content-type') || 'application/pdf',
    };
  }

  /** `GET .../business-processes/{bp}/supply-chain?stage=` — SBOM + CVEs + waivers. */
  async supplyChain(
    bp: string,
    stage: string,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(
      `${this.baseUrl}/automations/business-processes/${encodeURIComponent(bp)}/supply-chain?stage=${encodeURIComponent(stage)}`,
      { headers: { ...this.authHeaders() } },
    );
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // upstream may return non-JSON on error
    }
    return { ok: r.ok, status: r.status, body };
  }

  /** `GET .../supply-chain/preview?copy=` — SBOM + CVEs for the image a deploy
   *  of this BP WOULD build from the current source (Checks tab). */
  async supplyChainPreview(
    bp: string,
    copy: string | null,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const q = copy ? `?copy=${encodeURIComponent(copy)}` : '';
    const r = await fetch(
      `${this.baseUrl}/automations/business-processes/${encodeURIComponent(bp)}/supply-chain/preview${q}`,
      { headers: { ...this.authHeaders() } },
    );
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // upstream may return non-JSON on error
    }
    return { ok: r.ok, status: r.status, body };
  }

  /** Mark a CVE out of scope (POST) or restore it (DELETE) — body carries
   *  {stage, package, cve, comment?, by?}; gitops versions it in bitswan.yaml. */
  async supplyChainWaiver(
    bp: string,
    method: 'POST' | 'DELETE',
    payload: {
      copy: string | null;
      package: string;
      cve: string;
      comment?: string;
      by?: string;
    },
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(
      `${this.baseUrl}/automations/business-processes/${encodeURIComponent(bp)}/supply-chain/waivers`,
      {
        method,
        headers: {
          ...this.authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    );
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // ignore
    }
    return { ok: r.ok, status: r.status, body };
  }

  /** `PUT .../business-processes/{bp}/dr/policy` — set the recovery-test cadence. */
  async setDrPolicy(
    bp: string,
    policy: string,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(
      `${this.baseUrl}/automations/business-processes/${encodeURIComponent(bp)}/dr/policy`,
      {
        method: 'PUT',
        headers: {
          ...this.authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ policy }),
      },
    );
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // ignore
    }
    return { ok: r.ok, status: r.status, body };
  }

  /** `POST .../business-processes/{bp}/dr/tests` — record a hand-performed
   *  recovery test (prepended; the log stays newest-first). */
  async recordDrTest(
    bp: string,
    payload: { by?: string; note?: string; snapshot?: string },
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(
      `${this.baseUrl}/automations/business-processes/${encodeURIComponent(bp)}/dr/tests`,
      {
        method: 'POST',
        headers: {
          ...this.authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    );
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // ignore
    }
    return { ok: r.ok, status: r.status, body };
  }

  /** `GET /snapshots/{bp}` — the BP's snapshot list (+ eligibility/usage/tasks).
   *  Exposed for the DR panel's "tested against" snapshot picker. */
  async bpSnapshots(
    bp: string,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(
      `${this.baseUrl}/snapshots/${encodeURIComponent(bp)}`,
      { headers: { ...this.authHeaders() } },
    );
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // upstream may return non-JSON on error
    }
    return { ok: r.ok, status: r.status, body };
  }

  /** Infra-service status for a stage (Containers tab "Stage services" row).
   *  gitops only includes `connection_info.admin_ui` when show_passwords=true,
   *  so we request it but then strip everything except the admin URL — the DB
   *  credentials must never reach the browser. */
  async serviceStatus(
    type: string,
    stage: string,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(
      `${this.baseUrl}/services/${encodeURIComponent(type)}/status?stage=${encodeURIComponent(stage)}&show_passwords=true`,
      { headers: { ...this.authHeaders() } },
    );
    let raw: unknown = null;
    try {
      raw = await r.json();
    } catch {
      // upstream may return non-JSON on error
    }
    let body: unknown = raw;
    if (r.ok && raw && typeof raw === 'object') {
      const s = raw as {
        service?: unknown;
        enabled?: unknown;
        running?: unknown;
        connection_info?: { admin_ui?: unknown } | null;
      };
      // Sanitize: only the non-secret fields the Containers tab needs.
      body = {
        service: s.service,
        enabled: s.enabled,
        running: s.running,
        connection_info: { admin_ui: s.connection_info?.admin_ui ?? null },
      };
    }
    return { ok: r.ok, status: r.status, body };
  }

  async bpScale(
    bp: string,
    stage: string,
    replicas: number,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(
      `${this.baseUrl}/automations/business-processes/${encodeURIComponent(bp)}/scale`,
      {
        method: 'POST',
        headers: {
          ...this.authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ stage, replicas }),
      },
    );
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // ignore
    }
    return { ok: r.ok, status: r.status, body };
  }

  async bpFileTree(
    bp: string,
    commit: string,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(
      `${this.baseUrl}/automations/business-processes/${encodeURIComponent(bp)}/files?commit=${encodeURIComponent(commit)}`,
      { headers: { ...this.authHeaders() } },
    );
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // ignore
    }
    return { ok: r.ok, status: r.status, body };
  }

  async bpFileContent(
    bp: string,
    commit: string,
    path: string,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(
      `${this.baseUrl}/automations/business-processes/${encodeURIComponent(bp)}/file-content?commit=${encodeURIComponent(commit)}&path=${encodeURIComponent(path)}`,
      { headers: { ...this.authHeaders() } },
    );
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // ignore
    }
    return { ok: r.ok, status: r.status, body };
  }

  /** Returns the raw upstream Response so the route can stream the (large)
   *  bundle body straight through with its Content-Disposition. */
  async bpBundle(bp: string, stage: string, commit: string): Promise<Response> {
    return fetch(
      `${this.baseUrl}/automations/business-processes/${encodeURIComponent(bp)}/bundle?stage=${encodeURIComponent(stage)}&commit=${encodeURIComponent(commit)}`,
      { headers: { ...this.authHeaders() } },
    );
  }

  async bpRollback(input: {
    bp: string;
    stage: string;
    git_commit: string;
    deployed_by?: string;
    kind?: 'deploy' | 'firewall';
    role?: string;
  }): Promise<{ ok: boolean; status: number; body: unknown }> {
    const { bp, ...rest } = input;
    const r = await fetch(
      `${this.baseUrl}/automations/business-processes/${encodeURIComponent(bp)}/rollback`,
      {
        method: 'POST',
        headers: {
          ...this.authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(rest),
      },
    );
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // upstream may return non-JSON on error
    }
    return { ok: r.ok, status: r.status, body };
  }

  /**
   * `POST /automations/{id}/deploy` — re-deploy at a given checksum into the
   * specified stage. Used for promotions from a deployed source stage to the
   * next one; gitops resolves the source from `automation_name`+`context`+
   * `stage` and skips the upload step because the assets already live under
   * the existing checksum.
   */
  async promoteDeploy(
    deploymentId: string,
    input: {
      checksum: string;
      stage: 'staging' | 'production';
      automation_name: string;
      context?: string;
      relative_path?: string;
      deployed_by?: string;
    },
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const form = new URLSearchParams();
    form.append('checksum', input.checksum);
    form.append('stage', input.stage);
    form.append('automation_name', input.automation_name);
    if (input.context) form.append('context', input.context);
    // Without `relative_path`, gitops writes a bitswan.yaml entry with no
    // path field — which then trips the dashboard's per-BP filter (we
    // group by `relative_path.startsWith(bp.name)`), and the promoted
    // stage never appears as deployed in the UI.
    if (input.relative_path) form.append('relative_path', input.relative_path);
    if (input.deployed_by) form.append('deployed_by', input.deployed_by);
    const r = await fetch(
      `${this.baseUrl}/automations/${encodeURIComponent(deploymentId)}/deploy`,
      {
        method: 'POST',
        headers: {
          ...this.authHeaders(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      },
    );
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // upstream may return non-JSON on error
    }
    return { ok: r.ok, status: r.status, body };
  }

  /**
   * `DELETE /automations/{id}` — stop the container, remove the entry from
   * `bitswan.yaml`, commit. Returns the upstream status code so the route
   * handler can surface 502/4xx as appropriate.
   */
  async removeAutomation(
    deploymentId: string,
  ): Promise<{ ok: boolean; status: number }> {
    const r = await fetch(
      `${this.baseUrl}/automations/${encodeURIComponent(deploymentId)}`,
      {
        method: 'DELETE',
        headers: { ...this.authHeaders() },
      },
    );
    return { ok: r.ok, status: r.status };
  }

  /**
   * `GET /automations/{id}/inspect` — array of Docker inspect dicts, one per
   * replica.
   */
  async inspectAutomation(deploymentId: string): Promise<DockerInspect[]> {
    const r = await fetch(
      `${this.baseUrl}/automations/${encodeURIComponent(deploymentId)}/inspect`,
      { headers: { ...this.authHeaders() } },
    );
    if (!r.ok) {
      throw new Error(`gitops inspect returned ${r.status}`);
    }
    const data = await r.json();
    return Array.isArray(data) ? (data as DockerInspect[]) : [];
  }

  /**
   * Returns the upstream SSE body so the caller (Fastify route) can pipe it
   * through. The `signal` lets callers cancel when the downstream client
   * disconnects.
   */
  async streamLogs(
    deploymentId: string,
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const r = await fetch(
      `${this.baseUrl}/automations/${encodeURIComponent(deploymentId)}/logs/stream`,
      {
        headers: {
          ...this.authHeaders(),
          Accept: 'text/event-stream',
        },
        signal,
      },
    );
    if (!r.ok || !r.body) {
      throw new Error(`gitops logs stream returned ${r.status}`);
    }
    return r.body;
  }

  /**
   * Stream an image's `docker build` log by checksum. Gitops serves this as a
   * `text/plain` follow-stream (live during a build, then the final
   * `.build.log`/`.failedbuild.log`, closing once a completed log is fully
   * read). The route re-frames the bytes as SSE for the browser.
   */
  async streamBuildLogs(
    checksum: string,
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const r = await fetch(
      `${this.baseUrl}/images/builds/${encodeURIComponent(checksum)}/stream`,
      {
        headers: {
          ...this.authHeaders(),
          Accept: 'text/plain',
        },
        signal,
      },
    );
    if (!r.ok || !r.body) {
      throw new Error(`gitops build-log stream returned ${r.status}`);
    }
    return r.body;
  }

  // ---------------------------------------------------------------------
  // Per-BP stage snapshots (`/snapshots/*`). Create/restore/clone return
  // 202 + task_id; progress is polled via `snapshotTaskStatus` (the
  // `snapshot_progress` SSE event is fire-and-forget, same as deploys).
  // ---------------------------------------------------------------------

  /** Shared fetch shape for the snapshot endpoints. */
  private async requestJson(
    method: string,
    path: string,
    bodyObj?: unknown,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...this.authHeaders(),
        ...(bodyObj !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(bodyObj !== undefined ? { body: JSON.stringify(bodyObj) } : {}),
    });
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // upstream may return non-JSON on error
    }
    return { ok: r.ok, status: r.status, body };
  }

  /** `GET /snapshots/{bp}` — snapshots + eligibility + disk usage + active tasks. */
  listSnapshots(bp: string) {
    return this.requestJson('GET', `/snapshots/${encodeURIComponent(bp)}`);
  }

  /** `GET /snapshots/{bp}/eligibility` — registry flags + live availability. */
  snapshotEligibility(bp: string) {
    return this.requestJson(
      'GET',
      `/snapshots/${encodeURIComponent(bp)}/eligibility`,
    );
  }

  /** `POST /snapshots/{bp}/provision` — opt a BP into per-BP databases at one stage. */
  provisionBp(bp: string, input: { stage: string; bp_name?: string }) {
    return this.requestJson(
      'POST',
      `/snapshots/${encodeURIComponent(bp)}/provision`,
      input,
    );
  }

  /** `POST /snapshots/{bp}/{stage}` — start a background snapshot (202 + task_id). */
  createSnapshot(bp: string, stage: string, input: { label?: string; by?: string }) {
    return this.requestJson(
      'POST',
      `/snapshots/${encodeURIComponent(bp)}/${encodeURIComponent(stage)}`,
      input,
    );
  }

  /** `POST /snapshots/{bp}/restore` — restore a snapshot into a target stage. */
  restoreSnapshot(
    bp: string,
    input: {
      snapshot_id: string;
      source_stage: string;
      target_stage: string;
      by?: string;
    },
  ) {
    return this.requestJson(
      'POST',
      `/snapshots/${encodeURIComponent(bp)}/restore`,
      input,
    );
  }

  /** `POST /snapshots/{bp}/clone` — one-click stage→stage data clone. */
  cloneStage(bp: string, input: { source_stage: string; target_stage: string }) {
    return this.requestJson(
      'POST',
      `/snapshots/${encodeURIComponent(bp)}/clone`,
      input,
    );
  }

  /** `DELETE /snapshots/{bp}/{stage}/{snapshotId}` — delete one snapshot. */
  deleteSnapshot(bp: string, stage: string, snapshotId: string) {
    return this.requestJson(
      'DELETE',
      `/snapshots/${encodeURIComponent(bp)}/${encodeURIComponent(stage)}/${encodeURIComponent(snapshotId)}`,
    );
  }

  /** `GET /snapshots/tasks/{taskId}` — snapshot-task poll endpoint. */
  snapshotTaskStatus(taskId: string) {
    return this.requestJson(
      'GET',
      `/snapshots/tasks/${encodeURIComponent(taskId)}`,
    );
  }

  // ---------------------------------------------------------------------
  // Git task queue (`/tasks`). The live feed flows over SSE
  // (`task_queue_snapshot` on connect, `task_queue` per change); these REST
  // calls back the initial fetch and the admin "clear queue" action.
  // ---------------------------------------------------------------------

  /** `GET /tasks` — the full git task queue (newest first). */
  listTasks() {
    return this.requestJson('GET', '/tasks');
  }

  /**
   * `POST /tasks/clear?by=<email>` — cancel all queued/running git tasks.
   * gitops enforces admin-only via the daemon role store and 403s non-admins;
   * `by` is the validated requester email, recorded for the audit trail.
   */
  clearTasks(by: string) {
    return this.requestJson('POST', `/tasks/clear?by=${encodeURIComponent(by)}`);
  }

  /** Subscribe to upstream events. Returns an unsubscribe function. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Begin the SSE subscription. Idempotent. */
  async start(): Promise<void> {
    if (this.abort) return;
    this.stopped = false;
    void this.runStreamLoop();
  }

  /** Stop the SSE subscription and cancel any in-flight reconnect wait. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.abort?.abort();
    this.abort = null;
  }

  private async runStreamLoop(): Promise<void> {
    let backoff = RECONNECT_INITIAL_MS;
    while (!this.stopped) {
      this.abort = new AbortController();
      try {
        await this.consumeStream(this.abort.signal);
        // Stream closed cleanly — small pause before reconnect.
        backoff = RECONNECT_INITIAL_MS;
      } catch (err) {
        if (this.stopped) return;
        console.warn('[gitops] SSE stream error, reconnecting', err);
      }
      if (this.stopped) return;
      await delay(backoff);
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    }
  }

  private async consumeStream(signal: AbortSignal): Promise<void> {
    const r = await fetch(`${this.baseUrl}/events/stream`, {
      headers: {
        ...this.authHeaders(),
        Accept: 'text/event-stream',
      },
      signal,
    });
    if (!r.ok || !r.body) {
      throw new Error(`gitops /events/stream returned ${r.status}`);
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      // SSE events are separated by a blank line.
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const parsed = parseSseChunk(raw);
        if (parsed) this.handleEvent(parsed);
      }
    }
  }

  private handleEvent(ev: UpstreamEvent): void {
    if (REPLAYABLE_EVENTS.has(ev.event)) {
      this.lastByEvent.set(ev.event, ev.data);
    }
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch (err) {
        console.warn('[gitops] subscriber threw', err);
      }
    }
  }
}

function parseSseChunk(raw: string): UpstreamEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue; // comment / keepalive
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^\s/, ''));
    }
  }
  if (dataLines.length === 0) return null;
  const dataStr = dataLines.join('\n');
  let data: unknown = dataStr;
  try {
    data = JSON.parse(dataStr);
  } catch {
    // Not JSON; keep as string.
  }
  return { event, data };
}

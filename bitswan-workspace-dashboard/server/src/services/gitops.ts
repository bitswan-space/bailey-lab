import { setTimeout as delay } from 'node:timers/promises';

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
          Authorization: `Bearer ${this.secret}`,
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
        Authorization: `Bearer ${this.secret}`,
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
      headers: { Authorization: `Bearer ${this.secret}` },
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
        Authorization: `Bearer ${this.secret}`,
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
        Authorization: `Bearer ${this.secret}`,
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
      { headers: { Authorization: `Bearer ${this.secret}` } },
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
      { headers: { Authorization: `Bearer ${this.secret}` } },
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
      { headers: { Authorization: `Bearer ${this.secret}` } },
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
        Authorization: `Bearer ${this.secret}`,
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

  /** `GET /copies/{name}/history` — copy + main commit logs with deploy tags. */
  async copyHistory(
    name: string,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(
      `${this.baseUrl}/copies/${encodeURIComponent(name)}/history`,
      { headers: { Authorization: `Bearer ${this.secret}` } },
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
        Authorization: `Bearer ${this.secret}`,
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
  }): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(`${this.baseUrl}/automations/deploy-bp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secret}`,
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
  }): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(`${this.baseUrl}/automations/promote-bp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secret}`,
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
      { headers: { Authorization: `Bearer ${this.secret}` } },
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
      { headers: { Authorization: `Bearer ${this.secret}` } },
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
      { headers: { Authorization: `Bearer ${this.secret}` } },
    );
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // upstream may return non-JSON on error
    }
    return { ok: r.ok, status: r.status, body };
  }

  async bpRollback(input: {
    bp: string;
    stage: string;
    git_commit: string;
    deployed_by?: string;
  }): Promise<{ ok: boolean; status: number; body: unknown }> {
    const { bp, ...rest } = input;
    const r = await fetch(
      `${this.baseUrl}/automations/business-processes/${encodeURIComponent(bp)}/rollback`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.secret}`,
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
          Authorization: `Bearer ${this.secret}`,
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
        headers: { Authorization: `Bearer ${this.secret}` },
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
      { headers: { Authorization: `Bearer ${this.secret}` } },
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
          Authorization: `Bearer ${this.secret}`,
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
        Authorization: `Bearer ${this.secret}`,
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
  createSnapshot(bp: string, stage: string, input: { label?: string }) {
    return this.requestJson(
      'POST',
      `/snapshots/${encodeURIComponent(bp)}/${encodeURIComponent(stage)}`,
      input,
    );
  }

  /** `POST /snapshots/{bp}/restore` — restore a snapshot into a target stage. */
  restoreSnapshot(
    bp: string,
    input: { snapshot_id: string; source_stage: string; target_stage: string },
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
        Authorization: `Bearer ${this.secret}`,
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

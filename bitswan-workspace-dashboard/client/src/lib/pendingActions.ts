// Operator actions that are IN FLIGHT — a channel of its own, beside the
// container state every view already reads.
//
// bailey-lab #476: press Restart on a container and nothing outside the
// Activity pane says so. The row keeps its green dot, the stage card keeps
// saying Healthy, the pipeline badge keeps its tick. The dot is not the bug —
// docker's `restarting` means "this container died on its own and the policy is
// bringing it back", and #465 gave that its own colour precisely so it means
// that; an operator's `docker restart` never enters that state. What was missing
// is any representation of "an action I triggered is in flight", because the one
// channel the UI had — the last observed container state — cannot answer a
// question about intent. The question is not about the container.
//
// So this is a second reading, and the two rules that make it honest are:
//
//   * it STARTS on the operator's confirm, not when a request is dispatched or
//     when one returns. The HTTP call returns when gitops has ISSUED the
//     restart; the gap between that and the container being back is most of
//     what the operator waits through.
//   * it ENDS on an OBSERVATION of the container (or on the request failing, or
//     on a budget elapsing) — never on the promise resolving. Same doctrine as
//     App.tsx's copy-transition lock: "the lock lifts on a STATE condition, not
//     on a promise resolving".
//
// It never overwrites the observed state; every surface renders both, so
// "restarting this on purpose" and "this keeps dying" stay distinguishable.
//
// TWO CLOCKS, NAMED APART ON PURPOSE. `confirmedAt` is the BROWSER's clock and
// is used only for the budget and the "4s ago" hint. `baseline.startedAt` is the
// CONTAINER's clock and is only ever compared with another reading of that same
// field. Calling both of them `startedAt` is how the bug class this module
// exists to prevent gets back in.

import { useSyncExternalStore } from 'react';

import { formatRelative } from '@/lib/format-date';
import { toast } from '@/lib/notify';
import { displayFor, isUpStatus, type DisplayStatus } from '@/lib/status';
import type { DeployedAutomation } from '@/types';

/** The operator actions that are keyed by deployment id and take real time. */
export type PendingKind = 'restart' | 'stop' | 'start' | 'wake' | 'sleep';

/** What was true of the container at the moment the operator confirmed. */
export interface PendingBaseline {
  /**
   * The container's start time as last OBSERVED before the action (ISO-8601).
   * Absent means it was not read — not a zero — and it is only ever compared
   * against another reading of this same field.
   */
  startedAt?: string;
  /**
   * The container we acted on. Absent = there was none: a Restart that gitops
   * turns into a create, or a Start on a slept deployment.
   */
  containerId?: string;
  /** What the surfaces were showing when the button was pressed. */
  status: DisplayStatus;
}

export interface PendingAction {
  deploymentId: string;
  kind: PendingKind;
  /** The automation (or stage) name, for the one sentence every surface shows. */
  name: string;
  /** BROWSER clock, epoch ms: when the operator CONFIRMED. Budget + hint only. */
  confirmedAt: number;
  timeoutMs: number;
  baseline: PendingBaseline;
  /**
   * The automations-snapshot generation the baseline was read from. The settle
   * test needs a STRICTLY newer one, so the snapshot that produced the baseline
   * can never be mistaken for evidence about the action.
   */
  baselineSeq: number;
  /** The request was accepted. Reporting only — the entry does NOT end here. */
  issued: boolean;
  /** Members of one stage Wake/Sleep share this, so they read as one action. */
  groupId?: string;
}

export type PendingMap = ReadonlyMap<string, PendingAction>;

/**
 * How long an action may go unobserved before we stop waiting and say so. A
 * wait with no cap is a hung interface with a spinner over it — and against a
 * driver too old to report a container's start time this budget is the ONLY
 * thing between the operator and a spinner that never stops.
 */
export const PENDING_BUDGET_MS: Record<PendingKind, number> = {
  // docker's SIGKILL grace after SIGTERM is 10s; past this it is not a slow stop.
  stop: 30_000,
  // The restart itself plus the compose re-apply that restores the CA certs.
  restart: 90_000,
  // Removing a stage's containers.
  sleep: 60_000,
  // start_automation may run a whole deploy for a member that never came up.
  start: 180_000,
  // A stage Wake is a compose up of every member, images included.
  wake: 180_000,
};

/** What ended a pending action, or that nothing has yet. */
export type Settled =
  | { done: false }
  /** Seen through: the container was observed in the state the action promised. */
  | { done: true; how: 'observed' }
  /** Nobody here can witness this one — say so rather than keep waiting. */
  | { done: true; how: 'unwitnessable' };

const NOT_DONE: Settled = { done: false };
const OBSERVED: Settled = { done: true, how: 'observed' };
const UNWITNESSABLE: Settled = { done: true, how: 'unwitnessable' };

/** An ISO instant as epoch ms, or absent when there was nothing to read. */
// eslint-disable-next-line no-restricted-syntax -- undefined IS the answer: nothing was read
function instant(iso?: string): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Has this action been seen through?
 *
 * The one place the end conditions live. `observed` is the record for this
 * deployment in the snapshot that just arrived, `seq` that snapshot's
 * generation.
 *
 * An observation can only ever CONFIRM, never fail: a single `exited` reading
 * in the middle of a restart is the ~1-in-775 sample the issue measured, and
 * reading it as a failure would rebuild the false-alarm flash inside the layer
 * built to explain it. That is why {@link Settled} has no `failed` variant —
 * only the request rejecting or the budget elapsing can end an action badly.
 */
export function settle(
  p: PendingAction,
  // eslint-disable-next-line no-restricted-syntax -- undefined = no record for this deployment in the snapshot, which IS an observation
  observed: DeployedAutomation | undefined,
  seq: number,
): Settled {
  // The snapshot the baseline came from is not evidence about the action.
  if (seq <= p.baselineSeq) return NOT_DONE;

  const status = displayFor(observed);
  const up = isUpStatus(status);

  switch (p.kind) {
    case 'stop':
    case 'sleep':
      // What the action promised is that nothing is up. `stopped` is the usual
      // reading, `asleep` is the same container once gitops has marked the
      // deployment inactive and the container has been reaped, and a record
      // that left the snapshot entirely reads as `not-deployed` — none of them
      // is up, and there is nothing further to wait for in any of them.
      return up ? NOT_DONE : OBSERVED;

    case 'start':
    case 'wake':
      // It was down and now it is up. Needs no start time at all.
      return up ? OBSERVED : NOT_DONE;

    case 'restart': {
      if (!up) return NOT_DONE;
      // A Restart on a deployment with no container is a create (gitops falls
      // through to start_automation), so being up IS the whole observation.
      if (p.baseline.containerId === undefined) return OBSERVED;
      // A different container is a plain observation: the compose re-apply that
      // follows the restart can legitimately replace it.
      if (observed?.container_id && observed.container_id !== p.baseline.containerId) {
        return OBSERVED;
      }
      const before = instant(p.baseline.startedAt);
      const after = instant(observed?.started_at ?? undefined);
      // STRICTLY LATER, and never `!==`. The gitops overlay picks the
      // worst-state replica as the record's winner, so the winning container —
      // and with it the start time — can hop to an OLDER one with nothing
      // having restarted; `!==` would call that a finished restart. A real
      // restart always lands after the baseline. (Both values come from the
      // container's clock, so this comparison is skew-free; comparing either
      // against Date.now() would not be.)
      if (after !== undefined && (before === undefined || after > before)) return OBSERVED;
      // The same container, up, and no start time to compare — on EITHER side.
      // That is a workspace whose driver does not report the field (one built
      // before it), so there is nothing here that could ever witness this
      // restart: say so once instead of waiting out a budget we know will
      // expire. When the baseline HAD a start time and this reading does not,
      // the field is plainly available and the inspect just lost a race against
      // the restarting container — that one is worth waiting for.
      if (p.issued && before === undefined && after === undefined) return UNWITNESSABLE;
      return NOT_DONE;
    }
  }
}

// ── wording ────────────────────────────────────────────────────────────────
// Every string lives in a pure builder so the tests can read them without
// touching the store or the notification log.

const VERB_ING: Record<PendingKind, string> = {
  restart: 'Restarting',
  stop: 'Stopping',
  start: 'Starting',
  wake: 'Waking',
  sleep: 'Putting to sleep',
};

const VERB_PAST: Record<PendingKind, string> = {
  restart: 'restarted',
  stop: 'stopped',
  start: 'started',
  wake: 'woken',
  sleep: 'put to sleep',
};

/** The short label a row or chip shows beside the observed state. */
export function pendingLabel(p: PendingAction): string {
  return `${VERB_ING[p.kind]}…`;
}

/**
 * The full sentence, for the tooltip and for screen readers. First person and
 * naming the actor, so it cannot be read as a state the container is in: "this
 * keeps dying" and "I am restarting this on purpose" are different sentences.
 */
export function pendingSentence(p: PendingAction, now: number): string {
  const when = formatRelative(p.confirmedAt, { now });
  const tail = p.kind === 'stop' || p.kind === 'sleep' ? 'to go down' : 'to come back up';
  return `You ${VERB_PAST[p.kind]} ${p.name} ${when} — waiting for it ${tail}`;
}

/** The Activity line while the request is still on its way to gitops. */
function issuingMessage(p: PendingAction): string {
  return `${VERB_ING[p.kind]} ${p.name}…`;
}

/** The Activity line once gitops has accepted it and we are waiting to see it. */
function waitingMessage(p: PendingAction): string {
  const tail = p.kind === 'stop' || p.kind === 'sleep' ? 'go down' : 'come back';
  return `${VERB_ING[p.kind]} ${p.name} — issued, waiting for it to ${tail}`;
}

/** The Activity line when the container was actually seen through. */
function observedMessage(p: PendingAction): string {
  switch (p.kind) {
    case 'stop':
      return `${p.name} is stopped`;
    case 'sleep':
      return `${p.name} is asleep`;
    default:
      return `${p.name} is back up`;
  }
}

/**
 * The Activity line when there is no way to witness the action here. Said in
 * words rather than shown as a success, because "issued" is all we know — which
 * is exactly what the pre-#476 UI claimed, and the honest version of it.
 */
function unwitnessableMessage(p: PendingAction): string {
  return `${VERB_ING[p.kind]} ${p.name} — issued; this workspace cannot report when it came back`;
}

/** Said out loud when a budget elapses. Loud, and it does not claim it failed. */
export function pendingTimeoutMessage(p: PendingAction): {
  message: string;
  description: string;
} {
  return {
    message: `Gave up waiting: ${VERB_ING[p.kind].toLowerCase()} ${p.name}`,
    description:
      `It did not report ${p.kind === 'stop' || p.kind === 'sleep' ? 'going down' : 'coming back'} ` +
      `within ${Math.round(p.timeoutMs / 1000)}s. It may well have happened — nothing here ` +
      `cancelled it. Check the container's state and its logs.`,
  };
}

// ── the stage aggregate ────────────────────────────────────────────────────

export interface StagePending {
  count: number;
  /** The distinct kinds in flight, for the wording. */
  kinds: PendingKind[];
  /** The line the stage card and the node's title show; '' when count is 0. */
  label: string;
}

const NO_STAGE_PENDING: StagePending = { count: 0, kinds: [], label: '' };

/**
 * What the stage card and the pipeline node say about a stage whose members
 * have actions in flight. Pure, so the wording is testable.
 *
 * `kinds` narrows it: the power row must not lock its Wake button because some
 * unrelated member of the stage is being restarted.
 */
export function stagePending(
  ids: readonly string[],
  pending: PendingMap,
  opts?: { kinds?: readonly PendingKind[] },
): StagePending {
  const mine: PendingAction[] = [];
  for (const id of ids) {
    const p = pending.get(id);
    if (!p) continue;
    if (opts?.kinds && !opts.kinds.includes(p.kind)) continue;
    mine.push(p);
  }
  if (mine.length === 0) return NO_STAGE_PENDING;

  const kinds = [...new Set(mine.map((p) => p.kind))];
  const first = mine[0];
  // One stage Wake is ONE action, not one per member — the operator pressed one
  // button. Members of it share a groupId, so say it at stage level.
  const group = first?.groupId;
  if (group && mine.every((p) => p.groupId === group) && first) {
    return {
      count: mine.length,
      kinds,
      label: `${VERB_ING[first.kind]} ${first.name} — waiting for its containers`,
    };
  }
  if (kinds.length === 1 && first) {
    const n = mine.length;
    const tail = first.kind === 'stop' || first.kind === 'sleep' ? 'go down' : 'come back';
    return {
      count: n,
      kinds,
      label: `You ${VERB_PAST[first.kind]} ${n} service${n === 1 ? '' : 's'} — waiting for ${
        n === 1 ? 'it' : 'them'
      } to ${tail}`,
    };
  }
  return {
    count: mine.length,
    kinds,
    label: `${mine.length} actions of yours in flight on this stage`,
  };
}

// ── the store ──────────────────────────────────────────────────────────────
// Module-level, like lib/notify.ts: no context and no provider, so all three
// unrelated component trees can read it, and an action survives unmounting the
// pane it was started from (restart in Containers, switch to Deployments).

const EMPTY: PendingMap = new Map();

let items: PendingMap = EMPTY;
const listeners = new Set<() => void>();

/**
 * One entry per notify id, so a stage Wake reads as ONE Activity row that
 * unrolls rather than as one row per member.
 */
interface Group {
  name: string;
  kind: PendingKind;
  /** Members the action covered, for the "2 of 3 through" line. */
  total: number;
  /**
   * The action has already been reported as gone wrong (a rejected request, an
   * elapsed budget). A member that settles afterwards must not overwrite that
   * row with a success — the loud line is the one the operator needs.
   */
  spent: boolean;
}
const groups = new Map<string, Group>();

/** Generation of the automations snapshot; see PendingAction.baselineSeq. */
let seq = 0;
// eslint-disable-next-line no-restricted-syntax -- undefined = nothing observed yet
let lastObserved: readonly DeployedAutomation[] | undefined;
// eslint-disable-next-line no-restricted-syntax -- undefined = no budget armed
let timer: ReturnType<typeof setTimeout> | undefined;

function emit(): void {
  for (const l of listeners) l();
}

/** The Activity row this action belongs to — one per stage action, else one each. */
function notifyId(p: PendingAction): string {
  return p.groupId ? `pending:group:${p.groupId}` : `pending:${p.deploymentId}`;
}

function write(next: Map<string, PendingAction>): void {
  items = next.size === 0 ? EMPTY : next;
  // A group exists only while it has members waiting.
  for (const key of [...groups.keys()]) {
    let alive = false;
    for (const p of items.values()) {
      if (p.groupId === key) {
        alive = true;
        break;
      }
    }
    if (!alive) groups.delete(key);
  }
  arm();
  emit();
}

/** One timer, at the nearest deadline, rearmed on every change. */
function arm(): void {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  let soonest = Infinity;
  for (const p of items.values()) {
    soonest = Math.min(soonest, p.confirmedAt + p.timeoutMs);
  }
  if (!Number.isFinite(soonest)) return;
  timer = setTimeout(() => {
    timer = undefined;
    expire(Date.now());
  }, Math.max(0, soonest - Date.now()));
}

function expire(now: number): void {
  const next = new Map(items);
  let changed = false;
  for (const p of items.values()) {
    if (p.confirmedAt + p.timeoutMs > now) continue;
    next.delete(p.deploymentId);
    changed = true;
    const g = p.groupId ? groups.get(p.groupId) : undefined;
    if (!g?.spent) {
      const { message, description } = pendingTimeoutMessage(p);
      toast.error(message, { id: notifyId(p), description });
    }
    if (g) g.spent = true;
  }
  if (changed) write(next);
  else arm();
}

export interface BeginArgs {
  deploymentId: string;
  kind: PendingKind;
  name: string;
  baseline: PendingBaseline;
  /** Set on every member of one stage-level action, so they read as one. */
  groupId?: string;
  /** How many members the group has, so its Activity row can count them. */
  groupTotal?: number;
}

/**
 * Put the mark up NOW, on the confirm frame — before the request object exists.
 * A second action on the same deployment replaces the first: the later one
 * really is the one in flight, and it gets its own baseline.
 */
export function beginPending(args: BeginArgs): void {
  const p: PendingAction = {
    deploymentId: args.deploymentId,
    kind: args.kind,
    name: args.name,
    confirmedAt: Date.now(),
    timeoutMs: PENDING_BUDGET_MS[args.kind],
    baseline: args.baseline,
    baselineSeq: seq,
    issued: false,
    groupId: args.groupId,
  };
  const next = new Map(items);
  next.set(p.deploymentId, p);
  if (args.groupId) {
    const g = groups.get(args.groupId);
    if (g) g.total = Math.max(g.total, args.groupTotal ?? g.total);
    else
      groups.set(args.groupId, {
        name: args.name,
        kind: args.kind,
        total: args.groupTotal ?? 1,
        spent: false,
      });
  }
  toast.loading(issuingMessage(p), { id: notifyId(p) });
  write(next);
}

/** gitops accepted the request. The entry does NOT end here — that is the point. */
export function pendingIssued(deploymentId: string): void {
  const p = items.get(deploymentId);
  if (!p) return;
  const next = new Map(items);
  next.set(deploymentId, { ...p, issued: true });
  toast.loading(waitingMessage(p), { id: notifyId(p) });
  write(next);
}

/**
 * The request itself was rejected. This is one of the two endings an action can
 * have that an observation cannot give it. Written whether or not there is an
 * entry, so a 404 on a deployment that vanished still reaches Activity.
 */
export function pendingFailed(deploymentId: string, reason: string): void {
  const p = items.get(deploymentId);
  const id = p ? notifyId(p) : `pending:${deploymentId}`;
  const g = p?.groupId ? groups.get(p.groupId) : undefined;
  if (!g?.spent) {
    const what = p ? `Failed to ${p.kind} ${p.name}` : `Action on ${deploymentId} failed`;
    toast.error(what, { id, description: reason });
  }
  if (g) g.spent = true;
  if (!p) return;
  const next = new Map(items);
  next.delete(deploymentId);
  write(next);
}

/**
 * Forget an entry without a verdict — for a stage action where the server came
 * back saying it did not touch this member after all. Without it, that member
 * keeps a mark whose only possible ending is a false "gave up waiting".
 */
export function dropPending(deploymentId: string): void {
  const p = items.get(deploymentId);
  if (!p) return;
  const next = new Map(items);
  next.delete(deploymentId);
  const g = p.groupId ? groups.get(p.groupId) : undefined;
  if (g) g.total = Math.max(0, g.total - 1);
  write(next);
}

/** Close out one entry and tell Activity what was actually seen. */
function finish(next: Map<string, PendingAction>, p: PendingAction, how: Settled): void {
  next.delete(p.deploymentId);
  if (!how.done) return;
  const line = how.how === 'observed' ? observedMessage(p) : unwitnessableMessage(p);
  const g = p.groupId ? groups.get(p.groupId) : undefined;
  if (!g) {
    if (how.how === 'observed') toast.success(line, { id: notifyId(p) });
    else toast.info(line, { id: notifyId(p) });
    return;
  }
  if (g.spent) return; // already reported as gone wrong; do not overwrite that
  // The action is through when no member of it is left waiting — asked of the
  // map rather than of a counter, so a member dropped because the server never
  // touched it cannot leave the row hanging forever.
  const left = [...next.values()].filter((x) => x.groupId === p.groupId).length;
  if (left === 0) {
    toast.success(`${g.name} — ${VERB_PAST[g.kind]}`, { id: notifyId(p) });
    return;
  }
  toast.loading(
    `${VERB_ING[g.kind]} ${g.name} — ${g.total - left} of ${g.total} through`,
    { id: notifyId(p) },
  );
}

/**
 * THE RESOLVER. Called once per automations snapshot, from WorkspaceProvider —
 * the one place a snapshot arrives. The generation only advances when the array
 * identity is new, which makes this idempotent under StrictMode's
 * double-invoked effects and gives exactly one generation per SSE delivery.
 */
export function observePending(automations: readonly DeployedAutomation[]): void {
  if (automations === lastObserved) return;
  lastObserved = automations;
  seq += 1;
  if (items.size === 0) return;

  const byId = new Map<string, DeployedAutomation>();
  for (const a of automations) {
    if (a.deployment_id) byId.set(a.deployment_id, a);
  }
  const next = new Map(items);
  let changed = false;
  for (const p of items.values()) {
    const verdict = settle(p, byId.get(p.deploymentId), seq);
    if (!verdict.done) continue;
    finish(next, p, verdict);
    changed = true;
  }
  if (changed) write(next);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The actions in flight right now. The identity is stable between changes (and
 * one shared empty map when there are none), so a subscriber cannot be
 * re-rendered forever.
 */
export function pendingSnapshot(): PendingMap {
  return items;
}

/** The operator's actions currently in flight, keyed by deployment id. */
export function usePendingActions(): PendingMap {
  return useSyncExternalStore(subscribe, pendingSnapshot, pendingSnapshot);
}

/** Tests only: forget everything, so each case starts from an empty store. */
export function resetPendingActions(): void {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  items = EMPTY;
  groups.clear();
  seq = 0;
  lastObserved = undefined;
  emit();
}

/** Tests only: the snapshot generation, so a case can reason about baselineSeq. */
export function pendingSeq(): number {
  return seq;
}

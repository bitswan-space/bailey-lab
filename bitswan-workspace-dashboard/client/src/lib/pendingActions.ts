import { useSyncExternalStore } from 'react';

import { formatRelative } from '@/lib/format-date';
import { toast } from '@/lib/notify';
import { displayFor, isUpStatus, type DisplayStatus } from '@/lib/status';
import type { DeployedAutomation } from '@/types';

export type PendingKind = 'restart' | 'stop' | 'start' | 'wake' | 'sleep';

export interface PendingBaseline {
  startedAt?: string;
  containerId?: string;
  status: DisplayStatus;
}

export interface PendingAction {
  deploymentId: string;
  kind: PendingKind;
  name: string;
  confirmedAt: number;
  timeoutMs: number;
  baseline: PendingBaseline;
  baselineSeq: number;
  issued: boolean;
  groupId?: string;
}

export type PendingMap = ReadonlyMap<string, PendingAction>;

export const PENDING_BUDGET_MS: Record<PendingKind, number> = {
  stop: 30_000,
  restart: 90_000,
  sleep: 60_000,
  start: 180_000,
  wake: 180_000,
};

export type Settled =
  | { done: false }
  | { done: true; how: 'observed' }
  | { done: true; how: 'unwitnessable' };

const NOT_DONE: Settled = { done: false };
const OBSERVED: Settled = { done: true, how: 'observed' };
const UNWITNESSABLE: Settled = { done: true, how: 'unwitnessable' };

// eslint-disable-next-line no-restricted-syntax -- undefined IS the answer: nothing was read
function instant(iso?: string): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

export function settle(
  p: PendingAction,
  // eslint-disable-next-line no-restricted-syntax -- undefined = no record for this deployment in the snapshot, which IS an observation
  observed: DeployedAutomation | undefined,
  seq: number,
): Settled {
  if (seq <= p.baselineSeq) return NOT_DONE;

  const status = displayFor(observed);
  const up = isUpStatus(status);

  switch (p.kind) {
    case 'stop':
    case 'sleep':
      return up ? NOT_DONE : OBSERVED;

    case 'start':
    case 'wake':
      return up ? OBSERVED : NOT_DONE;

    case 'restart': {
      if (!up) return NOT_DONE;
      if (p.baseline.containerId === undefined) return OBSERVED;
      if (observed?.container_id && observed.container_id !== p.baseline.containerId) {
        return OBSERVED;
      }
      const before = instant(p.baseline.startedAt);
      const after = instant(observed?.started_at ?? undefined);
      if (after !== undefined && (before === undefined || after > before)) return OBSERVED;
      if (p.issued && before === undefined && after === undefined) return UNWITNESSABLE;
      return NOT_DONE;
    }
  }
}

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

export function pendingLabel(p: PendingAction): string {
  return `${VERB_ING[p.kind]}…`;
}

export function pendingSentence(p: PendingAction, now: number): string {
  const when = formatRelative(p.confirmedAt, { now });
  const tail = p.kind === 'stop' || p.kind === 'sleep' ? 'to go down' : 'to come back up';
  return `You ${VERB_PAST[p.kind]} ${p.name} ${when} — waiting for it ${tail}`;
}

function issuingMessage(p: PendingAction): string {
  return `${VERB_ING[p.kind]} ${p.name}…`;
}

function waitingMessage(p: PendingAction): string {
  const tail = p.kind === 'stop' || p.kind === 'sleep' ? 'go down' : 'come back';
  return `${VERB_ING[p.kind]} ${p.name} — issued, waiting for it to ${tail}`;
}

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

function unwitnessableMessage(p: PendingAction): string {
  return `${VERB_ING[p.kind]} ${p.name} — issued; this workspace cannot report when it came back`;
}

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

export interface StagePending {
  count: number;
  kinds: PendingKind[];
  label: string;
}

const NO_STAGE_PENDING: StagePending = { count: 0, kinds: [], label: '' };

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

const EMPTY: PendingMap = new Map();

let items: PendingMap = EMPTY;
const listeners = new Set<() => void>();

interface Group {
  name: string;
  kind: PendingKind;
  total: number;
  spent: boolean;
}
const groups = new Map<string, Group>();

let seq = 0;
// eslint-disable-next-line no-restricted-syntax -- undefined = nothing observed yet
let lastObserved: readonly DeployedAutomation[] | undefined;
// eslint-disable-next-line no-restricted-syntax -- undefined = no budget armed
let timer: ReturnType<typeof setTimeout> | undefined;

function emit(): void {
  for (const l of listeners) l();
}

function notifyId(p: PendingAction): string {
  return p.groupId ? `pending:group:${p.groupId}` : `pending:${p.deploymentId}`;
}

function write(next: Map<string, PendingAction>): void {
  items = next.size === 0 ? EMPTY : next;
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
  groupId?: string;
  groupTotal?: number;
}

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

export function pendingIssued(deploymentId: string): void {
  const p = items.get(deploymentId);
  if (!p) return;
  const next = new Map(items);
  next.set(deploymentId, { ...p, issued: true });
  toast.loading(waitingMessage(p), { id: notifyId(p) });
  write(next);
}

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

export function dropPending(deploymentId: string): void {
  const p = items.get(deploymentId);
  if (!p) return;
  const next = new Map(items);
  next.delete(deploymentId);
  const g = p.groupId ? groups.get(p.groupId) : undefined;
  if (g) g.total = Math.max(0, g.total - 1);
  write(next);
}

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
  if (g.spent) return;
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

export function pendingSnapshot(): PendingMap {
  return items;
}

export function usePendingActions(): PendingMap {
  return useSyncExternalStore(subscribe, pendingSnapshot, pendingSnapshot);
}

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

export function pendingSeq(): number {
  return seq;
}

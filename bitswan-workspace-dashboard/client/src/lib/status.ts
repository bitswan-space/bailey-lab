// Single source of truth for how an automation's runtime state maps to UI
// affordances: a dot color, a display label, a Badge variant, and a
// standalone-label text color. Previously these were duplicated across three
// records in different components.

import type { AutomationState, DeployedAutomation } from '@/types';

export type DisplayStatus =
  | 'running'
  | 'restarting'
  | 'stopped'
  | 'failed'
  | 'not-deployed'
  | 'asleep'
  | 'building'
  | 'deployed'
  | 'unknown';

export interface StatusMeta {
  /** Display string ("Running", "Stopped", …). */
  label: string;
  /** Tailwind bg class for the small status dot. */
  dot: string;
  /** Tailwind class string for `<Badge>` — background + foreground + border. */
  badge: string;
  /** Tailwind text-color class for use as a standalone label on white. */
  labelColor: string;
}

export const STATUS_META: Record<DisplayStatus, StatusMeta> = {
  running: {
    label: 'Running',
    dot: 'bg-emerald-500',
    badge: 'border-transparent bg-emerald-100 text-emerald-700',
    labelColor: 'text-emerald-600',
  },
  deployed: {
    label: 'Deployed',
    dot: 'bg-emerald-500',
    badge: 'border-transparent bg-emerald-100 text-emerald-700',
    labelColor: 'text-emerald-600',
  },
  restarting: {
    label: 'Restarting',
    dot: 'bg-violet-500',
    badge: 'border-transparent bg-violet-100 text-violet-700',
    labelColor: 'text-violet-600',
  },
  building: {
    label: 'Building',
    dot: 'bg-blue-500',
    badge: 'border-transparent bg-blue-100 text-blue-700',
    labelColor: 'text-blue-600',
  },
  stopped: {
    label: 'Stopped',
    dot: 'bg-red-500',
    badge: 'border-transparent bg-red-100 text-red-700',
    labelColor: 'text-red-600',
  },
  failed: {
    label: 'Failed',
    dot: 'bg-red-500',
    badge: 'border-transparent bg-red-100 text-red-700',
    labelColor: 'text-red-600',
  },
  // Deliberately not running: the on-demand memory sweep evicted it, or an
  // operator put it to sleep. It has a deployment record and no container, and
  // gitops marks it `active: false` — so it is neither a failure nor an absence
  // of information, and must not be shown as either.
  asleep: {
    label: 'Asleep',
    dot: 'bg-sky-500',
    badge: 'border-transparent bg-sky-100 text-sky-700',
    labelColor: 'text-sky-600',
  },
  'not-deployed': {
    label: 'Not deployed',
    dot: 'bg-zinc-300',
    badge: 'border-transparent bg-zinc-100 text-zinc-600',
    labelColor: 'text-muted-foreground',
  },
  unknown: {
    label: '—',
    dot: 'bg-zinc-300',
    badge: 'border-transparent bg-zinc-100 text-zinc-600',
    labelColor: 'text-muted-foreground',
  },
};

/** Map an automation's raw Docker container state to a display status. */
export function stateToDisplay(state: AutomationState | null | undefined): DisplayStatus {
  switch (state) {
    case 'running':
    case 'starting':
    case 'created':
      return 'running';
    case 'restarting':
      return 'restarting';
    case 'exited':
    case 'dead':
    case 'paused':
      return 'stopped';
    default:
      return 'unknown';
  }
}

/**
 * True when a container carrying this status is meant to be up right now.
 *
 * `restarting` belongs here — a crashlooping container is not asleep, it is
 * trying — which is exactly why "up" and "healthy" are two different
 * questions, and why nothing may answer the second one with this.
 */
export function isUpStatus(status: DisplayStatus): boolean {
  return (
    status === 'running' ||
    status === 'restarting' ||
    status === 'building' ||
    status === 'deployed'
  );
}

/**
 * How alarming each status is. Ordering exists for one reason: when several
 * records collapse onto one row (replicas, the blue/green slots of a
 * production member), the row must show the WORST state observed, never the
 * best. Preferring the best is what let a business process whose production
 * slots were both restarting report itself as running (bailey-lab #463).
 *
 * `unknown` and `not-deployed` sit at the bottom because they are the absence
 * of an observation: they must never outrank something actually seen.
 */
const STATUS_SEVERITY: Record<DisplayStatus, number> = {
  failed: 7,
  stopped: 6,
  restarting: 5,
  // Asleep outranks a healthy reading — a row that merges a sleeping container
  // with a running one is not simply "running" — but never outranks a fault.
  asleep: 4,
  building: 3,
  running: 2,
  deployed: 2,
  unknown: 1,
  'not-deployed': 0,
};

/** The least healthy of the given statuses — see STATUS_SEVERITY. */
export function worstStatus(...statuses: DisplayStatus[]): DisplayStatus {
  return statuses.reduce(
    (worst, s) => (STATUS_SEVERITY[s] > STATUS_SEVERITY[worst] ? s : worst),
    'not-deployed',
  );
}

/**
 * What one automation record says its container is doing — the single reading
 * every view should use, because there are three different "not running"s and
 * they are not interchangeable:
 *
 *   - no deployment at all            → 'not-deployed'
 *   - deployed but SLEPT              → 'asleep'   (gitops sets active: false
 *     and sends no container state; reading only the state made this 'unknown',
 *     i.e. no observation, which summaries then counted as fine)
 *   - deployed and running/failed/…   → whatever Docker says
 */
export function displayFor(a?: DeployedAutomation): DisplayStatus {
  if (!a?.deployment_id) return 'not-deployed';
  if (a.active === false) return 'asleep';
  return stateToDisplay(a.state);
}

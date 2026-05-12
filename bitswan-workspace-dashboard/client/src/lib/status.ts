// Single source of truth for how an automation's runtime state maps to UI
// affordances: a dot color, a display label, a Badge variant, and a
// standalone-label text color. Previously these were duplicated across three
// records in different components.

import type { AutomationState } from '@/types';

export type DisplayStatus =
  | 'running'
  | 'restarting'
  | 'stopped'
  | 'failed'
  | 'not-deployed'
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

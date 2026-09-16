
import { isUpStatus, type DisplayStatus } from '@/lib/status';

export type StageHealthKind =
  | 'not-deployed'
  | 'unknown'
  | 'asleep'
  | 'partly-asleep'
  | 'failing'
  | 'restarting'
  | 'healthy';

export interface StageHealth {
  kind: StageHealthKind;
  label: string;
  color: string;
  dot: string;
  ring: string;
}

const HEALTH: Record<StageHealthKind, StageHealth> = {
  'not-deployed': {
    kind: 'not-deployed',
    label: 'Not deployed yet',
    color: 'text-muted-foreground',
    dot: 'bg-zinc-400',
    ring: 'ring-zinc-400/10',
  },
  unknown: {
    kind: 'unknown',
    label: 'Deployed',
    color: 'text-muted-foreground',
    dot: 'bg-zinc-400',
    ring: 'ring-zinc-400/10',
  },
  asleep: {
    kind: 'asleep',
    label: 'Asleep',
    color: 'text-sky-600',
    dot: 'bg-sky-500',
    ring: 'ring-sky-500/10',
  },
  'partly-asleep': {
    kind: 'partly-asleep',
    label: '',
    color: 'text-sky-600',
    dot: 'bg-sky-500',
    ring: 'ring-sky-500/10',
  },
  failing: { kind: 'failing', label: '', color: 'text-red-600', dot: 'bg-red-500', ring: 'ring-red-500/10' },
  restarting: {
    kind: 'restarting',
    label: '',
    color: 'text-violet-600',
    dot: 'bg-violet-500',
    ring: 'ring-violet-500/10',
  },
  healthy: {
    kind: 'healthy',
    label: 'Healthy',
    color: 'text-emerald-600',
    dot: 'bg-emerald-500',
    ring: 'ring-emerald-500/10',
  },
};

const services = (n: number) => `${n} service${n === 1 ? '' : 's'}`;

export function stageHealth({
  deployed,
  statuses,
}: {
  deployed: boolean;
  statuses?: DisplayStatus[];
}): StageHealth {
  if (!deployed) return HEALTH['not-deployed'];
  if (!statuses) return HEALTH.unknown;
  const asleep = statuses.filter((s) => s === 'asleep').length;
  if (statuses.length > 0 && asleep === statuses.length) return HEALTH.asleep;
  const failing = statuses.filter((s) => s === 'failed' || s === 'stopped').length;
  if (failing > 0) return { ...HEALTH.failing, label: `${services(failing)} not running` };
  const restarting = statuses.filter((s) => s === 'restarting').length;
  if (restarting > 0) return { ...HEALTH.restarting, label: `${services(restarting)} restarting` };
  const unaccounted = statuses.filter((s) => s === 'unknown' || s === 'not-deployed').length;
  if (unaccounted > 0 && unaccounted < statuses.length)
    return {
      ...HEALTH.unknown,
      label: `${services(unaccounted)} of ${statuses.length} not accounted for`,
    };
  if (asleep > 0)
    return {
      ...HEALTH['partly-asleep'],
      label: `${services(asleep)} of ${statuses.length} asleep`,
    };
  if (!statuses.some(isUpStatus)) return HEALTH.unknown;
  return HEALTH.healthy;
}

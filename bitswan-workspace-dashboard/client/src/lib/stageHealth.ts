// One classification of a deployment stage's health, used by BOTH things on
// screen that report it: the pipeline node's badge and the stage card's status
// line.
//
// They live 200-odd lines apart in DeploymentsTab and used to answer different
// questions with the same green: the node lit up emerald with a ✓ whenever
// something was DEPLOYED to the stage, while the card described what was
// actually RUNNING. So a business process whose production containers had been
// crashlooping for two months carried a green tick above a card that (after
// bailey-lab #463) says "1 service restarting". Deployed and healthy are two
// different claims, and only one function should be making the second one.
//
// The split the UI now keeps: the node's emerald FILL means deployed, its
// BADGE means observed health, and a ✓ appears only when the containers were
// seen and every one of them is fine.

import { isUpStatus, type DisplayStatus } from '@/lib/status';

export type StageHealthKind =
  | 'not-deployed'
  | 'unknown'
  | 'asleep'
  | 'failing'
  | 'restarting'
  | 'healthy';

export interface StageHealth {
  kind: StageHealthKind;
  /** Status line for the stage card ("Healthy", "2 services restarting", …). */
  label: string;
  /** Tailwind text colour for that line. */
  color: string;
  /** Tailwind bg colour for the dot beside it. */
  dot: string;
  /** Tailwind ring colour for that dot. */
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
  // Deployed, but its containers were not resolved — so nothing is claimed.
  // The disaster-recovery stage reads this way outside its own view: its
  // containers live in a standby slot whose name is only fetched there.
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

/**
 * How a stage is doing.
 *
 * `deployed` is the caller's own question — the card asks "is there a current
 * deploy entry?", the pipeline node asks "has anything ever been deployed
 * here?" — so it is passed in rather than guessed at.
 *
 * `statuses` is one entry per member container. OMITTING it means the members
 * could not be resolved, which yields 'unknown': deployed, health unread, and
 * nothing asserted either way. An EMPTY array is a deploy record that carries
 * no members at all.
 */
export function stageHealth({
  deployed,
  statuses,
}: {
  deployed: boolean;
  statuses?: DisplayStatus[];
}): StageHealth {
  if (!deployed) return HEALTH['not-deployed'];
  if (!statuses) return HEALTH.unknown;
  // Nothing up at all = intentionally asleep (an operator's Sleep, or the
  // on-demand memory sweep evicting it). Distinct from a failure; it wakes on
  // access. Checked first, because every member reads 'stopped' then.
  if (statuses.length > 0 && !statuses.some(isUpStatus)) return HEALTH.asleep;
  const failing = statuses.filter((s) => s === 'failed' || s === 'stopped').length;
  if (failing > 0) return { ...HEALTH.failing, label: `${services(failing)} not running` };
  // Up, but not healthy: a container in a restart loop keeps being started, so
  // it passes every "is it up?" test and used to be counted as healthy.
  const restarting = statuses.filter((s) => s === 'restarting').length;
  if (restarting > 0) return { ...HEALTH.restarting, label: `${services(restarting)} restarting` };
  return HEALTH.healthy;
}

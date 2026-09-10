// What the stage card's power row may offer: Wake, Put to sleep, or both.
//
// It used to offer Wake only when the ENTIRE stage was asleep
// (`members.every(not up)`). A stage with one service asleep and the rest
// running — the ordinary outcome of the on-demand memory sweep, which evicts
// per deployment and not per stage — therefore showed "Put to sleep" and no way
// at all to bring the sleeping one back. Wake is now offered whenever ANYTHING
// is asleep, and both buttons appear when both apply.

/** One member, reduced to what the power row cares about. */
export interface PowerMember {
  /** Is a container up for it right now (running / restarting / building)? */
  up: boolean;
  /** Does it have a deployment record at all? A never-deployed member is not asleep. */
  present: boolean;
}

export interface StagePower {
  running: number;
  /** Members with a deployment record and nothing up — the ones Wake acts on. */
  sleeping: number;
  canWake: boolean;
  canSleep: boolean;
  /** The sentence above the buttons. */
  label: string;
}

const services = (n: number) => `${n} service${n === 1 ? '' : 's'}`;

/**
 * `asleepReason` is gitops's attribution for the sleep ('manual' |
 * 'memory-pressure'), so the message can say who put it to sleep rather than a
 * bare "asleep".
 */
export function stagePower(members: PowerMember[], asleepReason?: string): StagePower {
  const running = members.filter((m) => m.up).length;
  const sleeping = members.filter((m) => !m.up && m.present).length;
  const canWake = sleeping > 0;
  const canSleep = running > 0;
  let label: string;
  if (sleeping === 0) {
    label = 'Free this stage’s memory now. On-demand stages wake automatically on access.';
  } else if (running === 0) {
    label =
      asleepReason === 'manual'
        ? 'Asleep — put to sleep manually. Wakes on access, or wake now.'
        : asleepReason === 'memory-pressure'
          ? 'Asleep — evicted under memory pressure. Wakes on access, or wake now.'
          : 'Asleep — containers removed to free memory. Wakes on access, or wake now.';
  } else {
    // The case that had no way out: part of the stage is asleep and part of it
    // is serving, so the stage as a whole is neither.
    label = `${services(sleeping)} of ${members.length} asleep${
      asleepReason === 'manual'
        ? ' — put to sleep manually'
        : asleepReason === 'memory-pressure'
          ? ' — evicted under memory pressure'
          : ''
    }. Wake now, or leave them to wake on access.`;
  }
  return { running, sleeping, canWake, canSleep, label };
}

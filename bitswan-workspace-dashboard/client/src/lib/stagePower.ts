export interface PowerMember {
  asleep: boolean;
  up: boolean;
  present: boolean;
  expose: boolean;
}

export interface StagePower {
  running: number;
  sleeping: number;
  canWake: boolean;
  canSleep: boolean;
  label: string;
}

const services = (n: number) => `${n} service${n === 1 ? '' : 's'}`;

export function stagePower(members: PowerMember[], asleepReason?: string): StagePower {
  const running = members.filter((m) => m.up).length;
  const sleeping = members.filter((m) => m.asleep && m.present).length;
  const deployed = members.filter((m) => m.present).length;
  const wakesOnAccess = members.some((m) => m.asleep && m.expose);
  const canWake = sleeping > 0 || running === 0;
  const canSleep = running > 0;
  let label: string;
  if (sleeping === 0 && running === 0) {
    label =
      'Nothing is running on this stage. Wake redeploys it — these containers are not asleep, so nothing brings them back on access.';
  } else if (sleeping === 0) {
    label = 'Free this stage’s memory now. On-demand stages wake automatically on access.';
  } else if (running === 0) {
    label =
      asleepReason === 'manual'
        ? 'Asleep — put to sleep manually. Wakes on access, or wake now.'
        : asleepReason === 'memory-pressure'
          ? 'Asleep — evicted under memory pressure. Wakes on access, or wake now.'
          : 'Asleep — containers removed to free memory. Wakes on access, or wake now.';
  } else {
    label = `${services(sleeping)} of ${deployed} asleep${
      asleepReason === 'manual'
        ? ' — put to sleep manually'
        : asleepReason === 'memory-pressure'
          ? ' — evicted under memory pressure'
          : ''
    }. ${wakesOnAccess ? 'Wake now, or leave them to wake on access.' : 'Wake now.'}`;
  }
  return { running, sleeping, canWake, canSleep, label };
}

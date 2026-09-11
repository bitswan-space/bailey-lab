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
  /** Is it ASLEEP — the reading, not "nothing is up"? See below. */
  asleep: boolean;
  /** Is a container up for it right now (running / restarting / building)? */
  up: boolean;
  /** Does it have a deployment record at all? A never-deployed member is not asleep. */
  present: boolean;
  /** Is it reachable through the ingress? Only an exposed host can wake on access. */
  expose: boolean;
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
  // Sleeping is the READING, not "not up". "Not up" also covers a container
  // that exited, failed, or could not be read at all, and offering to wake
  // those — under a sentence promising they wake on access — is the same false
  // comfort this branch removes elsewhere (see lib/stageHealth.ts).
  const sleeping = members.filter((m) => m.asleep && m.present).length;
  // Denominator: what could be asleep. A member with no deploy record is not
  // part of that count, or the row says "1 of 3" about two deployments.
  const deployed = members.filter((m) => m.present).length;
  // Wake-on-access needs a request to arrive at a dehydrated INGRESS host. A
  // sleeping worker behind a frontend that is still serving has nothing
  // routing to it — nobody will ever knock — so it is only true to mention
  // when an exposed member is among the sleepers.
  const wakesOnAccess = members.some((m) => m.asleep && m.expose);
  // Wake whenever NOTHING is up — asleep or dead. `_wake_context_stage`
  // re-activates every member of the group and runs `docker compose up`, which
  // revives dead containers as well as slept ones, so a stage whose containers
  // all died is not a dead end: it is the stage that most needs the button.
  // What must not happen is the SENTENCE below calling those containers asleep
  // or promising they wake on access, which is why that case has its own.
  const canWake = sleeping > 0 || running === 0;
  const canSleep = running > 0;
  let label: string;
  if (sleeping === 0 && running === 0) {
    // Deployed, nothing up, and nothing asleep: these containers died. Nothing
    // will bring them back on access — there is no dehydrated host to knock on.
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
    // The case that had no way out: part of the stage is asleep and part of it
    // is serving, so the stage as a whole is neither.
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

// The containers of one business process inside one copy — the list the Coding
// Agent screen shows twice: as the Containers sub-tab's sidebar, and as the
// Environment panel's frontends / worker-containers split.
//
// It lives here because both panes used to derive it inline, with the same
// hand-written copy of the state collapse — and the same two bugs in it
// (bailey-lab #463):
//
//   * `restarting` was mapped onto `running`, so a crashlooping business
//     process showed a green dot. One on the sandbox had been restarting for
//     two months, 23,032 times, in production and staging.
//   * when several records shared a name, the merge preferred `running` over
//     whatever the other records said — the best state won, so one healthy
//     record hid every broken one behind it.
//
// Both are the same habit: letting the indicator follow the intent rather than
// the observation. The rule here is the opposite one — the worst state
// observed is the honest one to show — and it is `lib/status.ts`, which the
// rest of the dashboard already uses, that decides what a state means.

import type { DeployedAutomation } from '@/types';
import { stateToDisplay, worstStatus, type DisplayStatus } from '@/lib/status';

/** One container of a business process, as the Coding Agent screen shows it. */
export interface BpContainer {
  name: string;
  /** Absent until the automation has been deployed at least once. */
  deploymentId?: string;
  /** Public URL — frontends only (`expose`). */
  url?: string;
  status: DisplayStatus;
  /**
   * Times Docker's restart policy has brought the container back up. Absent
   * means the driver did not read it (it reads it only for containers it sees
   * restarting) — NOT zero, which would claim the container has never died.
   */
  restartCount?: number;
  /** True for frontends (exposed through Bailey), false for worker containers. */
  expose: boolean;
}

/**
 * The copy's containers for one business process, one row per automation name,
 * sorted by name.
 */
export function bpContainers(
  automations: DeployedAutomation[],
  copy: string,
  bp: string,
): BpContainer[] {
  const prefix = `copies/${copy}/${bp}/`;
  const byName = new Map<string, BpContainer>();
  for (const a of automations) {
    if (!(a.relative_path ?? '').startsWith(prefix)) continue;
    const name = a.automation_name ?? a.name;
    // Read the state, and ONLY the state. gitops fills `status` with the
    // container's health-or-state ("healthy", "unhealthy", …), so the old
    // `state ?? status` fallback was comparing health strings against docker
    // state names — none of which matched, quietly landing on "stopped".
    const status: DisplayStatus = a.deployment_id
      ? stateToDisplay(a.state)
      : 'not-deployed';
    const restartCount = a.restart_count ?? undefined;
    const prev = byName.get(name);
    byName.set(name, {
      name,
      deploymentId: a.deployment_id ?? prev?.deploymentId ?? undefined,
      url: a.automation_url ?? prev?.url ?? undefined,
      status: prev ? worstStatus(prev.status, status) : status,
      // Several records for one name means several containers (replicas, a
      // blue/green pair): the highest count is the one worth showing.
      restartCount:
        restartCount === undefined
          ? prev?.restartCount
          : Math.max(restartCount, prev?.restartCount ?? 0),
      expose: !!a.expose || !!prev?.expose,
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

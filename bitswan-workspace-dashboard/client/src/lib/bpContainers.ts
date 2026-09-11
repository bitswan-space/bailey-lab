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
import { displayFor, worstStatus, type DisplayStatus } from '@/lib/status';

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
   * means the driver could not read it — NOT zero, which would claim the
   * container has never died.
   */
  restartCount?: number;
  /**
   * The container the row describes, and when it last started (ISO-8601). Both
   * absent when the driver could not read them. Together they are the baseline
   * an operator's own Restart is measured against: the start time is the only
   * thing that moves when a container is restarted in place (bailey-lab #476).
   */
  containerId?: string;
  startedAt?: string;
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
    // One shared reading (lib/status.ts). It ignores `status`, which gitops
    // fills with the container's health-or-state ("healthy", "unhealthy", …) —
    // the old `state ?? status` fallback compared health strings against docker
    // state names, matched nothing, and quietly landed on "stopped" — and it
    // tells a SLEPT automation (the live-dev cap evicts them too) from one
    // whose state simply could not be read.
    const status: DisplayStatus = displayFor(a);
    const restartCount = a.restart_count ?? undefined;
    const prev = byName.get(name);
    // When several records share a name, the row describes ONE of them: the
    // one in the worst state. Taking the status from that record but the
    // deployment id from whichever record happened to come last would point
    // the dot at one container and the Logs/Restart buttons at another.
    const keep = !prev || worstStatus(prev.status, status) === status ? 'new' : 'prev';
    byName.set(name, {
      name,
      deploymentId:
        (keep === 'new' ? a.deployment_id : prev?.deploymentId) ??
        prev?.deploymentId ??
        a.deployment_id ??
        undefined,
      // From the kept record only — no falling back to the other one. A URL
      // borrowed from the healthy slot while the dot and the buttons describe
      // the sick one is the same split, in the one field a user navigates with.
      url: (keep === 'new' ? a.automation_url : prev?.url) ?? undefined,
      status: prev ? worstStatus(prev.status, status) : status,
      // Several records for one name means several containers (replicas, a
      // blue/green pair): the highest count is the one worth showing.
      restartCount:
        restartCount === undefined
          ? prev?.restartCount
          : Math.max(restartCount, prev?.restartCount ?? 0),
      // The id and the start time come from the KEPT record, like the url above
      // and NOT like the count on the line above that. The difference is
      // deliberate: "the highest count any replica reported" is still true of
      // the deployment, but "the most recently started replica" pinned to
      // another replica's id is false about a container — and it would make the
      // row look restarted whenever ANY replica restarted, witnessing an action
      // this row's own Restart button never took.
      containerId: (keep === 'new' ? a.container_id : prev?.containerId) ?? undefined,
      startedAt: (keep === 'new' ? a.started_at : prev?.startedAt) ?? undefined,
      expose: !!a.expose || !!prev?.expose,
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}


import type { DeployedAutomation } from '@/types';
import { displayFor, worstStatus, type DisplayStatus } from '@/lib/status';

export interface BpContainer {
  name: string;
  deploymentId?: string;
  url?: string;
  status: DisplayStatus;
  restartCount?: number;
  expose: boolean;
}

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
    const status: DisplayStatus = displayFor(a);
    const restartCount = a.restart_count ?? undefined;
    const prev = byName.get(name);
    const keep = !prev || worstStatus(prev.status, status) === status ? 'new' : 'prev';
    byName.set(name, {
      name,
      deploymentId:
        (keep === 'new' ? a.deployment_id : prev?.deploymentId) ??
        prev?.deploymentId ??
        a.deployment_id ??
        undefined,
      url: (keep === 'new' ? a.automation_url : prev?.url) ?? undefined,
      status: prev ? worstStatus(prev.status, status) : status,
      restartCount:
        restartCount === undefined
          ? prev?.restartCount
          : Math.max(restartCount, prev?.restartCount ?? 0),
      expose: !!a.expose || !!prev?.expose,
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

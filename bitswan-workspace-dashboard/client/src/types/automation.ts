// Automation types — mirror bitswan-gitops's DeployedAutomation
// (app/models.py). All field names are snake_case to match the on-the-wire
// JSON exactly; no client-side renaming.

/* eslint-disable no-restricted-syntax -- wire-mirror nullable fields match Python's `str | None` */

export interface DeployedAutomation {
  container_id: string | null;
  endpoint_name: string | null;
  created_at: string | null;
  name: string;
  state: AutomationState | null;
  status: string | null;
  deployment_id: string | null;
  active: boolean;
  automation_url: string | null;
  relative_path: string | null;
  stage: AutomationStage | null;
  automation_name: string | null;
  context: string | null;
  version_hash: string | null;
  replicas: number;
  // True for frontends (exposed through Bailey), false for worker containers
  // (private backends). Drives the Environment panel's Frontends vs Worker
  // containers split. Optional for back-compat with older gitops payloads.
  expose?: boolean;
  // Memory governance (Containers tab): live usage vs the declared reservation.
  mem_usage_bytes?: number | null;
  mem_reservation_mb?: number | null;
  mem_policy?: string | null;
  mem_over_reservation?: boolean;
  // Why this deployment is asleep — 'memory-pressure' (evicted by the automatic
  // budget sweep) or 'manual' (an operator's Sleep). Only set when it has no
  // running container.
  asleep_reason?: string | null;
}

export type AutomationState =
  | 'running'
  | 'restarting'
  | 'starting'
  | 'created'
  | 'exited'
  | 'dead'
  | 'paused'
  | ''
  // Defensive: gitops types this as plain string, so accept anything.
  | (string & {});

export type AutomationStage = '' | 'dev' | 'staging' | 'production' | 'live-dev';

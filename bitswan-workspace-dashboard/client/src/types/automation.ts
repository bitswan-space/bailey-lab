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

// Type definitions mirror the gitops models so a single field name is used
// across both projects. See:
//   bitswan-gitops/app/models.py        — DeployedAutomation
//   bitswan-gitops/app/routes/worktrees.py — list_worktrees() response shape

export interface BusinessProcess {
  id: string;
  name: string;
  path: string;
  hasWorktrees: boolean;
}

// Shape returned by gitops GET /worktrees/ (list_worktrees in worktrees.py).
export interface Worktree {
  name: string;
  branch: string;
  commit_hash: string;
  commit_message: string;
  has_requirements: boolean;
  synced: boolean;
}

// Mirrors bitswan-gitops `DeployedAutomation` (app/models.py). All fields are
// snake_case to match the on-the-wire JSON exactly — no client-side renaming.
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
  // Defensive: gitops's model types this as plain string, so accept anything.
  | (string & {});

export type AutomationStage = '' | 'dev' | 'staging' | 'production' | 'live-dev';

export type Scope = { type: 'deployments' } | { type: 'worktree'; name: string };

// A *partial* view over `docker inspect` output. Only the fields the Inspect
// modal renders are declared; everything else is tolerated. Field names use
// Docker's PascalCase exactly as they come off the socket.
export interface DockerInspect {
  Id?: string;
  Name?: string;
  Created?: string;
  RestartCount?: number;
  State?: {
    Status?: string;
    Pid?: number;
    Health?: {
      Status?: string;
      FailingStreak?: number;
    };
  };
  Image?: string;
  Config?: {
    Image?: string;
    Hostname?: string;
    Labels?: Record<string, string>;
    Healthcheck?: {
      Test?: string[];
      Interval?: number;
    };
  };
  HostConfig?: {
    NanoCpus?: number;
    Memory?: number;
  };
  NetworkSettings?: {
    Networks?: Record<string, { IPAddress?: string }>;
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  };
  Mounts?: Array<{
    Type?: string;
    Source?: string;
    Destination?: string;
    Mode?: string;
    RW?: boolean;
  }>;
}

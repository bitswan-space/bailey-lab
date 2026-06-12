// Per-BP stage-snapshot types. Shapes mirror gitops's /snapshots router
// (bitswan-gitops/app/routes/snapshots.py + app/snapshot_manager.py +
// app/services/snapshot_service.py manifests).

export type SnapshotStage = 'dev' | 'staging' | 'production';

export const SNAPSHOT_STAGES: SnapshotStage[] = ['dev', 'staging', 'production'];

export type SnapshotKind = 'manual' | 'auto';

export interface SnapshotServiceMeta {
  included: boolean;
  file?: string;
  size_bytes?: number;
  /** Why the service was skipped, when `included` is false. */
  reason?: string;
  database?: string;
  databases?: string[];
  bucket?: string;
}

/** One snapshot's manifest.json. */
export interface Snapshot {
  version: number;
  id: string;
  bp: string;
  bp_name: string;
  stage: SnapshotStage;
  label: string;
  kind: SnapshotKind;
  created_at: string;
  workspace?: string;
  services: Partial<Record<'postgres' | 'couchdb' | 'minio', SnapshotServiceMeta>>;
  total_size_bytes: number;
  /** Provenance for auto-snapshots (pre-restore / clone source). */
  source?: {
    reason?: string;
    restored_snapshot_id?: string;
    restored_from_stage?: string;
    target_stage?: string;
  };
}

export type SnapshotOperation = 'create' | 'restore' | 'clone';

export type SnapshotTaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed';

/** Snapshot task from `GET /api/snapshots/tasks/{id}` (and the
 *  `snapshot_progress` SSE event). */
export interface SnapshotTask {
  task_id: string;
  operation: SnapshotOperation;
  bp: string;
  stages: SnapshotStage[];
  source_stage: SnapshotStage | null;
  target_stage: SnapshotStage | null;
  snapshot_id: string | null;
  status: SnapshotTaskStatus;
  step: string | null;
  /** The operation's full step sequence — drives the progress bar. */
  steps: string[];
  message: string;
  error: string | null;
  result: Record<string, unknown> | null;
  started_at: string;
  completed_at: string | null;
}

export interface SnapshotStageEligibility {
  registered: boolean;
  services: Record<string, boolean>;
  /** Live service availability (only on the /eligibility endpoint). */
  availability?: Record<string, { available: boolean; reason: string | null }>;
}

export interface SnapshotEligibility {
  bp: string;
  bp_name: string;
  registered: boolean;
  stages: Record<SnapshotStage, SnapshotStageEligibility>;
}

/** `GET /api/snapshots/{bp}` response. */
export interface SnapshotListResponse {
  bp: string;
  snapshots: Snapshot[];
  eligibility: SnapshotEligibility;
  disk_usage_bytes: number;
  active_tasks: SnapshotTask[];
}

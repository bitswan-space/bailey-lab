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
/**
 * A snapshot in the list.
 *
 * Everything below `id`/`bp`/`stage`/`created_at` is OPTIONAL, because a
 * `remote_only` entry has none of it. Those are synthesised by gitops from what
 * the server's backup repo knows about an off-site copy — an id, a stage and a
 * timestamp — and the repo simply does not record which services the snapshot
 * held or how large it was. gitops does not invent values it cannot know.
 *
 * These were once declared required, which is why `Object.entries(s.services)`
 * type-checked and then crashed the whole Backups page on the first remote-only
 * snapshot. Keep them optional: the compiler is what stops that recurring.
 */
export interface Snapshot {
  id: string;
  bp: string;
  stage: SnapshotStage;
  created_at: string;
  version?: number;
  bp_name?: string;
  label?: string;
  kind?: SnapshotKind;
  workspace?: string;
  services?: Partial<Record<'postgres' | 'couchdb' | 'garage', SnapshotServiceMeta>>;
  total_size_bytes?: number;
  /** Provenance for auto-snapshots (pre-restore / clone source). */
  source?: {
    reason?: string;
    restored_snapshot_id?: string;
    restored_from_stage?: string;
    target_stage?: string;
  };
  /** False when the snapshot exists only in the server backup (local files
   *  deleted or pruned) — Fetch materializes it back. */
  local?: boolean;
  /** True for snapshots known only from the server's backup repo. */
  remote_only?: boolean;
}

export type SnapshotOperation = 'create' | 'restore' | 'clone' | 'fetch';

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
  /** Whether the server makes off-site backups this workspace can be
   *  recovered from (AOC-connected). */
  offsite_enabled?: boolean;
}

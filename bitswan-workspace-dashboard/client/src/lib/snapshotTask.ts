import { api } from './api';
import type { SnapshotTask } from '@/types';

const POLL_INTERVAL_MS = 2000;
// A restore dumps + clears + loads three data services; minutes are normal
// for big datasets, and the loop is a cheap GET.
const TIMEOUT_MS = 30 * 60_000;
// Consecutive poll failures before giving up (gitops restarted and forgot
// the task, auth broke, …).
const MAX_POLL_FAILURES = 5;

export type SnapshotTaskOutcome = 'completed' | 'failed' | 'timeout' | 'lost';

/**
 * Watch an already-started gitops snapshot task by polling
 * `GET /api/snapshots/tasks/{id}` and emitting every state to `onProgress`
 * (drives the Snapshots tab's progress card). Resolves with the terminal
 * outcome and the last task snapshot.
 *
 * Deliberately NOT driven by the `snapshot_progress` SSE event — same
 * rationale as `watchDeployTask` in deployBp.ts: that event is
 * fire-and-forget, so a dropped stream would lose the terminal event and
 * leave the UI stuck mid-operation forever. SSE freshness can be layered on
 * top by callers; the poll is the source of truth.
 */
export async function watchSnapshotTask(
  taskId: string,
  onProgress: (task: SnapshotTask) => void,
): Promise<{ outcome: SnapshotTaskOutcome; task: SnapshotTask | null }> {
  const deadline = Date.now() + TIMEOUT_MS;
  let failures = 0;
  // eslint-disable-next-line no-restricted-syntax -- null until the first poll lands
  let last: SnapshotTask | null = null;
  while (Date.now() < deadline) {
    try {
      last = await api.snapshots.taskStatus(taskId);
      failures = 0;
    } catch {
      failures += 1;
      if (failures >= MAX_POLL_FAILURES) {
        return { outcome: 'lost', task: last };
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }
    onProgress(last);
    if (last.status === 'completed') return { outcome: 'completed', task: last };
    if (last.status === 'failed') return { outcome: 'failed', task: last };
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { outcome: 'timeout', task: last };
}

/** 0–100 progress derived from the task's position in its step sequence. */
export function snapshotTaskProgress(task: SnapshotTask): number {
  if (task.status === 'completed') return 100;
  const steps = task.steps ?? [];
  if (!task.step || steps.length === 0) {
    return task.status === 'in_progress' ? 5 : 0;
  }
  const idx = steps.indexOf(task.step);
  if (idx < 0) return 5;
  // Entering step i of n ≈ i/n done; never show 100 before terminal status.
  return Math.min(95, Math.round((idx / Math.max(1, steps.length - 1)) * 100));
}

/** Human label for a snapshot step id (fallback when no message is set). */
export function snapshotStepLabel(step: string | null): string {
  switch (step) {
    case 'validating':
      return 'Validating…';
    case 'pre_restore_snapshot':
      return 'Auto-snapshotting target…';
    case 'pruning':
      return 'Pruning old auto-snapshots…';
    case 'snapshot_postgres':
      return 'Snapshotting Postgres…';
    case 'snapshot_couchdb':
      return 'Snapshotting CouchDB…';
    case 'snapshot_minio':
      return 'Snapshotting MinIO…';
    case 'restore_postgres':
      return 'Restoring Postgres…';
    case 'restore_couchdb':
      return 'Restoring CouchDB…';
    case 'restore_minio':
      return 'Restoring MinIO…';
    case 'done':
      return 'Done';
    default:
      return 'Working…';
  }
}

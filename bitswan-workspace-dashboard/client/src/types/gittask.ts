// Git task-queue types. Shapes mirror gitops's task queue, surfaced over the
// `/api/events` SSE feed (`task_queue_snapshot` on connect, `task_queue` per
// change) and the `GET /tasks` REST snapshot.

export type GitTaskStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** One git task in the queue. */
export interface GitTask {
  task_id: string;
  /** Short label like "deploy" / "sync" / "promote". */
  kind: string;
  /** Email of the user who initiated the action. */
  requester_email: string;
  /** Optional sub-target, e.g. the business-process name. */
  // eslint-disable-next-line no-restricted-syntax -- null = no sub-target
  label: string | null;
  status: GitTaskStatus;
  // eslint-disable-next-line no-restricted-syntax -- null until set by gitops
  message: string | null;
  // eslint-disable-next-line no-restricted-syntax -- null unless failed
  error: string | null;
  created_at: string;
  // eslint-disable-next-line no-restricted-syntax -- null until running
  started_at: string | null;
  // eslint-disable-next-line no-restricted-syntax -- null until terminal
  completed_at: string | null;
}

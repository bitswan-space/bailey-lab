// Workspace-shaped types: business processes, worktrees, and the
// top-bar flow tab.
// Worktree shape mirrors gitops's GET /worktrees/ (see
// bitswan-gitops/app/routes/worktrees.py — list_worktrees).

export interface BusinessProcess {
  /** Directory name — also the value used in `/api/business-processes/:id/readme`. */
  id: string;
  name: string;
  path: string;
  /** True when the BP exists in the main repo. */
  inMain: boolean;
  /** Worktrees that also carry this BP (by directory name). */
  worktrees: string[];
  /** Convenience: `worktrees.length > 0`. */
  hasWorktrees: boolean;
}

export interface Worktree {
  name: string;
  branch: string;
  commit_hash: string;
  commit_message: string;
  has_requirements: boolean;
  synced: boolean;
}

/** The top-bar flow tabs. Description, Deployments and Snapshots work
 *  without a worktree (both are always main-scoped); the other three follow
 *  the selected worktree. */
export type FlowTab =
  | 'description'
  | 'agent'
  | 'requirements'
  | 'sync-deploy'
  | 'deployments'
  | 'snapshots';

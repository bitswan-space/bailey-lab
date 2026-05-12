// Workspace-shaped types: business processes, worktrees, and the
// deployments-vs-worktree scope toggle.
// Worktree shape mirrors gitops's GET /worktrees/ (see
// bitswan-gitops/app/routes/worktrees.py — list_worktrees).

export interface BusinessProcess {
  id: string;
  name: string;
  path: string;
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

export type Scope = { type: 'deployments' } | { type: 'worktree'; name: string };

// Workspace-shaped types: business processes, copies, and the
// top-bar flow tab.
// Copy shape mirrors gitops's GET /copies/ (see
// bitswan-gitops/app/routes/copies.py — list_copies).

export interface BusinessProcess {
  /** Directory name — also the value used in `/api/business-processes/:id/readme`. */
  id: string;
  name: string;
  path: string;
  /** True when the BP exists in the main repo. */
  inMain: boolean;
  /** Copies that also carry this BP (by directory name). */
  copies: string[];
  /** Convenience: `copies.length > 0`. */
  hasCopies: boolean;
}

export interface Copy {
  name: string;
  branch: string;
  commit_hash: string;
  commit_message: string;
  has_requirements: boolean;
  synced: boolean;
  /** Commits on this copy not yet on main. */
  ahead: number;
  /** Commits on main this copy hasn't picked up (>0 ⇒ a rebase is needed). */
  behind: number;
  /** Uncommitted changes in the working tree. */
  has_changes: boolean;
}

/** The top-bar flow tabs. Description and Deployments work without a
 *  copy (both are always main-scoped); the other three follow the
 *  selected copy. Data snapshots live inside Deployments, per stage. */
export type FlowTab =
  | 'description'
  | 'agent'
  | 'requirements'
  | 'sync-deploy'
  | 'deployments';

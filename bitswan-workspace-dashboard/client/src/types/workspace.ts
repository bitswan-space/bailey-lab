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

/**
 * A copy's git state, AGGREGATED across its per-BP clones (every business
 * process is its own repo; the copy is a directory of per-BP checkouts on
 * branch <copy>).
 */
export interface Copy {
  name: string;
  branch: string;
  /** Newest commit across the copy's BP clones. */
  commit_hash: string;
  commit_message: string;
  has_requirements: boolean;
  /** Every BP clone in step with its repo's main and clean. */
  synced: boolean;
  /** Sum of commits across BP clones not yet on their mains. */
  ahead: number;
  /** Sum of commits on the mains this copy hasn't picked up (>0 ⇒ pull). */
  behind: number;
  /** Uncommitted changes in ANY of the copy's BP clones. */
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

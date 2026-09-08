// Workspace-shaped types: business processes, copies, and the
// top-bar flow tab.
// Copy shape mirrors gitops's GET /copies/ (see
// bitswan-gitops/app/routes/copies.py — list_copies).

export interface BusinessProcess {
  /** Directory name — also the value used in `/api/business-processes/:id/readme`. */
  id: string;
  name: string;
  /** Human-readable name from process.toml; equals `name` for BPs that
   *  predate display names. Use for rendering only — never in API paths. */
  displayName: string;
  path: string;
  /** True when the BP exists in the main repo. */
  inMain: boolean;
  /** Copies that also carry this BP (by directory name). */
  copies: string[];
  /** Convenience: `copies.length > 0`. */
  hasCopies: boolean;
}

/**
 * One copy as the `copies` SSE snapshot describes it: cheap filesystem facts
 * ONLY. Nothing here costs a git ref comparison, let alone a fetch — the
 * snapshot used to carry aggregated ahead/behind/dirtiness for every copy ×
 * every business process, which meant a `git fetch` per pair on every git
 * event (75s on a real workspace) to feed a UI that shows one copy and one BP
 * at a time. Every divergence question is now asked on demand, scoped to
 * what's on screen:
 *   - `GET /api/copies/:name/behind`         total + per-BP behind-main count
 *   - `GET /api/copies/:name/divergence`     exact per-BP ahead/behind (Deploy)
 *   - `GET /api/copies/:name/divergence-all` per-BP ahead/behind, whole copy
 *   - `GET /api/copies/:name/status`         per-file changes incl. uncommitted
 *   - `GET /api/copies/:name/merge-preview`  what a merge-back would carry
 */
export interface Copy {
  name: string;
  branch: string;
  has_requirements: boolean;
  /**
   * Explicit copy metadata (gitops `.copy.json`). It is the ONLY source of
   * kind/ownership — never infer either from the copy's name. Copies created
   * before the metadata existed ("legacy" copies) carry none of these fields;
   * the dashboard hides those from its UI.
   */
  kind?: 'user' | 'experiment' | 'audit';
  /** The owner's email. */
  owner?: string;
  /** Experiments only: the user copy this experiment branched off, and the
   *  only place it merges back into. */
  parent?: string;
  /**
   * EXPERIMENTS AND AUDITS: the directory name of the ONE business process the
   * copy is about. A copy is a person's workspace-wide environment; an
   * experiment is a side branch of a single business process, because each
   * business process is its own git repository. gitops refuses to materialize
   * any other process into an experiment (409), so this never changes.
   *
   * The experiments list is filtered on it: an experiment is only offered
   * while you are looking at the process it belongs to.
   */
  bp?: string;
  /**
   * True for an experiment created BEFORE experiments were per-business
   * process, whose `bp` was therefore never recorded. Which process it is
   * about is not recoverable and is deliberately not guessed — the UI groups
   * these separately and labels them, rather than hiding a copy its owner can
   * still open and discard.
   */
  bp_legacy?: boolean;
  /**
   * AUDITS ONLY: the frozen staging image this copy was opened to review, and
   * the source commit it was built from. The copy holds that version, so an
   * auditor reads it with the same agent, files and diff as any other copy —
   * and if they change it, deploying is a NEW version that goes through
   * Development and its own sign-off. Nothing here can alter the frozen image.
   */
  audited?: { sha: string; commit: string };
  /** Display name. An experiment's `name` is an opaque slug — everything the
   *  user sees is this title. */
  title?: string;
}

/** The top-bar flow tabs. Get started is an always-available orientation
 *  page (needs no business process or copy). Description and Deployments
 *  work without a copy (both are always main-scoped); the others follow the
 *  selected copy. Sync only exists on your OWN copy, and only while main has
 *  changes it lacks; Deploy is hidden inside experiments (they merge back
 *  into their parent copy instead). Data snapshots live inside Deployments,
 *  per stage. */
export type FlowTab =
  | 'get-started'
  | 'sync'
  | 'description'
  // Only in an audit copy, where it takes Deploy's place: the report and the
  // sign-off it argues for.
  | 'audit'
  | 'agent'
  | 'requirements'
  | 'deploy'
  | 'deployments';

/** Enter a copy: the transition every copy switch goes through. `after` is
 *  work the destination is not usable without (a business process being
 *  cloned into it). `landOn` is where to arrive and `landOnView` the sub-view
 *  inside it — the audit door opens the code, not the page the button was on,
 *  and not the chat next to it either. */
export type EnterCopy = (
  name: string,
  label: string,
  opts?: { after?: () => Promise<void>; landOn?: FlowTab; landOnView?: string },
) => void;

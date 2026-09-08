/**
 * The one decision behind the Deploy screen's headline: is this business
 * process up to date with main, or is there something to publish?
 *
 * It is pulled out of the component because it is the sentence users act on,
 * and because getting it wrong is silent. "All deployed and up to date" is a
 * claim; the screen may only make it when it has actually READ both facts it
 * rests on — how the process stands against main, and whether the copy holds
 * uncommitted work. Twice now that rule has been broken by treating a reading
 * that had not arrived as a reading of zero:
 *
 *   * the divergence read: a pending fetch rendered as "up to date", so a copy
 *     with commits to publish looked clean until the next git event;
 *   * the uncommitted-work read: it happened once at mount and swallowed its
 *     own failures, so a user who saved the Description and opened Deploy was
 *     told there was nothing to publish over work sitting on disk.
 *
 * So "not known yet" and "nothing there" are separate answers here, and only
 * one of them is allowed to say up to date.
 */

/** One uncommitted file, as `GET /copies/{name}/status` returns it. */
export interface ChangedPath {
  /** Copy-root-relative: `<business process dir>/…`. */
  path: string;
}

/** Divergence counts for the business process on screen. */
export interface DivergenceCounts {
  ahead_bp: number;
  behind_bp: number;
}

export interface LastDeployReading {
  // eslint-disable-next-line no-restricted-syntax
  status: 'completed' | 'failed' | null;
  // eslint-disable-next-line no-restricted-syntax
  cause?: string | null;
  // eslint-disable-next-line no-restricted-syntax
  error?: string | null;
  at?: string;
}

export interface DeployReadinessInput {
  /** The divergence reading, or null when it has not arrived / failed. */
  // eslint-disable-next-line no-restricted-syntax -- null = not known
  divergence: DivergenceCounts | null;
  /** Every uncommitted path in the COPY (all business processes). */
  changed: ChangedPath[];
  /** True while the change list has not arrived, or its read failed. */
  changedUnknown: boolean;
  /** The business process's directory slug. */
  bpDir: string;
  // eslint-disable-next-line no-restricted-syntax
  lastDeploy?: LastDeployReading | null;
}

export interface DeployReadiness {
  /** Uncommitted paths belonging to this business process. */
  bpChanged: ChangedPath[];
  /** This process has uncommitted work. Meaningless unless `known`. */
  dirty: boolean;
  /** Both underlying facts have been read. Until then nothing below is a
   *  statement about the world. */
  known: boolean;
  /** Safe to tell the user there is nothing to do. */
  upToDate: boolean;
  /** There is something to publish, or something blocking it. */
  actionable: boolean;
  /** Publishing is not a fast-forward: main moved. Sync (or overwrite) first. */
  blockedByBehind: boolean;
  lastDeployFailed: boolean;
  retryOnly: boolean;
}

/**
 * Only THIS business process's uncommitted files. Each process is its own git
 * repository and Deploy publishes one of them, so another process's unsaved
 * work must not make this screen look dirty.
 */
export function changedForBp(changed: ChangedPath[], bpDir: string): ChangedPath[] {
  return changed.filter(
    (c) => c.path === bpDir || c.path.startsWith(`${bpDir}/`),
  );
}

export function deployReadiness({
  divergence,
  changed,
  changedUnknown,
  bpDir,
  lastDeploy,
}: DeployReadinessInput): DeployReadiness {
  const bpChanged = changedForBp(changed, bpDir);
  const dirty = bpChanged.length > 0;
  const divergenceKnown = divergence !== null;
  const known = divergenceKnown && !changedUnknown;
  const aheadBp = divergence?.ahead_bp ?? 0;
  const behindBp = divergence?.behind_bp ?? 0;
  const lastDeployFailed = lastDeploy?.status === 'failed';
  // Up to date requires BOTH readings. Everything else is actionable, which is
  // the safe direction to be wrong in: offering a button that turns out to be
  // a no-op costs a click, whereas hiding one costs the user their work's
  // existence.
  const nothingToPublish = known && aheadBp === 0 && behindBp === 0 && !dirty;
  const upToDate = nothingToPublish && !lastDeployFailed;
  return {
    bpChanged,
    dirty,
    known,
    upToDate,
    actionable: !upToDate,
    blockedByBehind: behindBp > 0,
    lastDeployFailed,
    retryOnly: lastDeployFailed && nothingToPublish,
  };
}

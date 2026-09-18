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
import type { TestState } from '@/lib/api';

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
  /**
   * The BP's requirement-test state, or null when nothing has run (or the BP
   * has no requirements at all). Deploy is gated on it: publishing code whose
   * tests are failing is the thing this whole surface exists to prevent.
   */
  // eslint-disable-next-line no-restricted-syntax -- null = no run / no contract
  tests?: TestState | null;
  /** True when the BP has no requirements, so there is nothing to gate on. */
  hasRequirements?: boolean;
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
  /** A test run is in flight for this BP — deploy waits for it. */
  testsRunning: boolean;
  /** Tests failed, or their verdicts no longer describe the current code. */
  blockedByTests: boolean;
  /** Why the tests block, written for a human. Empty when they don't. */
  testsReason: string;
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

/**
 * How the requirement tests bear on deploying this BP.
 *
 * A BP with no requirements is NOT gated: "no tests" is not "failing tests",
 * and gating it would stop every business process that has not adopted the
 * feature from ever deploying. `no_test` requirements are likewise not
 * blocking — they are an unfinished contract, and the count is surfaced
 * elsewhere rather than used to bar the door.
 */
function testGate(
  tests: TestState | null | undefined,
  hasRequirements: boolean | undefined,
): { running: boolean; blocked: boolean; reason: string } {
  if (hasRequirements === false) return { running: false, blocked: false, reason: '' };
  if (!tests) {
    return {
      running: false,
      blocked: true,
      reason: 'Tests have not run for this business process yet.',
    };
  }
  if (tests.status === 'running') {
    const pending = tests.counts.queued + tests.counts.running;
    return {
      running: true,
      blocked: true,
      reason: `${pending} test(s) still running. Deploy is available once they pass.`,
    };
  }
  if (tests.stale) {
    return {
      running: false,
      blocked: true,
      reason:
        'The code changed after the last test run, so its results no longer describe it. Commit to start a new run.',
    };
  }
  const failing = tests.counts.fail + tests.counts.blocked;
  if (failing > 0) {
    return {
      running: false,
      blocked: true,
      reason: `${failing} test(s) are not passing. All tests must pass before this can be deployed.`,
    };
  }
  if (!tests.green) {
    return {
      running: false,
      blocked: true,
      reason: 'The last test run did not complete.',
    };
  }
  return { running: false, blocked: false, reason: '' };
}

export function deployReadiness({
  divergence,
  changed,
  changedUnknown,
  bpDir,
  lastDeploy,
  tests,
  hasRequirements,
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
  const gate = testGate(tests, hasRequirements);
  return {
    bpChanged,
    dirty,
    known,
    upToDate,
    actionable: !upToDate,
    blockedByBehind: behindBp > 0,
    lastDeployFailed,
    retryOnly: lastDeployFailed && nothingToPublish,
    testsRunning: gate.running,
    // Nothing to publish cannot be blocked by tests: there is no deploy to
    // stop, and saying "tests are failing" on an up-to-date screen would be
    // noise about work that already shipped.
    blockedByTests: gate.blocked && !upToDate,
    testsReason: gate.blocked && !upToDate ? gate.reason : '',
  };
}

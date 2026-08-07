import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useCopies,
  useCopyRefsMoved,
  useDeployDone,
} from '@/components/workspace/WorkspaceProvider';
import {
  api,
  EdgeUnavailableError,
  errorMessage,
  type BpDivergence,
} from '@/lib/api';
import { SessionExpiredError } from '@/lib/session';

/** Two readings that say the same thing. Compared by value so an unchanged
 *  answer can be dropped rather than re-rendered (see `setDivergence` below). */
function sameDivergence(
  // eslint-disable-next-line no-restricted-syntax -- null = no previous reading
  a: BpDivergence | null,
  b: BpDivergence,
): boolean {
  return (
    !!a &&
    a.bp === b.bp &&
    a.ahead_bp === b.ahead_bp &&
    a.ahead_other === b.ahead_other &&
    a.behind_bp === b.behind_bp &&
    a.behind_other === b.behind_other
  );
}

/** How long to wait before asking again when the workspace router had no
 *  route for us. Long enough that a Traefik reconfigure has finished, short
 *  enough that a first-ever read still lands while the user is looking. */
const EDGE_RECHECK_MS = 3_000;

export interface BpDivergenceReading {
  /** null = not read yet, or the last read FAILED. Never 0-as-unknown. */
  // eslint-disable-next-line no-restricted-syntax -- null = not known
  divergence: BpDivergence | null;
  /** Why the last read failed. null = `divergence` is trustworthy. */
  // eslint-disable-next-line no-restricted-syntax -- null = no error
  error: string | null;
  /** True once we have either a reading or an error — i.e. we are no longer
   *  guessing. Screens wait on this before evicting a user from a step. */
  resolved: boolean;
  /** Re-read now (coalesced). */
  recheck: () => void;
}

/**
 * How one BUSINESS PROCESS in one copy stands against its own main.
 *
 * THE single definition of "behind main" in this app, and deliberately so.
 * Each business process is its own git repository with its own main, so a copy
 * is never simply "21 commits behind" — it is behind on `test33` and level on
 * `e2eflow1`. There used to be two readings: a copy-wide `/behind` feeding the
 * Sync step and this per-process one feeding the Deploy gate. They disagreed
 * exactly as you would expect, and a user reported it twice over: a Sync step
 * offered while they were on a business process that was perfectly up to date,
 * listing a different process's commits as what would arrive.
 *
 * So the Sync step and the Deploy gate are now the same fact asked twice, read
 * ONCE — this hook is instantiated by the shell and handed to both, so they
 * cannot drift apart even by a render.
 *
 *   Sync step exists  <=>  behind_bp > 0
 *   Deploy available  <=>  behind_bp === 0   (a publish must be a fast-forward)
 *
 * WHEN it re-reads is load-bearing. Our own edits are not the only thing that
 * moves it: main moves when SOMEONE ELSE deploys, and nothing local changes
 * when they do. Watching only [copy, bp] left the Deploy screen offering a
 * button 45s after a colleague had published. So it takes the `copies` SSE
 * snapshot (its identity changes on every git event, including main's refs
 * moving), any deploy completing, and an explicit nonce for the user's own
 * actions.
 *
 * A read that FAILS is reported as an error, never as zero: "we could not find
 * out" and "you have nothing to pull" are different answers and the callers
 * treat them differently.
 *
 * @param copy The copy to measure, or null to measure nothing.
 * @param bp   The business process directory slug, or null.
 * @param nonce Bump to force a re-read after one of the user's own git actions.
 */
export function useBpDivergence(
  // eslint-disable-next-line no-restricted-syntax -- null = nothing to measure
  copy: string | null,
  // eslint-disable-next-line no-restricted-syntax -- null = nothing to measure
  bp: string | null,
  nonce = 0,
): BpDivergenceReading {
  // eslint-disable-next-line no-restricted-syntax -- null = not known yet
  const [divergence, setDivergence] = useState<BpDivergence | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- null = no error
  const [error, setError] = useState<string | null>(null);
  // The (copy, bp) the in-flight read is about; a late answer for a pair we
  // have since left is discarded rather than shown against the new one.
  const targetRef = useRef<string>('');
  const runningRef = useRef(false);
  const againRef = useRef(false);
  // Pending re-read after a router blip. One at a time, cancelled when the
  // pair changes or the hook goes away.
  const edgeRetryRef = useRef(0);

  const { copies: copiesSnapshot } = useCopies();
  const deployDone = useDeployDone();
  // Our OWN ref-moving actions, whoever ran them: a pull, a merge-back, a
  // version taken wholesale, a dev revert. The `copies` snapshot says the same
  // thing eventually, and "eventually" is exactly the bug — a hotpatch taken
  // from the Deployments tab left this screen reporting 0 ahead over a copy
  // that was one commit ahead on the server.
  const { copyRefsMoved } = useCopyRefsMoved();

  // One string, so the pair is a single dependency AND a single "is this
  // answer still about what I asked?" comparison. A space can occur in neither
  // a copy name nor a business-process directory (both are validated
  // server-side against `[A-Za-z0-9._-]`), so it is an unambiguous separator.
  const key = copy && bp ? `${copy} ${bp}` : '';

  const recheck = useCallback(() => {
    const target = targetRef.current;
    if (!target) return;
    if (runningRef.current) {
      // Collapse any number of triggers during a read into ONE follow-up read,
      // so a burst of git events can't queue a burst of requests.
      againRef.current = true;
      return;
    }
    runningRef.current = true;
    const run = (k: string) => {
      const [c = '', b = ''] = k.split(' ');
      api.copyFiles
        .divergence(c, b)
        .then((d) => {
          if (targetRef.current !== k) return;
          // KEEP THE PREVIOUS OBJECT when the answer is unchanged. This read
          // is re-taken on every `copies` SSE event, and it lives in the shell
          // (the Sync step's existence depends on it, whatever tab you are
          // on), so a fresh object each time re-rendered the ENTIRE app at the
          // rate git events arrive. Live effect: the Advanced popover was
          // re-created under the pointer often enough that clicking a row in
          // it failed — "element is not stable", then detached. The answer is
          // five numbers; when they are the same, nothing happened.
          setDivergence((prev) => (sameDivergence(prev, d) ? prev : d));
          setError(null);
        })
        .catch((err: unknown) => {
          if (targetRef.current !== k) return;
          // An expired session is surfaced app-wide by the re-login banner;
          // the previous reading stands until the user is back.
          if (err instanceof SessionExpiredError) return;
          // Nor does the workspace router failing to reach us say anything
          // about git. Creating a business process starts containers, which
          // reconfigures Traefik, and a read caught in that window came back
          // as "Couldn't read whether main has changes bp hasn't pulled yet:
          // 404 page not found" — a frightening claim about the user's work,
          // made out of a routing hiccup (bailey-lab #362). The api layer has
          // already retried it; if it is STILL not routed, hold the last
          // reading and wait for the next re-read. This hook re-reads on every
          // git event and on every visit to a screen that needs it, so there
          // is always a next one — and on a FIRST read there is nothing to
          // hold, so ask again on a timer rather than spinning forever.
          if (err instanceof EdgeUnavailableError) {
            window.clearTimeout(edgeRetryRef.current);
            edgeRetryRef.current = window.setTimeout(
              () => recheckRef.current(),
              EDGE_RECHECK_MS,
            );
            return;
          }
          setDivergence(null);
          setError(errorMessage(err));
        })
        .finally(() => {
          const next = againRef.current ? targetRef.current : '';
          againRef.current = false;
          if (next) {
            run(next);
            return;
          }
          runningRef.current = false;
        });
    };
    run(target);
  }, []);

  // `recheck` is stable, but the edge-retry timer above is armed from inside
  // it — reading it through a ref keeps that self-reference out of its own
  // dependency list.
  const recheckRef = useRef(recheck);
  recheckRef.current = recheck;

  // Changing copy OR business process invalidates the reading: the old pair's
  // count says nothing about the new one, so drop it rather than showing it
  // for a beat against the wrong process.
  useEffect(() => {
    targetRef.current = key;
    window.clearTimeout(edgeRetryRef.current);
    setDivergence(null);
    setError(null);
  }, [key]);

  useEffect(() => () => window.clearTimeout(edgeRetryRef.current), []);

  // So does one of OUR OWN actions moving the refs. Whatever we are holding is
  // an answer about the world before it, and the user is standing there waiting
  // for the result — so the screen must go back to saying it is checking rather
  // than present the pre-action answer as current. Live consequence of not
  // doing this: take a version from the Deployments tab, open Deploy, and be
  // told the copy is up to date over the commit that was just made.
  //
  // Deliberately NOT done for the `copies` snapshot: that changes on every git
  // event anywhere in the workspace, and blanking the reading each time would
  // replace a stale answer with an unreadable one. This fires only on discrete
  // things this user did.
  const refsMovedAtMount = useRef(copyRefsMoved);
  useEffect(() => {
    if (copyRefsMoved === refsMovedAtMount.current) return;
    setDivergence(null);
    setError(null);
  }, [copyRefsMoved]);

  useEffect(() => {
    recheck();
  }, [recheck, key, copiesSnapshot, deployDone, copyRefsMoved, nonce]);

  return {
    divergence,
    error,
    resolved: key === '' || divergence !== null || error !== null,
    recheck,
  };
}

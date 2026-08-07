import { useCallback, useEffect, useRef, useState } from 'react';
import { useCopies, useCopyRefsMoved } from '@/components/workspace/WorkspaceProvider';
import { api, errorMessage, type ChangedFile } from '@/lib/api';
import { SessionExpiredError } from '@/lib/session';

/** Two change lists that say the same thing. Compared by value so an unchanged
 *  answer can be dropped rather than re-rendered — see `setChanged` below. */
function sameChanged(a: ChangedFile[], b: ChangedFile[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => {
      const y = b[i];
      return (
        !!y &&
        x.path === y.path &&
        x.kind === y.kind &&
        x.adds === y.adds &&
        x.dels === y.dels
      );
    })
  );
}

interface Result {
  changed: ChangedFile[];
  /** True until we have either a list or an error. `changed` is `[]` while
   *  this is true and that MUST NOT be read as "nothing has changed". */
  loading: boolean;
  /** Why the last read failed. Empty = `changed` is trustworthy. */
  error: string;
  refresh: () => Promise<void>;
}

/**
 * Per-copy uncommitted change list (paths + A/M/D + +adds/−dels).
 *
 * WHEN it re-reads is load-bearing, and getting it wrong produced a bug users
 * hit constantly: edit the Description, press save, open Deploy — and Deploy
 * said "All deployed and up to date" over work that was sitting uncommitted in
 * the copy. Two causes, both fixed here.
 *
 * 1. It read ONCE, at mount, and then only on window focus. A save is not a
 *    git event, so nothing else was ever going to move it — and the save
 *    request can still be in flight when the Deploy screen mounts and asks, so
 *    even the mount-time read can legitimately answer "clean" a moment before
 *    the file lands. So callers pass a `nonce` they bump on their own edits,
 *    and the `copies` snapshot is watched for everybody else's.
 * 2. A FAILED read was swallowed and left `changed` as `[]` — indistinguishable
 *    from a clean copy, and rendered as one. Failures are now reported, and
 *    `loading` marks the window where the answer is not known yet, so no
 *    screen can present "we have not looked" as "there is nothing there".
 */
export function useCopyStatus(copy: string, nonce = 0): Result {
  const [changed, setChanged] = useState<ChangedFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const aliveRef = useRef(true);
  // A late answer for a copy we have since left must not be shown against the
  // new one.
  const copyRef = useRef(copy);
  copyRef.current = copy;

  const { copies: copiesSnapshot } = useCopies();
  const { copyRefsMoved } = useCopyRefsMoved();

  const refresh = useCallback(async () => {
    const asked = copyRef.current;
    try {
      const r = await api.copyFiles.status(asked);
      if (!aliveRef.current || copyRef.current !== asked) return;
      // KEEP THE PREVIOUS ARRAY when the answer is unchanged. This is re-read
      // on every `copies` SSE event, and a fresh array each time re-renders
      // every screen derived from it at the rate git events arrive — which
      // during a deploy is constantly. The divergence reading learned the same
      // lesson the hard way (elements re-created under the pointer, clicks
      // landing on detached nodes); when the files are the same, nothing
      // happened.
      setChanged((prev) => (sameChanged(prev, r.changed) ? prev : r.changed));
      setError('');
    } catch (err) {
      if (!aliveRef.current || copyRef.current !== asked) return;
      // An expired session is surfaced app-wide by the re-login banner; the
      // previous reading stands until the user is back.
      if (err instanceof SessionExpiredError) return;
      setError(errorMessage(err));
    } finally {
      if (aliveRef.current && copyRef.current === asked) setLoading(false);
    }
  }, [copy]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Only the FIRST read for a given copy is a "loading" state. Re-reads happen
  // on every git event, and resetting `loading` each time would flicker the
  // Deploy screen back to "Checking this against main…" at the rate events
  // arrive — replacing a wrong answer with an unreadable one. The previous
  // list stands until a newer one replaces it.
  useEffect(() => {
    setLoading(true);
  }, [copy]);
  // …and after one of our own ref-moving actions, for the same reason the
  // divergence reading drops its answer there: what we hold describes the copy
  // before the action, and the user is waiting to see the result of it.
  const refsMovedAtMount = useRef(copyRefsMoved);
  useEffect(() => {
    if (copyRefsMoved === refsMovedAtMount.current) return;
    setLoading(true);
  }, [copyRefsMoved]);
  useEffect(() => {
    void refresh();
  }, [refresh, copiesSnapshot, copyRefsMoved, nonce]);

  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  return { changed, loading, error, refresh };
}

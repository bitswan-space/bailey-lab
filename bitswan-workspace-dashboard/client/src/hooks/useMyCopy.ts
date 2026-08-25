import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/**
 * The signed-in user's OWN copy name, resolved once per page load.
 *
 * The shell already resolves this for its own use, but screens far from it —
 * the Deployments tab, and the Inspect modal inside it — need it too, and
 * threading it through five layers of props to reach a modal is how a prop
 * ends up stale in one of them. `/api/me` is idempotent and the answer never
 * changes within a session, so it is cached at module scope: every caller
 * after the first gets it without a request.
 *
 * Empty string means "not resolved yet" — never "no copy". Anything that would
 * write into the copy must wait for a real name rather than guessing one.
 */
// eslint-disable-next-line no-restricted-syntax -- null = not fetched yet
let cached: Promise<string> | null = null;

function resolveMyCopy(): Promise<string> {
  if (!cached) {
    cached = api
      .getMe()
      .then((me) => me?.copy ?? '')
      .catch(() => {
        // A failed read is not an answer: drop the cache so the next mount
        // retries instead of pinning "no copy" for the rest of the session.
        cached = null;
        return '';
      });
  }
  return cached;
}

export function useMyCopy(): string {
  const [copy, setCopy] = useState('');
  useEffect(() => {
    let alive = true;
    void resolveMyCopy().then((c) => {
      if (alive) setCopy(c);
    });
    return () => {
      alive = false;
    };
  }, []);
  return copy;
}

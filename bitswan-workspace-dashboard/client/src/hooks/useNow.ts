import { useEffect, useState } from 'react';

/**
 * The dashboard renders a lot of relative timestamps ("2 minutes ago") across
 * unrelated panels. Giving each one its own `setInterval` would mean dozens of
 * timers and a re-render storm; instead every consumer subscribes to ONE
 * module-level clock that only runs while something is actually watching it.
 */

/**
 * Relative labels are minute-grained and the "just now" window is 45s, so a
 * 30s tick keeps every label within one step of the truth.
 */
const TICK_MS = 30_000;

const listeners = new Set<(now: number) => void>();
// eslint-disable-next-line no-restricted-syntax -- undefined = clock not running
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(fn: (now: number) => void): () => void {
  listeners.add(fn);
  if (timer === undefined) {
    timer = setInterval(() => {
      const now = Date.now();
      for (const listener of listeners) listener(now);
    }, TICK_MS);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/**
 * A `Date.now()` that re-renders the component every {@link TICK_MS}. Feed it
 * to `formatRelative`/`formatDate` as `now` so labels age on screen.
 */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => subscribe(setNow), []);
  return now;
}

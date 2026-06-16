import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

// Module-level cache keyed by `${bpId}|${copy ?? ''}`. Storing the
// in-flight Promise (rather than the resolved value) makes concurrent
// callers for the same target share a single fetch. READMEs rarely change
// during a session — call `invalidateReadme(...)` after edits if that ever
// ships.
// eslint-disable-next-line no-restricted-syntax -- API resolves to null when no README exists
const cache = new Map<string, Promise<string | null>>();
// Resolved cache, mirrored from `cache` so we can render synchronously on a
// hit (no loading flicker when switching back to a previously-viewed BP).
// eslint-disable-next-line no-restricted-syntax -- same
const resolved = new Map<string, string | null>();

const cacheKey = (bpId: string, copy?: string) =>
  `${bpId}|${copy ?? ''}`;

/** Drop the cached entry for `(bpId, copy)` so the next consumer refetches. */
export function invalidateReadme(bpId: string, copy?: string): void {
  const k = cacheKey(bpId, copy);
  cache.delete(k);
  resolved.delete(k);
}

/**
 * Fetch a BP's `README.md` over `/api/business-processes/:id/readme`.
 * Resolves to `null` when the file is missing or the request fails.
 *
 * When `copy` is given, reads the copy's copy of the README
 * (`copies/<wt>/<bp>/README.md`); otherwise reads the main repo's
 * copy. Results are cached per-(bp, copy) so view switches don't
 * refetch and the deployments / copy scopes get their own cached
 * snapshots.
 */
export function useReadme(
  // eslint-disable-next-line no-restricted-syntax -- null = "no README" / "no BP selected"
  bpId: string | null | undefined,
  copy?: string,
): {
  // eslint-disable-next-line no-restricted-syntax -- null = "no README" / "no BP selected"
  content: string | null;
  loading: boolean;
} {
  const key = bpId ? cacheKey(bpId, copy) : null;
  // eslint-disable-next-line no-restricted-syntax -- mirrors cache shape
  const [content, setContent] = useState<string | null>(() =>
    key ? resolved.get(key) ?? null : null,
  );
  const [loading, setLoading] = useState<boolean>(() =>
    !!key && !resolved.has(key),
  );

  useEffect(() => {
    if (!bpId || !key) {
      setContent(null);
      setLoading(false);
      return;
    }
    if (resolved.has(key)) {
      setContent(resolved.get(key) ?? null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    let promise = cache.get(key);
    if (!promise) {
      promise = api.readme(bpId, copy).catch(() => null);
      cache.set(key, promise);
      promise.then((c) => resolved.set(key, c));
    }
    setLoading(true);
    promise.then((c) => {
      if (cancelled) return;
      setContent(c);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [bpId, copy, key]);

  return { content, loading };
}

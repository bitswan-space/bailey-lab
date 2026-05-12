import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

// Module-level cache keyed by bp id. Storing the in-flight Promise (rather
// than the resolved value) makes concurrent callers for the same id share a
// single fetch. READMEs rarely change during a session — call
// `invalidateReadme(bpId)` after edits if that ever ships.
// eslint-disable-next-line no-restricted-syntax -- API resolves to null when no README exists
const cache = new Map<string, Promise<string | null>>();
// Resolved cache, mirrored from `cache` so we can render synchronously on a
// hit (no loading flicker when switching back to a previously-viewed BP).
// eslint-disable-next-line no-restricted-syntax -- same
const resolved = new Map<string, string | null>();

/** Drop the cached entry for `bpId` so the next consumer refetches. */
export function invalidateReadme(bpId: string): void {
  cache.delete(bpId);
  resolved.delete(bpId);
}

/**
 * Fetch a BP's `README.md` over `/api/business-processes/:id/readme`.
 * Resolves to `null` when the file is missing or the request fails.
 * Results are cached across mounts so view switches don't refetch.
 */
// eslint-disable-next-line no-restricted-syntax -- null = "no README" / "no BP selected"
export function useReadme(bpId: string | null | undefined): {
  content: string | null;
  loading: boolean;
} {
  // eslint-disable-next-line no-restricted-syntax -- mirrors cache shape
  const [content, setContent] = useState<string | null>(() =>
    bpId ? resolved.get(bpId) ?? null : null,
  );
  const [loading, setLoading] = useState<boolean>(() =>
    !!bpId && !resolved.has(bpId),
  );

  useEffect(() => {
    if (!bpId) {
      setContent(null);
      setLoading(false);
      return;
    }
    if (resolved.has(bpId)) {
      setContent(resolved.get(bpId) ?? null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    let promise = cache.get(bpId);
    if (!promise) {
      promise = api.readme(bpId).catch(() => null);
      cache.set(bpId, promise);
      promise.then((c) => resolved.set(bpId, c));
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
  }, [bpId]);

  return { content, loading };
}

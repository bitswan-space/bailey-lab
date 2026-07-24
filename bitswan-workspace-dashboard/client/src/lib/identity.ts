import { useEffect, useState } from 'react';

/**
 * Identity display for a per-user copy. A copy is named after the owner's email
 * sanitized into a slug (lossy — can't be reversed), so we resolve the real
 * name/avatar from the AOC identity directory, which forward-matches the slug
 * against real users. The AOC API is the sibling `api.<base>` host (the SPA
 * derives it from its own location the same way the server console does).
 *
 * A resolved identity (non-empty email) means the slug matched a real user —
 * i.e. it's a per-user copy. An unresolved one is a custom (manually named) copy.
 */
export type Identity = { email: string; name: string; avatar: string | null };

const EMPTY: Identity = { email: '', name: '', avatar: null };

function aocApiBase(): string {
  const host = window.location.hostname.replace(/^[^.]+\./, 'api.');
  return `${window.location.protocol}//${host}`;
}

const cache: Record<string, Identity | Promise<Identity>> = {};

/** Resolve (and cache) a copy slug → owner identity. */
function fetchIdentity(slug: string): Promise<Identity> {
  const cached = cache[slug];
  if (cached) return cached instanceof Promise ? cached : Promise.resolve(cached);
  const p = fetch(
    `${aocApiBase()}/api/frontend/directory?copy=${encodeURIComponent(slug)}`,
  )
    .then((r) => (r.ok ? (r.json() as Promise<Identity>) : null))
    .catch(() => null)
    .then((d) => {
      if (d) {
        // Cache successful lookups — including the AOC's negative answer
        // ({email: ''}), which genuinely means "custom copy".
        cache[slug] = d;
        return d;
      }
      // A network/HTTP failure is NOT a negative answer: caching it would pin
      // this copy as a mono slug under "Custom copies" until a full page
      // reload. Drop the in-flight entry so the next mount retries.
      delete cache[slug];
      return EMPTY;
    });
  cache[slug] = p;
  return p;
}

/** Resolve one copy slug → owner identity (module-cached), or null while loading. */
export function useCopyIdentity(
  // eslint-disable-next-line no-restricted-syntax -- null = no copy
  slug: string | null | undefined,
): Identity | null {
  // eslint-disable-next-line no-restricted-syntax -- null = unresolved
  const [info, setInfo] = useState<Identity | null>(null);
  useEffect(() => {
    if (!slug) {
      setInfo(null);
      return;
    }
    let alive = true;
    void fetchIdentity(slug).then((v) => {
      if (alive) setInfo(v);
    });
    return () => {
      alive = false;
    };
  }, [slug]);
  return info;
}

/** Resolve a set of copy slugs → { slug: identity }. Entries appear as they load. */
export function useCopyIdentities(slugs: string[]): Record<string, Identity> {
  const [map, setMap] = useState<Record<string, Identity>>({});
  const key = slugs.join('|');
  useEffect(() => {
    let alive = true;
    for (const slug of slugs) {
      if (!slug) continue;
      void fetchIdentity(slug).then((v) => {
        if (alive) setMap((m) => (m[slug] === v ? m : { ...m, [slug]: v }));
      });
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by joined slugs
  }, [key]);
  return map;
}

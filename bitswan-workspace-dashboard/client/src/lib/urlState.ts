import { useCallback, useSyncExternalStore } from 'react';

/**
 * A tiny URL-query-string store so the dashboard is fully deep-linkable:
 * every navigational selection (tab, copy, business process) and every
 * page-state (deployments stage/section, agent sub-tab, open file, the
 * Inspect modal, open dialogs, …) lives in `?key=value` params. Copy the
 * URL, open it in a new tab, and you land on the exact same view.
 *
 * No router dependency — we drive `window.history` directly and expose a
 * `useSyncExternalStore`-backed hook so components re-render when the
 * query string changes (including browser back/forward via `popstate`).
 */

const listeners = new Set<() => void>();
let installed = false;

function ensureInstalled() {
  if (installed) return;
  installed = true;
  // Back/forward and any external history change must refresh subscribers.
  window.addEventListener('popstate', emit);
}

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  ensureInstalled();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Read a single query param right now (outside React). */
export function getUrlParam(key: string): string | null {
  return new URLSearchParams(window.location.search).get(key);
}

/**
 * Patch the query string. `null`/`''`/`undefined` values delete the key.
 * No-ops when nothing actually changes (so it's safe to call from effects).
 * `replace` (default) keeps the back button clean; `push` adds history.
 */
export function setUrlParams(
  updates: Record<string, string | null | undefined>,
  opts: { push?: boolean } = {},
): void {
  const sp = new URLSearchParams(window.location.search);
  let changed = false;
  for (const [key, value] of Object.entries(updates)) {
    const cur = sp.get(key);
    if (value == null || value === '') {
      if (cur !== null) {
        sp.delete(key);
        changed = true;
      }
    } else if (cur !== value) {
      sp.set(key, value);
      changed = true;
    }
  }
  if (!changed) return;
  const qs = sp.toString();
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  if (opts.push) window.history.pushState(null, '', url);
  else window.history.replaceState(null, '', url);
  emit();
}

type SetParam = (value: string | null, opts?: { push?: boolean }) => void;

/**
 * Bind one query param to state. Returns `[value, setValue]`; `value`
 * tracks the URL (so back/forward and external writes update it), and
 * `setValue(null)` removes the param.
 */
export function useUrlParam(key: string): readonly [string | null, SetParam] {
  const value = useSyncExternalStore(
    subscribe,
    () => new URLSearchParams(window.location.search).get(key),
    () => null,
  );
  const set = useCallback<SetParam>(
    (v, opts) => setUrlParams({ [key]: v }, opts),
    [key],
  );
  return [value, set] as const;
}

/**
 * Like `useUrlParam` but constrained to a fixed set of string-literal
 * values, with a fallback when the param is absent or unrecognised. Ideal
 * for tab/section/stage enums.
 */
export function useUrlEnum<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): readonly [T, (value: T, opts?: { push?: boolean }) => void] {
  const [raw, setRaw] = useUrlParam(key);
  const value = raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
  const set = useCallback(
    (v: T, opts?: { push?: boolean }) => setRaw(v === fallback ? null : v, opts),
    [setRaw, fallback],
  );
  return [value, set] as const;
}

/** A boolean query flag — present-and-"1" is true. */
export function useUrlFlag(
  key: string,
): readonly [boolean, (value: boolean, opts?: { push?: boolean }) => void] {
  const [raw, setRaw] = useUrlParam(key);
  const set = useCallback(
    (v: boolean, opts?: { push?: boolean }) => setRaw(v ? '1' : null, opts),
    [setRaw],
  );
  return [raw === '1', set] as const;
}

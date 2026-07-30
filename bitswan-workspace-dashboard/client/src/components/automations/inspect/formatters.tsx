/**
 * Render a container timestamp.
 *
 * `docker inspect` reports `Created` as an RFC3339 string
 * (`2026-07-30T09:12:44.123456789Z`), but the container-LIST shape gitops falls
 * back to reports it as Unix **seconds**. `new Date(n)` reads a bare number as
 * *milliseconds*, so a seconds value renders as January 1970 (#265) — the
 * seconds→ms conversion lives here, the single point where a container
 * timestamp becomes a rendered string.
 */
export function formatTimestamp(v: string | number | undefined | null): string | null {
  if (v === undefined || v === null || v === '') return null;
  const trimmed = typeof v === 'string' ? v.trim() : v;
  // A bare integer (or an integer-as-string) is Unix seconds, never ms — docker
  // never sends epoch millis. 0 is docker's "unset", not 1970-01-01.
  const seconds =
    typeof trimmed === 'number'
      ? trimmed
      : /^\d+$/.test(trimmed)
        ? Number(trimmed)
        : null;
  if (seconds === 0) return null;
  const d = seconds !== null ? new Date(seconds * 1000) : new Date(trimmed);
  if (Number.isNaN(d.getTime())) return typeof v === 'string' ? v : null;
  return d.toLocaleString();
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function mono(s: string | undefined | null) {
  return s ? <span className="font-mono">{s}</span> : null;
}

/**
 * A field that is legitimately empty or doesn't apply to this container —
 * "none", "not running", "host network". Reads as an answer, not as a gap.
 */
export function muted(text: string) {
  return <span className="text-muted-foreground">{text}</span>;
}

/**
 * A field we could not read at all: the container's `docker inspect` failed, or
 * it vanished and only the container-list record survived. Italic so it can't be
 * mistaken for a real empty value — a bare `—` made "we failed to fetch this"
 * and "not applicable" look identical (#265).
 */
export function unavailable(text = 'unavailable') {
  return <span className="italic text-muted-foreground">{text}</span>;
}

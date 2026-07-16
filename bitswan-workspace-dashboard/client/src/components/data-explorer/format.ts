/** Formatting helpers shared by the data-explorer panels. */

/** Human-readable byte size ("—" for absent values, e.g. folders). */
// eslint-disable-next-line no-restricted-syntax -- wire-mirror nullable input
export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Locale timestamp from an ISO string ("—" when absent/unparsable). */
// eslint-disable-next-line no-restricted-syntax -- wire-mirror nullable input
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

/** Planner row estimate: -1 = never analyzed. */
// eslint-disable-next-line no-restricted-syntax -- wire-mirror nullable input
export function fmtRowEstimate(n: number | null | undefined): string {
  if (n == null || n < 0) return '—';
  return `~${n.toLocaleString()}`;
}

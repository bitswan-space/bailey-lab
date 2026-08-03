/**
 * One shared presentation for every date the dashboard renders.
 *
 * Wire timestamps arrive as ISO-8601 with an explicit offset
 * ("2026-07-31T07:00:28+00:00"). Rendering them verbatim turned the deployment
 * history — and half a dozen other panels — into a wall of machine timestamps
 * (#313). Every date now renders as a short RELATIVE label with the full
 * ABSOLUTE instant one hover away.
 *
 * The absolute form is always **UTC**, explicitly labelled. These are
 * audit-trail timestamps: they are read by a distributed team, quoted in
 * incident write-ups, and cross-checked against server logs — all of which are
 * UTC. A browser-local rendering would mean two people looking at the same
 * deployment history disagree about when it happened, with nothing on screen to
 * explain the difference.
 *
 * Relative labels are computed against a caller-supplied `now`. Pass the shared
 * ticking clock (`useNow`) so labels stay fresh without a timer per timestamp.
 */

/** What the UI shows in place of a missing / unparsable / zero timestamp. */
export const NO_DATE = '—';

/**
 * Unset timestamps reach the UI as the Unix epoch (0) or Go's zero time
 * (0001-01-01). Both are "no value", not "56 years ago" — anything older than
 * this is treated as absent.
 */
const MIN_REAL_MS = Date.UTC(1971, 0, 1);

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Below this, "just now" is more honest than a rounded minute count. */
const JUST_NOW_MS = 45 * SECOND;

/**
 * Past this, the calendar date beats a relative label: "37 days ago" makes the
 * reader do arithmetic, "Jun 24" does not.
 */
const CALENDAR_CUTOFF_MS = 7 * DAY;

// eslint-disable-next-line no-restricted-syntax -- wire-mirror nullable input
type Nullish = null | undefined;

/** Anything a wire field might hand us: an ISO string, epoch ms, or a Date. */
export type WhenInput = string | number | Date | Nullish;

const RELATIVE_FMT = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

const ABSOLUTE_FMT = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
});

const CALENDAR_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

const CALENDAR_YEAR_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

/**
 * Epoch milliseconds for a wire value, or `undefined` when there is no real
 * date to show. Every other function here funnels through this, so a bad value
 * can never reach `Intl` and surface as "Invalid Date".
 */
// eslint-disable-next-line no-restricted-syntax -- undefined = no usable date
export function parseWhen(value: WhenInput): number | undefined {
  if (value == null || value === '') return undefined;
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'number'
        ? value
        : Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  if (ms < MIN_REAL_MS) return undefined;
  return ms;
}

/** True when the value is a real, renderable timestamp. */
export function hasWhen(value: WhenInput): boolean {
  return parseWhen(value) !== undefined;
}

/**
 * The full instant, in UTC, unambiguous: "Jul 31, 2026, 7:00:28 AM UTC".
 * This is the hover/`title` form — empty string when there is no date, so
 * callers can drop the tooltip entirely rather than show an empty one.
 */
export function formatAbsolute(value: WhenInput): string {
  const ms = parseWhen(value);
  return ms === undefined ? '' : ABSOLUTE_FMT.format(ms);
}

/** "Jul 31" — or "Jun 24, 2025" once the year differs from the reference. */
function formatCalendar(ms: number, nowMs: number): string {
  const sameYear = new Date(ms).getUTCFullYear() === new Date(nowMs).getUTCFullYear();
  return (sameYear ? CALENDAR_FMT : CALENDAR_YEAR_FMT).format(ms);
}

export interface RelativeOptions {
  /**
   * 'long' (default) → "2 minutes ago". 'short' → "2m ago", for dense
   * timelines where the column has to stay narrow.
   */
  variant?: 'long' | 'short';
  /** Reference instant. Defaults to now; pass `useNow()` to keep labels fresh. */
  now?: number;
}

function shortLabel(past: boolean, n: number, unit: string): string {
  return past ? `${n}${unit} ago` : `in ${n}${unit}`;
}

/**
 * "just now" / "2 minutes ago" / "3 hours ago" / "yesterday" — and the plain
 * calendar date once the value is more than a week away in either direction.
 *
 * Future values are not an error: a slow clock on either end routinely puts a
 * fresh timestamp a few seconds ahead, and the "just now" window absorbs that.
 */
export function formatRelative(value: WhenInput, options: RelativeOptions = {}): string {
  const ms = parseWhen(value);
  if (ms === undefined) return NO_DATE;
  const now = options.now ?? Date.now();
  const short = options.variant === 'short';
  const diff = now - ms;
  const abs = Math.abs(diff);
  const past = diff > 0;
  const sign = past ? -1 : 1;

  if (abs < JUST_NOW_MS) return 'just now';
  // Both directions: an ISO date a year in the future is a data problem, and
  // "in 412 days" reads like a feature.
  if (abs >= CALENDAR_CUTOFF_MS) return formatCalendar(ms, now);
  if (abs < 60 * MINUTE) {
    const mins = Math.round(abs / MINUTE);
    return short ? shortLabel(past, mins, 'm') : RELATIVE_FMT.format(sign * mins, 'minute');
  }
  if (abs < 22 * HOUR) {
    const hrs = Math.round(abs / HOUR);
    return short ? shortLabel(past, hrs, 'h') : RELATIVE_FMT.format(sign * hrs, 'hour');
  }
  const days = Math.round(abs / DAY);
  return short ? shortLabel(past, days, 'd') : RELATIVE_FMT.format(sign * days, 'day');
}

export interface DateLabel {
  /** The text to render. `NO_DATE` when there is no usable timestamp. */
  label: string;
  /** Full UTC instant for a `title` tooltip; '' when there is no timestamp. */
  title: string;
}

/**
 * The pair the UI almost always wants: what to show, and what to reveal on
 * hover.
 */
export function formatDate(value: WhenInput, options: RelativeOptions = {}): DateLabel {
  return { label: formatRelative(value, options), title: formatAbsolute(value) };
}

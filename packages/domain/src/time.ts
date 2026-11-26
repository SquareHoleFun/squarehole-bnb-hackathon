/**
 * Deterministic time helpers. "Now" is always injected (demo: the snapshot `asOf`, ADR-0003 "Clock"); nothing here
 * reads the wall clock. Timestamps become JavaScript numbers only after strict parsing and range checks.
 *
 * Accepted format (stricter than RFC 3339 / JSON Schema `date-time`, on purpose):
 *   YYYY-MM-DDTHH:MM:SS[.f{1,3}](Z|+HH:MM|-HH:MM)
 * Uppercase `T`/`Z` only, no leap second, at most millisecond precision (so sort keys are exact in JS).
 */
import { TimeError } from './errors';

const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1] ?? 0;
}

function tryParse(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = ISO_PATTERN.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, fraction = '', zulu, sign, offH = '0', offM = '0'] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  const offsetHours = Number(offH);
  const offsetMinutes = Number(offM);
  const valid =
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    (zulu !== undefined || (offsetHours <= 23 && offsetMinutes <= 59));
  if (!valid) return null;
  const millis = Number(fraction.padEnd(3, '0'));
  // setUTCFullYear avoids Date.UTC's mapping of years 0-99 onto 1900-1999.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millis);
  const offsetMs = (offsetHours * 60 + offsetMinutes) * MINUTE_MS * (sign === '-' ? -1 : 1);
  const epochMs = date.getTime() - offsetMs;
  return Number.isFinite(epochMs) ? epochMs : null;
}

export function isIsoTimestamp(value: unknown): value is string {
  return tryParse(value) !== null;
}

/** Epoch milliseconds. Throws `TimeError('malformed_timestamp')`. */
export function parseIsoTimestamp(value: string): number {
  const epochMs = tryParse(value);
  if (epochMs === null) {
    throw new TimeError('malformed_timestamp', 'Expected YYYY-MM-DDTHH:MM:SS[.mmm] with Z or ±HH:MM');
  }
  return epochMs;
}

/** `YYYY-MM-DDTHH:MM:SSZ` (milliseconds only when non-zero), matching the fixture style. */
export function formatIsoUtc(epochMs: number): string {
  if (!Number.isSafeInteger(epochMs)) throw new TimeError('malformed_timestamp', 'Epoch milliseconds must be a safe integer');
  const iso = new Date(epochMs).toISOString();
  return iso.endsWith('.000Z') ? `${iso.slice(0, -5)}Z` : iso;
}

/**
 * Compact launch age relative to an injected `now`: "<1m", "6m", "3h", "2d" (truncated, never rounded up).
 * A launch after `now` is a data error and throws `TimeError('launch_after_now')`.
 */
export function formatAge(launchedAt: string, now: string): string {
  const elapsed = parseIsoTimestamp(now) - parseIsoTimestamp(launchedAt);
  if (elapsed < 0) throw new TimeError('launch_after_now', 'launchedAt is after the injected now');
  if (elapsed < MINUTE_MS) return '<1m';
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`;
  return `${Math.floor(elapsed / DAY_MS)}d`;
}

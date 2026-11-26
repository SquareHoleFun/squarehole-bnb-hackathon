import { describe, expect, it } from 'vitest';
import { DEMO_NOW, TimeError, formatAge, formatIsoUtc, isIsoTimestamp, parseIsoTimestamp } from './index';

const NOW_MS = Date.UTC(2026, 8, 25, 12, 0, 0);

describe('strict ISO-8601 parse', () => {
  it.each([
    ['2026-09-25T12:00:00Z', NOW_MS],
    ['2026-09-25T12:00:00.5Z', NOW_MS + 500],
    ['2026-09-25T12:00:00.123Z', NOW_MS + 123],
    ['2026-09-25T13:00:00+01:00', NOW_MS],
    ['2026-09-25T06:30:00-05:30', NOW_MS],
    ['2024-02-29T00:00:00Z', Date.UTC(2024, 1, 29)],
    ['2000-02-29T00:00:00Z', Date.UTC(2000, 1, 29)],
  ])('parses %s', (value, expected) => {
    expect(parseIsoTimestamp(value)).toBe(expected);
    expect(isIsoTimestamp(value)).toBe(true);
  });

  it('does not map two-digit years onto the 1900s', () => {
    expect(new Date(parseIsoTimestamp('0099-01-01T00:00:00Z')).getUTCFullYear()).toBe(99);
  });

  it.each([
    '',
    '2026-09-25',
    '2026-09-25 12:00:00Z',
    '2026-09-25t12:00:00Z',
    '2026-09-25T12:00:00z',
    '2026-09-25T12:00:00',
    '2026-9-25T12:00:00Z',
    '2026-02-30T00:00:00Z',
    '1900-02-29T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-00-10T00:00:00Z',
    '2026-09-25T24:00:00Z',
    '2026-09-25T12:60:00Z',
    '2026-09-25T12:00:60Z',
    '2026-09-25T12:00:00.1234Z',
    '2026-09-25T12:00:00+0100',
    '2026-09-25T12:00:00+24:00',
    '+2026-09-25T12:00:00Z',
    ' 2026-09-25T12:00:00Z',
  ])('rejects %j', (value) => {
    expect(isIsoTimestamp(value)).toBe(false);
    expect(() => parseIsoTimestamp(value)).toThrow(TimeError);
  });

  it('formats UTC without milliseconds when whole seconds', () => {
    expect(formatIsoUtc(NOW_MS)).toBe(DEMO_NOW);
    expect(formatIsoUtc(NOW_MS - 2 * 3_600_000)).toBe('2026-09-25T10:00:00Z');
    expect(formatIsoUtc(NOW_MS + 7)).toBe('2026-09-25T12:00:00.007Z');
    expect(() => formatIsoUtc(Number.NaN)).toThrow(TimeError);
  });
});

describe('formatAge (deterministic, injected now)', () => {
  it.each([
    ['2026-09-21T12:00:00Z', '4d'],
    ['2026-09-22T12:00:00Z', '3d'],
    ['2026-09-23T12:00:00Z', '2d'],
    ['2026-09-24T06:00:00Z', '1d'],
    ['2026-09-24T18:00:00Z', '18h'],
    ['2026-09-25T07:00:00Z', '5h'],
    ['2026-09-25T09:00:00Z', '3h'],
    ['2026-09-25T11:00:00Z', '1h'],
    ['2026-09-25T11:45:00Z', '15m'],
    ['2026-09-25T11:54:00Z', '6m'],
    ['2026-09-25T11:59:00Z', '1m'],
    ['2026-09-25T11:59:01Z', '<1m'],
    ['2026-09-25T12:00:00Z', '<1m'],
  ])('at DEMO_NOW, launched %s -> %s', (launchedAt, expected) => {
    expect(formatAge(launchedAt, DEMO_NOW)).toBe(expected);
  });

  it('truncates at unit boundaries', () => {
    expect(formatAge('2026-09-25T11:00:01Z', DEMO_NOW)).toBe('59m');
    expect(formatAge('2026-09-24T12:00:01Z', DEMO_NOW)).toBe('23h');
    expect(formatAge('2025-08-21T12:00:00Z', DEMO_NOW)).toBe('400d');
  });

  it('rejects launches after now and malformed input with typed errors', () => {
    try {
      formatAge('2026-09-25T12:00:01Z', DEMO_NOW);
      throw new Error('expected TimeError');
    } catch (error) {
      expect(error).toBeInstanceOf(TimeError);
      expect((error as TimeError).code).toBe('launch_after_now');
    }
    expect(() => formatAge('yesterday', DEMO_NOW)).toThrow(TimeError);
  });
});

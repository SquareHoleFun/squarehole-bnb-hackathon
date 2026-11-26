import type { Provenance } from '@squarehole/domain';
import { describe, expect, it } from 'vitest';
import { fixturePair } from '../../test-support/fixture';
import { hasUsableData, selectNotices, selectPinKind, selectResultsKind, updateAvailable } from './feed-state';

const provenance = (patch: Partial<Provenance> = {}): Provenance => ({
  state: 'mock',
  asOf: '2026-09-25T12:00:00Z',
  source: 'test',
  coverage: 'demo',
  ...patch,
});

describe('selectResultsKind (SH-007 state selection)', () => {
  it('is loading until the first snapshot arrives', () => {
    expect(selectResultsKind({ hasData: false, isError: false, totalMatches: 0, filtersActive: false })).toBe('loading');
  });

  it('is unavailable when the read failed and nothing is cached', () => {
    expect(selectResultsKind({ hasData: false, isError: true, totalMatches: 0, filtersActive: true })).toBe('unavailable');
  });

  it('keeps showing cached rows when a later read fails', () => {
    expect(selectResultsKind({ hasData: true, isError: true, totalMatches: 3, filtersActive: false })).toBe('results');
  });

  it('distinguishes "no launches yet" from "no pairs match"', () => {
    expect(selectResultsKind({ hasData: true, isError: false, totalMatches: 0, filtersActive: false })).toBe('no_launches');
    expect(selectResultsKind({ hasData: true, isError: false, totalMatches: 0, filtersActive: true })).toBe('no_match');
  });

  it('shows results whenever there are organic matches', () => {
    expect(selectResultsKind({ hasData: true, isError: false, totalMatches: 1, filtersActive: true })).toBe('results');
  });
});

describe('hasUsableData (a failed read never hides behind the previous rows)', () => {
  it('uses current data, and a previous query’s rows while the next read is still running', () => {
    expect(hasUsableData({ hasData: true, current: true, isError: false })).toBe(true);
    expect(hasUsableData({ hasData: true, current: false, isError: false })).toBe(true);
  });

  it('treats a failed read (e.g. the reward-assets read) with only placeholder rows as unavailable', () => {
    expect(hasUsableData({ hasData: true, current: false, isError: true })).toBe(false);
    expect(hasUsableData({ hasData: false, current: false, isError: true })).toBe(false);
  });

  it('keeps current rows when a later page failed (load more reports that itself)', () => {
    expect(hasUsableData({ hasData: true, current: true, isError: true })).toBe(true);
  });
});

describe('selectPinKind', () => {
  const root = fixturePair('Square Hole');

  it('follows the snapshot: launched root, unlaunched root (platform === null)', () => {
    expect(selectPinKind({ hasData: true, isError: false, platform: root })).toBe('launched');
    expect(selectPinKind({ hasData: true, isError: false, platform: null })).toBe('unlaunched');
  });

  it('never claims "coming soon" before the snapshot is known', () => {
    expect(selectPinKind({ hasData: false, isError: false, platform: null })).toBe('loading');
    expect(selectPinKind({ hasData: false, isError: true, platform: null })).toBe('unavailable');
  });
});

describe('selectNotices (FEED-06)', () => {
  it('reports nothing for a normal demo snapshot', () => {
    expect(selectNotices(provenance())).toEqual({ stale: null, partial: false });
  });

  it('reports stale data with its as-of time and block', () => {
    expect(selectNotices(provenance({ state: 'stale', asOf: '2026-09-25T10:00:00Z', blockNumber: '4200' }))).toEqual({
      stale: { asOf: '2026-09-25T10:00:00Z', blockNumber: '4200' },
      partial: false,
    });
  });

  it('reports partial coverage from the state or the coverage field', () => {
    expect(selectNotices(provenance({ state: 'partial' })).partial).toBe(true);
    expect(selectNotices(provenance({ coverage: 'partial' })).partial).toBe(true);
  });
});

describe('updateAvailable (ranking updated affordance)', () => {
  it('is true only when the provider holds a different, newer snapshot than the one on screen', () => {
    expect(updateAvailable('a', { snapshotId: 'a', asOf: '2026-09-25T12:00:00Z' })).toBe(false);
    expect(updateAvailable('a', { snapshotId: 'b', asOf: '2026-09-25T12:05:00Z' })).toBe(true);
    expect(updateAvailable(null, { snapshotId: 'b', asOf: '2026-09-25T12:05:00Z' })).toBe(false);
    expect(updateAvailable('a', undefined)).toBe(false);
  });
});

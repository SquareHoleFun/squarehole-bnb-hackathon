import { describe, expect, it } from 'vitest';
import {
  FeedDataError,
  FeedQueryError,
  matchSearch,
  normalizeSearch,
  selectFeed,
  type FeedSort,
  type PairRecord,
} from './index';
import { handoffFixture } from './test-support/handoff';
import { ids, makePair, pid } from './test-support/pairs';

const items = (): PairRecord[] => handoffFixture().items;

describe('selectFeed ordering (FEED-02, FEED-03)', () => {
  it('pins the platform separately and ranks organic rows by market cap, null last', () => {
    const { platform, rows } = selectFeed(items());
    expect(platform?.pairId).toBe(pid('65'));
    expect(ids(rows)).toEqual(['66', '67', '68', '69', '6a', '6b', '6c', '6d', '6e', '6f', '70'].map(pid));
  });

  it('sorts New by launch time descending with pairId tie-break', () => {
    const { rows } = selectFeed(items(), { sort: 'new' });
    expect(ids(rows)).toEqual(['70', '6f', '6e', '6d', '6b', '6c', '6a', '69', '68', '67', '66'].map(pid));
  });

  it('sorts Turnover descending, ties by launch time then pairId, null last', () => {
    const { rows } = selectFeed(items(), { sort: 'turnover' });
    expect(ids(rows)).toEqual(['67', '66', '6a', '68', '69', '6b', '6c', '6e', '6d', '6f', '70'].map(pid));
  });

  it('compares metrics exactly where float64 cannot', () => {
    const rows = [
      makePair('a1', { marketCapUsd: '9007199254740992' }),
      makePair('a2', { marketCapUsd: '9007199254740993' }),
      makePair('a3', { marketCapUsd: '0.3' }),
      makePair('a4', { marketCapUsd: '0.30000000000000000001' }),
    ];
    expect(ids(selectFeed(rows).rows)).toEqual([pid('a2'), pid('a1'), pid('a4'), pid('a3')]);
  });

  it('treats trailing zeros as equal and breaks ties by launch time desc then canonical pairId asc', () => {
    const rows = [
      makePair('b3', { marketCapUsd: '72000', launchedAt: '2026-09-25T07:00:00Z' }),
      makePair('b1', { marketCapUsd: '72000.00', launchedAt: '2026-09-25T07:00:00Z' }),
      makePair('b2', { marketCapUsd: '72000.000', launchedAt: '2026-09-25T08:00:00Z' }),
    ];
    expect(ids(selectFeed(rows).rows)).toEqual([pid('b2'), pid('b1'), pid('b3')]);
  });

  it('sorts a zero metric before unknown (null is never zero)', () => {
    const rows = [makePair('c1', { turnover24hUsd: null }), makePair('c2', { turnover24hUsd: '0' })];
    expect(ids(selectFeed(rows, { sort: 'turnover' }).rows)).toEqual([pid('c2'), pid('c1')]);
  });

  it('rejects an unknown sort with a typed error', () => {
    expect(() => selectFeed(items(), { sort: 'trending' as FeedSort })).toThrow(FeedQueryError);
  });

  it('does not mutate its input and returns fresh arrays', () => {
    const input = items();
    const before = structuredClone(input);
    const { rows } = selectFeed(input, { sort: 'new' });
    expect(input).toEqual(before);
    expect(rows).not.toBe(input);
  });
});

describe('selectFeed identity invariants', () => {
  it('rejects duplicate pair ids, including case-only duplicates', () => {
    const exact = [...items(), makePair('67')];
    const caseOnly = [...items(), makePair('6A')];
    for (const input of [exact, caseOnly]) {
      try {
        selectFeed(input);
        throw new Error('expected FeedDataError');
      } catch (error) {
        expect(error).toBeInstanceOf(FeedDataError);
        expect((error as FeedDataError).code).toBe('duplicate_pair');
      }
    }
  });

  it('rejects a second platform item', () => {
    const input = [...items(), makePair('f1', { isPlatform: true })];
    expect(() => selectFeed(input)).toThrow(expect.objectContaining({ code: 'duplicate_platform' }));
  });

  it('returns a null platform when the root has not launched', () => {
    const { platform, platformMatchesQuery, rows } = selectFeed(items().slice(1));
    expect(platform).toBeNull();
    expect(platformMatchesQuery).toBe(false);
    expect(rows).toHaveLength(11);
  });
});

describe('filters (ADR-0003 lifecycle/rewardSide + reference rewardAddress)', () => {
  it('filters by asset type', () => {
    expect(ids(selectFeed(items(), { type: 'nft_collection' }).rows)).toEqual(['66', '68', '6a', '6c', '6e'].map(pid));
    expect(selectFeed(items(), { type: 'token' }).rows.every((p) => p.type === 'token')).toBe(true);
  });

  it('filters by lifecycle', () => {
    expect(ids(selectFeed(items(), { lifecycle: 'curve' }).rows)).toEqual(['6b', '6c', '6d', '6e', '6f', '70'].map(pid));
    expect(ids(selectFeed(items(), { lifecycle: 'amm' }).rows)).toEqual(['66', '67', '68', '69', '6a'].map(pid));
    expect(selectFeed(items(), { lifecycle: 'graduating' }).rows).toEqual([]);
  });

  it('filters by reward side', () => {
    expect(ids(selectFeed(items(), { rewardSide: 'T' }).rows)).toEqual(['67', '6a', '6d', '6e'].map(pid));
  });

  it('filters by the selected reward asset address (T when R=T, Q when R=Q), case-insensitively', () => {
    const aaplx = '0x0000000000000000000000000000000000002329';
    expect(ids(selectFeed(items(), { rewardAddress: aaplx }).rows)).toEqual(['66', '69', '6c', '70'].map(pid));
    expect(ids(selectFeed(items(), { rewardAddress: '0x00000000000000000000000000000000000003EB' }).rows)).toEqual([pid('67')]);
    expect(selectFeed(items(), { rewardAddress: aaplx, rewardSide: 'T' }).rows).toEqual([]);
    expect(selectFeed(items(), { rewardAddress: '' }).rows).toHaveLength(11);
  });

  it('reports whether the pinned platform itself matches (never inserted into rows)', () => {
    const match = (query: Parameters<typeof selectFeed>[1]) => selectFeed(items(), query).platformMatchesQuery;
    expect(match({})).toBe(true);
    expect(match({ search: 'square' })).toBe(true);
    expect(match({ search: 'orch' })).toBe(false);
    expect(match({ type: 'nft_collection' })).toBe(false);
    expect(match({ lifecycle: 'curve' })).toBe(false);
    expect(match({ rewardSide: 'T' })).toBe(false);
    expect(match({ search: '0x0000000000000000000000000000000000000065' })).toBe(true);
    expect(selectFeed(items(), { search: 'square' }).rows).toEqual([]);
  });
});

describe('search (FEED-04)', () => {
  it('normalises like the reference: trim + case fold', () => {
    expect(normalizeSearch('  OrCh  ')).toBe('orch');
    expect(normalizeSearch('STRAẞE')).toBe('strasse');
    expect(normalizeSearch('ΟΔΟΣ')).toBe('οδοσ');
  });

  it('matches name/symbol substrings case-insensitively', () => {
    expect(ids(selectFeed(items(), { search: 'orch' }).rows)).toEqual([pid('66'), pid('6e')]);
    expect(ids(selectFeed(items(), { search: '  ORCHARD ' }).rows)).toEqual([pid('66'), pid('6e')]);
    expect(ids(selectFeed(items(), { search: 'shape' }).rows)).toEqual([pid('6f')]);
    expect(selectFeed(items(), { search: 'zzz' }).rows).toEqual([]);
  });

  it('matches across the name/symbol boundary exactly like the reference ("NAME SYMBOL")', () => {
    expect(ids(selectFeed(items(), { search: 'orchard orch' }).rows)).toEqual([pid('66')]);
  });

  it('matches exact normalised addresses only (no prefixes)', () => {
    const usdc = '0x000000000000000000000000000000000000232A';
    expect(ids(selectFeed(items(), { search: usdc }).rows)).toEqual(['68', '6b', '6f'].map(pid));
    expect(selectFeed(items(), { search: '0x00000000000000000000000000000000000003e' }).rows).toEqual([]);
  });

  it('labels the match kind for the UI', () => {
    const [, orchard] = items();
    if (!orchard) throw new Error('fixture item 1 missing');
    expect(matchSearch(orchard, '0x00000000000000000000000000000000000003EA')).toBe('token');
    expect(matchSearch(orchard, '0x0000000000000000000000000000000000002329')).toBe('quote');
    expect(matchSearch(orchard, '0x0000000000000000000000000000000000000066')).toBe('pair');
    expect(matchSearch(orchard, '0x00000000000000000000000000000000000007d2')).toBe('mirror');
    expect(matchSearch(orchard, 'chard')).toBe('name');
    expect(matchSearch(orchard, 'ORCH')).toBe('name');
    expect(matchSearch({ ...orchard, name: 'Garden' }, 'orch')).toBe('symbol');
    expect(matchSearch(orchard, 'orchard orch')).toBe('name');
    expect(matchSearch(orchard, 'zzz')).toBeNull();
    expect(matchSearch(orchard, '   ')).toBeNull();
  });

  it('labels an address match even when a hostile name contains that address', () => {
    const [, orchard] = items();
    if (!orchard) throw new Error('fixture item 1 missing');
    const spoof = { ...orchard, name: 'fake 0x0000000000000000000000000000000000002329' };
    expect(matchSearch(spoof, '0x0000000000000000000000000000000000002329')).toBe('quote');
  });
});

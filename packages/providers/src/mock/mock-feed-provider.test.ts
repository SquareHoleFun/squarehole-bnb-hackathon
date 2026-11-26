import { describe, expect, it } from 'vitest';
import { FeedCursorError, FeedQueryError, IdentityError, validateFeedSnapshot, verifyMarketCap } from '@squarehole/domain';
import { createMockFeedProvider } from '../index';
import { ids, pid, query, readAllPages } from '../test-support';

const MARKET_CAP_ORDER = ['66', '67', '68', '69', '6a', '6b', '6c', '6d', '6e', '6f', '70'].map(pid);

describe('mock provider: default scenario', () => {
  it('returns a valid demo snapshot with fixture provenance', async () => {
    const snapshot = await createMockFeedProvider().readFeed(query());
    expect(validateFeedSnapshot(snapshot, { mode: 'demo' })).toEqual(snapshot);
    expect(snapshot.snapshotId).toBe('demo-20260925T120000Z');
    expect(snapshot.provenance).toMatchObject({ state: 'mock', coverage: 'demo', asOf: '2026-09-25T12:00:00Z' });
    expect(snapshot.provenance.source).toMatch(/not market data/);
  });

  it('exposes the demo mode, the scenario and the latest snapshot head', async () => {
    const provider = createMockFeedProvider();
    expect(provider.mode).toBe('demo');
    expect(provider.scenario).toBe('default');
    await expect(provider.latestSnapshot()).resolves.toEqual({ snapshotId: 'demo-20260925T120000Z', asOf: '2026-09-25T12:00:00Z' });
  });

  it('derives reward filter options from the whole snapshot: distinct Q of R=Q organic pairs', async () => {
    const snapshot = await createMockFeedProvider().readFeed(query({ search: 'zzz', limit: 1 }));
    expect(snapshot.items).toEqual([]);
    expect(snapshot.rewardAssets.map((asset) => [asset.symbol, asset.address])).toEqual([
      ['AAPLx-DEMO', '0x0000000000000000000000000000000000002329'],
      ['USDC-DEMO', '0x000000000000000000000000000000000000232a'],
    ]);
  });

  it('returns frozen data so consumers cannot mutate provider state', async () => {
    const snapshot = await createMockFeedProvider().readFeed(query());
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.items)).toBe(true);
    expect(Object.isFrozen(snapshot.items[0]?.token)).toBe(true);
  });
});

describe('FEED-01 platform pinned once, outside results and counts', () => {
  it('pins the platform separately and excludes it from items and totalMatches', async () => {
    const pages = await readAllPages(createMockFeedProvider(), query({ limit: 4 }));
    for (const page of pages) {
      expect(page.platform?.pairId).toBe(pid('65'));
      expect(page.items.some((row) => row.isPlatform || row.pairId === pid('65'))).toBe(false);
      expect(page.totalMatches).toBe(11);
    }
  });

  it('never inserts the platform into matches, even when it matches the search', async () => {
    const snapshot = await createMockFeedProvider().readFeed(query({ search: 'square hole' }));
    expect(snapshot.platformMatchesQuery).toBe(true);
    expect(snapshot.items).toEqual([]);
    expect(snapshot.totalMatches).toBe(0);
    const other = await createMockFeedProvider().readFeed(query({ search: 'orch' }));
    expect(other.platformMatchesQuery).toBe(false);
    expect(other.platform?.pairId).toBe(pid('65'));
  });
});

describe('FEED-02 ordering', () => {
  it('ranks by market cap descending with exact ties and null last', async () => {
    const snapshot = await createMockFeedProvider().readFeed(query());
    expect(ids(snapshot.items)).toEqual(MARKET_CAP_ORDER);
    expect(snapshot.items.at(-1)?.marketCapUsd).toBeNull();
  });

  it('keeps every market cap exactly equal to price x circulating supply', async () => {
    const snapshot = await createMockFeedProvider().readFeed(query());
    for (const pair of [snapshot.platform, ...snapshot.items]) {
      if (pair) expect(verifyMarketCap(pair)).not.toBe('mismatch');
    }
  });

  it('applies search, type, lifecycle and reward filters', async () => {
    const provider = createMockFeedProvider();
    expect(ids((await provider.readFeed(query({ type: 'nft_collection', lifecycle: 'curve' }))).items)).toEqual([pid('6c'), pid('6e')]);
    expect(ids((await provider.readFeed(query({ rewardSide: 'T', sort: 'new' }))).items)).toEqual(['6e', '6d', '6a', '67'].map(pid));
    const aaplx = await provider.readFeed(query({ rewardAddress: '0x0000000000000000000000000000000000002329' }));
    expect(ids(aaplx.items)).toEqual(['66', '69', '6c', '70'].map(pid));
  });
});

describe('FEED-05 stable pagination', () => {
  it.each(['market_cap', 'new', 'turnover'] as const)('every limit 1..13 pages through %s without duplicates or skips', async (sort) => {
    const provider = createMockFeedProvider();
    const full = ids((await provider.readFeed(query({ sort, limit: 100 }))).items);
    expect(full).toHaveLength(11);
    for (let limit = 1; limit <= 13; limit += 1) {
      const pages = await readAllPages(provider, query({ sort, limit }));
      const flat = pages.flatMap((page) => ids(page.items));
      expect(flat).toEqual(full);
      expect(new Set(flat).size).toBe(flat.length);
      expect(new Set(pages.map((page) => page.snapshotId)).size).toBe(1);
    }
  });

  it('rejects cursors from another query, malformed cursors and invalid limits with typed errors', async () => {
    const provider = createMockFeedProvider();
    const first = await provider.readFeed(query({ limit: 2 }));
    const cursor = first.nextCursor ?? undefined;
    await expect(provider.readFeed(query({ limit: 2, cursor, sort: 'new' }))).rejects.toMatchObject({ code: 'query_mismatch' });
    await expect(provider.readFeed(query({ cursor: 'garbage!' }))).rejects.toBeInstanceOf(FeedCursorError);
    await expect(provider.readFeed(query({ limit: 0 }))).rejects.toBeInstanceOf(FeedQueryError);
    await expect(provider.readFeed(query({ snapshotId: 'demo-unknown' }))).rejects.toMatchObject({ code: 'unknown_snapshot' });
  });
});

describe('readPair', () => {
  it('finds organic and platform pairs case-insensitively', async () => {
    const provider = createMockFeedProvider();
    expect((await provider.readPair('31337:0x000000000000000000000000000000000000006A'))?.slug).toBe('tiny-frames');
    expect((await provider.readPair(pid('65')))?.isPlatform).toBe(true);
  });

  it('returns null for unknown pairs, including the same address on another chain', async () => {
    const provider = createMockFeedProvider();
    await expect(provider.readPair(pid('ff'))).resolves.toBeNull();
    await expect(provider.readPair('1:0x0000000000000000000000000000000000000066')).resolves.toBeNull();
  });

  it('rejects a malformed pair id with a typed error', async () => {
    await expect(createMockFeedProvider().readPair('31337:0x12' as never)).rejects.toBeInstanceOf(IdentityError);
  });
});

import { describe, expect, it } from 'vitest';
import { FeedCursorError, validateFeedSnapshot, verifyMarketCap, type FeedSnapshot, type PairRecord } from '@squarehole/domain';
import { MOCK_SCENARIOS, createMockFeedProvider, type MockScenario } from '../index';
import { ids, pid, query, readAllPages } from '../test-support';

const RESOLVING: readonly MockScenario[] = ['default', 'stale', 'partial', 'no_launches', 'root_unlaunched', 'ranking_updated'];
const records = (snapshot: FeedSnapshot): PairRecord[] => (snapshot.platform ? [snapshot.platform, ...snapshot.items] : snapshot.items);

describe('scenario catalogue', () => {
  it('exports every scenario as a closed union', () => {
    expect(MOCK_SCENARIOS).toEqual(['default', 'loading', 'stale', 'partial', 'unavailable', 'no_launches', 'root_unlaunched', 'ranking_updated']);
  });

  it.each(RESOLVING)('%s is deterministic across provider instances', async (scenario) => {
    const a = await createMockFeedProvider({ scenario }).readFeed(query());
    const b = await createMockFeedProvider({ scenario }).readFeed(query());
    expect(a).toEqual(b);
  });
});

describe('FEED-09 demo data never looks verified or executable', () => {
  it.each(RESOLVING)('%s: valid demo snapshot, no verified issuer, no available route, chain 31337', async (scenario) => {
    const provider = createMockFeedProvider({ scenario });
    for (const sort of ['market_cap', 'new', 'turnover'] as const) {
      const snapshot = await provider.readFeed(query({ sort }));
      validateFeedSnapshot(snapshot, { mode: 'demo' });
      for (const pair of records(snapshot)) {
        expect(pair.chainId).toBe(31337);
        expect(pair.routeState).not.toBe('available');
        expect([pair.token.issuerStatus, pair.quote.issuerStatus]).not.toContain('verified');
        expect(pair.provenance.state).not.toBe('fresh');
        expect(verifyMarketCap(pair)).not.toBe('mismatch');
      }
    }
  });
});

describe('stale', () => {
  it('is two hours older, carries a block number and holds no launch after its asOf', async () => {
    const provider = createMockFeedProvider({ scenario: 'stale' });
    const snapshot = await provider.readFeed(query({ sort: 'new' }));
    expect(snapshot.snapshotId).toBe('demo-20260925T120000Z-stale');
    expect(snapshot.provenance).toMatchObject({ state: 'stale', coverage: 'demo', asOf: '2026-09-25T10:00:00Z' });
    expect(snapshot.provenance.blockNumber).toMatch(/^[1-9][0-9]*$/);
    expect(ids(snapshot.items)).toEqual(['6d', '6b', '6c', '6a', '69', '68', '67', '66'].map(pid));
    for (const pair of records(snapshot)) expect(pair.provenance).toMatchObject({ state: 'stale', asOf: '2026-09-25T10:00:00Z' });
    await expect(provider.latestSnapshot()).resolves.toEqual({ snapshotId: 'demo-20260925T120000Z-stale', asOf: '2026-09-25T10:00:00Z' });
  });
});

describe('partial', () => {
  it('marks coverage partial and turns unindexed turnover into null, never zero', async () => {
    const snapshot = await createMockFeedProvider({ scenario: 'partial' }).readFeed(query({ sort: 'turnover' }));
    expect(snapshot.provenance).toMatchObject({ state: 'partial', coverage: 'partial' });
    const curve = snapshot.items.filter((pair) => pair.lifecycle === 'curve');
    expect(curve.length).toBeGreaterThan(0);
    for (const pair of curve) {
      expect(pair.turnover24hUsd).toBeNull();
      expect(pair.provenance).toMatchObject({ state: 'partial', coverage: 'partial' });
    }
    expect(snapshot.items.some((pair) => pair.turnover24hUsd === '0')).toBe(false);
    // Known turnover first (desc), then nulls ordered by launch time desc, then pairId.
    expect(ids(snapshot.items)).toEqual(['67', '66', '6a', '68', '69', '70', '6f', '6e', '6d', '6b', '6c'].map(pid));
  });
});

describe('no_launches and root_unlaunched', () => {
  it('no_launches keeps the platform pinned with no organic items', async () => {
    const snapshot = await createMockFeedProvider({ scenario: 'no_launches' }).readFeed(query());
    expect(snapshot.platform?.pairId).toBe(pid('65'));
    expect(snapshot.items).toEqual([]);
    expect(snapshot.totalMatches).toBe(0);
    expect(snapshot.nextCursor).toBeNull();
    expect(snapshot.rewardAssets).toEqual([]);
  });

  it('root_unlaunched has no platform (coming-soon card) and still lists organic launches', async () => {
    const provider = createMockFeedProvider({ scenario: 'root_unlaunched' });
    const snapshot = await provider.readFeed(query({ search: 'square' }));
    expect(snapshot.platform).toBeNull();
    expect(snapshot.platformMatchesQuery).toBe(false);
    expect((await provider.readFeed(query())).totalMatches).toBe(11);
    await expect(provider.readPair(pid('65'))).resolves.toBeNull();
  });
});

describe('ranking_updated', () => {
  it('publishes a newer snapshot after the first read with two adjacent market caps swapped', async () => {
    const provider = createMockFeedProvider({ scenario: 'ranking_updated' });
    const before = await provider.latestSnapshot();
    const first = await provider.readFeed(query({ limit: 3 }));
    expect(first.snapshotId).toBe(before.snapshotId);
    expect(ids(first.items)).toEqual([pid('66'), pid('67'), pid('68')]);

    const head = await provider.latestSnapshot();
    expect(head.snapshotId).not.toBe(first.snapshotId);
    expect(head).toEqual({ snapshotId: 'demo-20260925T120000Z-r2', asOf: '2026-09-25T12:05:00Z' });

    const latest = await provider.readFeed(query({ limit: 3 }));
    expect(latest.snapshotId).toBe(head.snapshotId);
    expect(ids(latest.items)).toEqual([pid('67'), pid('66'), pid('68')]);
    const [top, second] = latest.items;
    expect([top?.marketCapUsd, second?.marketCapUsd]).toEqual(['600000.00', '400000.00']);
    // Prices are re-derived exactly so cap = price x circulating supply still holds after the swap.
    expect([top?.priceUsd, second?.priceUsd]).toEqual(['1.2', '1.6']);
  });

  it('keeps the old stable ordering for reads pinned to the old snapshot id', async () => {
    const provider = createMockFeedProvider({ scenario: 'ranking_updated' });
    const first = await provider.readFeed(query({ limit: 3 }));
    const pinned = await readAllPages(provider, query({ limit: 3, snapshotId: first.snapshotId }));
    expect(pinned.every((page) => page.snapshotId === first.snapshotId)).toBe(true);
    expect(pinned.flatMap((page) => ids(page.items))).toEqual(['66', '67', '68', '69', '6a', '6b', '6c', '6d', '6e', '6f', '70'].map(pid));
  });

  it('rejects an old cursor against the new snapshot (a new snapshot resets cursor state)', async () => {
    const provider = createMockFeedProvider({ scenario: 'ranking_updated' });
    const first = await provider.readFeed(query({ limit: 3 }));
    const stale = provider.readFeed(query({ limit: 3, cursor: first.nextCursor ?? undefined }));
    await expect(stale).rejects.toBeInstanceOf(FeedCursorError);
    await expect(stale).rejects.toMatchObject({ code: 'snapshot_mismatch' });
    const resumed = await provider.readFeed(query({ limit: 3, cursor: first.nextCursor ?? undefined, snapshotId: first.snapshotId }));
    expect(ids(resumed.items)).toEqual([pid('69'), pid('6a'), pid('6b')]);
  });

  it('does not expose the newer snapshot before the first read', async () => {
    const provider = createMockFeedProvider({ scenario: 'ranking_updated' });
    await expect(provider.readFeed(query({ snapshotId: 'demo-20260925T120000Z-r2' }))).rejects.toMatchObject({ code: 'unknown_snapshot' });
  });
});

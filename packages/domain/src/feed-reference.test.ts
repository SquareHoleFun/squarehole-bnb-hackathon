/**
 * TypeScript port of the 11 tests in square-hole-handoff/reference/test_feed_model.py (same names, same semantics).
 * Decimal equality uses exact bigint helpers instead of Python's Decimal.
 */
import { describe, expect, it } from 'vitest';
import { compareDecimal, computeMarketCapUsd, FeedDataError, paginateFeed, selectFeed, type PairRecord } from './index';
import { handoffFixture } from './test-support/handoff';

const items = (): PairRecord[] => handoffFixture().items;
const at = (list: readonly PairRecord[], index: number): PairRecord => {
  const pair = list[index];
  if (!pair) throw new Error(`missing item ${index}`);
  return pair;
};

describe('reference/test_feed_model.py (ported)', () => {
  it('test_platform_is_separate_and_not_market_rank', () => {
    const { platform, rows } = selectFeed(items());
    expect(platform?.isPlatform).toBe(true);
    expect(rows.some((p) => p.isPlatform)).toBe(false);
    expect(compareDecimal(at(rows, 0).marketCapUsd ?? '0', platform?.marketCapUsd ?? '0')).toBe(1);
  });

  it('test_market_cap_descending_null_last', () => {
    const { rows } = selectFeed(items());
    expect(rows.at(-1)?.marketCapUsd).toBeNull();
    const values = rows.flatMap((p) => (p.marketCapUsd === null ? [] : [p.marketCapUsd]));
    const sorted = [...values].sort((a, b) => compareDecimal(b, a));
    expect(values).toEqual(sorted);
  });

  it('test_new_sort', () => {
    expect(at(selectFeed(items(), { sort: 'new' }).rows, 0).slug).toBe('unpriced-example');
  });

  it('test_turnover_sort', () => {
    const { rows } = selectFeed(items(), { sort: 'turnover' });
    expect(at(rows, 0).slug).toBe('round-trip');
    expect(rows.at(-1)?.turnover24hUsd).toBeNull();
  });

  it('test_search_and_type', () => {
    expect(selectFeed(items(), { search: 'ORCHARD', type: 'nft_collection' }).rows).toHaveLength(2);
  });

  it('test_address_search_and_reward_filter', () => {
    const address = at(items(), 1).quote.address;
    const { rows } = selectFeed(items(), { search: address, rewardAddress: address });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((p) => p.rewardSide === 'Q')).toBe(true);
  });

  it('test_exact_metrics', () => {
    for (const p of items()) {
      if (p.priceUsd !== null && p.circulatingSupplyRaw !== null && p.marketCapUsd !== null) {
        expect(compareDecimal(computeMarketCapUsd(p.priceUsd, p.circulatingSupplyRaw, p.token.decimals), p.marketCapUsd)).toBe(0);
      }
    }
  });

  it('test_demo_cannot_advertise_real_route_or_verification', () => {
    for (const p of items()) {
      expect(p.chainId).toBe(31337);
      expect(p.routeState).toBe('unverified');
      expect(p.quote.issuerStatus).toBe('mock');
    }
  });

  it('test_duplicate_pair_rejected', () => {
    const list = items();
    expect(() => selectFeed([...list, structuredClone(at(list, 1))])).toThrow(FeedDataError);
  });

  it('test_nft_mapping_and_no_duplicate_supply', () => {
    for (const p of items()) {
      if (p.type === 'nft_collection') {
        expect(p.nftUnitRaw).toBe('1000000000000000000');
        expect(p).toHaveProperty('mirrorAddress');
      }
    }
  });

  it('test_stable_tie_and_pagination', () => {
    const { rows } = selectFeed(items());
    const tied = rows.filter((p) => p.marketCapUsd === '72000.00').map((p) => p.pairId);
    expect(tied).toHaveLength(2);
    expect(tied).toEqual([...tied].sort());
    const flat: string[] = [];
    let cursor: string | undefined;
    do {
      const page = paginateFeed(rows, { snapshotId: 'demo-20260925T120000Z', query: {}, cursor, limit: 3 });
      flat.push(...page.items.map((p) => p.pairId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(flat).size).toBe(flat.length);
    expect(flat).toHaveLength(rows.length);
  });
});

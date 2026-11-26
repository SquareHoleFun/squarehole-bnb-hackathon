import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  FeedValidationError,
  createFeedSnapshotSchema,
  feedFixtureSchema,
  pairRecordSchema,
  parseFeedFixture,
  safeParseFeedFixture,
  validateFeedSnapshot,
  validatePairRecord,
  type FeedFixture,
  type FeedSnapshot,
  type PairRecord,
} from './index';
import type { z } from 'zod';
import { deleteAt, handoffFixture, setAt } from './test-support/handoff';
import { createPrng } from './test-support/prng';

function issuePaths(input: unknown): string[] {
  const result = safeParseFeedFixture(input);
  return result.ok ? [] : result.issues.map((issue) => issue.path);
}

function snapshotFrom(fixture: FeedFixture): FeedSnapshot {
  const [platform, ...items] = fixture.items;
  return {
    snapshotId: fixture.snapshotId,
    platform: platform ?? null,
    platformMatchesQuery: true,
    items,
    nextCursor: null,
    totalMatches: items.length,
    rewardAssets: [],
    provenance: { state: 'mock', asOf: fixture.asOf, source: 'test', coverage: 'demo' },
  };
}

describe('fixture file schema (mirrors feed.schema.json + runtime guards)', () => {
  it('accepts the handoff fixture unchanged', () => {
    const input = handoffFixture();
    const parsed = parseFeedFixture(input);
    expect(parsed).toEqual(input);
    expect(parsed.items).toHaveLength(12);
  });

  it('infers the domain contract types', () => {
    expectTypeOf(parseFeedFixture).returns.toEqualTypeOf<FeedFixture>();
    expectTypeOf<z.output<typeof pairRecordSchema>>().toEqualTypeOf<PairRecord>();
    expectTypeOf<z.output<typeof feedFixtureSchema>>().toEqualTypeOf<FeedFixture>();
    expectTypeOf(validateFeedSnapshot).returns.toEqualTypeOf<FeedSnapshot>();
  });

  it('throws a typed error listing every issue path', () => {
    const input = handoffFixture();
    setAt(input, ['items', 1, 'totalSupplyRaw'], '1e24');
    setAt(input, ['items', 2, 'priceUsd'], 0.8);
    try {
      parseFeedFixture(input);
      throw new Error('expected FeedValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(FeedValidationError);
      expect((error as FeedValidationError).issues.map((issue) => issue.path)).toEqual([
        'items.1.totalSupplyRaw',
        'items.2.priceUsd',
      ]);
    }
  });

  describe('FEED-09 demo guard', () => {
    it.each([
      [['items', 1, 'token', 'issuerStatus'], 'verified'],
      [['items', 1, 'quote', 'issuerStatus'], 'verified'],
      [['items', 1, 'routeState'], 'available'],
      [['items', 0, 'quote', 'issuerStatus'], 'verified'],
    ] as const)('rejects %j = %s in demo mode', (path, value) => {
      const input = handoffFixture();
      setAt(input, path, value);
      expect(issuePaths(input)).toEqual([path.join('.')]);
    });

    it('treats chain 31337 as demo even when the file claims live mode', () => {
      const input = handoffFixture();
      setAt(input, ['mode'], 'live');
      setAt(input, ['items', 3, 'routeState'], 'available');
      expect(issuePaths(input)).toEqual(['items.3.routeState']);
    });

    it('allows verified identities and available routes for live data on another chain', () => {
      const input = handoffFixture();
      setAt(input, ['mode'], 'live');
      setAt(input, ['chainId'], 1);
      input.items.forEach((item, index) => {
        const pairAddress = item.pairId.split(':')[1];
        setAt(input, ['items', index, 'pairId'], `1:${pairAddress}`);
        for (const path of [['chainId'], ['token', 'chainId'], ['quote', 'chainId']]) setAt(input, ['items', index, ...path], 1);
        setAt(input, ['items', index, 'provenance'], { state: 'fresh', asOf: input.asOf, source: 'indexer', coverage: 'canonical_markets' });
      });
      setAt(input, ['items', 1, 'quote', 'issuerStatus'], 'verified');
      setAt(input, ['items', 1, 'routeState'], 'available');
      expect(issuePaths(input)).toEqual([]);
    });
  });

  describe('identity and supply guards (stricter than the JSON Schema)', () => {
    it.each([
      ['circulating > total', ['items', 1, 'circulatingSupplyRaw'], '260000000000000000000001', 'items.1.circulatingSupplyRaw'],
      ['zero NFT unit', ['items', 1, 'nftUnitRaw'], '0', 'items.1.nftUnitRaw'],
      ['pairId chain differs from chainId', ['items', 1, 'pairId'], '1:0x0000000000000000000000000000000000000066', 'items.1.pairId'],
      ['token on another chain', ['items', 1, 'token', 'chainId'], 1, 'items.1.token.chainId'],
      ['item on another chain than the file', ['items', 1, 'chainId'], 1, 'items.1.chainId'],
      ['launch after snapshot asOf', ['items', 1, 'launchedAt'], '2026-09-25T12:00:01Z', 'items.1.launchedAt'],
    ] as const)('rejects %s', (_label, path, value, expectedPath) => {
      const input = handoffFixture();
      setAt(input, path, value);
      expect(issuePaths(input)).toContain(expectedPath);
    });

    it('accepts circulating == total supply', () => {
      const input = handoffFixture();
      setAt(input, ['items', 1, 'circulatingSupplyRaw'], input.items[1]?.totalSupplyRaw);
      expect(issuePaths(input)).toEqual([]);
    });

    it.each(['mirrorAddress', 'nftUnitRaw'])('requires %s for nft_collection', (field) => {
      const input = handoffFixture();
      deleteAt(input, ['items', 1, field]);
      expect(issuePaths(input)).toEqual([`items.1.${field}`]);
    });

    it('rejects duplicate pair ids, including case-only duplicates', () => {
      const exact = handoffFixture();
      exact.items.push(structuredClone(exact.items[2] as PairRecord));
      expect(issuePaths(exact)).toEqual(['items.12.pairId']);

      const caseOnly = handoffFixture();
      const copy = structuredClone(caseOnly.items[5] as PairRecord);
      caseOnly.items.push({ ...copy, pairId: '31337:0x000000000000000000000000000000000000006A' });
      expect(issuePaths(caseOnly)).toEqual(['items.12.pairId']);
    });

    it('rejects more than one platform item', () => {
      const input = handoffFixture();
      setAt(input, ['items', 4, 'isPlatform'], true);
      expect(issuePaths(input)).toEqual(['items.4.isPlatform']);
    });
  });
});

describe('validators are total (never throw on hostile input)', () => {
  const JUNK: readonly unknown[] = [null, undefined, 0, -1, 1.5, 2 ** 60, '', ' ', '1e21', '0x', 'verified', 'available', true, [], {}, [null], { pairId: 1 }];
  const PATHS: readonly (string | number)[][] = [
    [], ['items'], ['items', 0], ['items', 1], ['asOf'], ['mode'], ['chainId'],
    ['items', 1, 'pairId'], ['items', 1, 'token'], ['items', 1, 'token', 'address'], ['items', 1, 'quote', 'chainId'],
    ['items', 1, 'totalSupplyRaw'], ['items', 1, 'circulatingSupplyRaw'], ['items', 1, 'nftUnitRaw'], ['items', 1, 'launchedAt'],
    ['items', 1, 'provenance'], ['items', 1, 'provenance', 'state'], ['items', 2, 'isPlatform'], ['items', 2, 'routeState'],
  ];

  it('returns issues instead of throwing for seeded junk at every guarded path (seed 20260925, 3000 runs)', () => {
    const prng = createPrng(20260925);
    for (let run = 0; run < 3000; run += 1) {
      const fixture: unknown = handoffFixture();
      const path = prng.pick(PATHS);
      const junk = prng.pick(JUNK);
      const input = path.length === 0 ? junk : fixture;
      if (path.length > 0) setAt(input, path, junk);
      expect(() => safeParseFeedFixture(input)).not.toThrow();
      expect(() => createFeedSnapshotSchema({ mode: 'demo' }).safeParse({ ...snapshotFrom(handoffFixture()), items: [junk] })).not.toThrow();
    }
  });
});

describe('PairRecord validator', () => {
  it('validates a single record and applies the demo guard by chain', () => {
    const record = handoffFixture().items[1] as PairRecord;
    expect(validatePairRecord(record)).toEqual(record);
    expect(() => validatePairRecord({ ...record, routeState: 'available' })).toThrow(FeedValidationError);
    expect(() => validatePairRecord({ ...record, extra: true })).toThrow(FeedValidationError);
  });
});

describe('FeedSnapshot validator', () => {
  it('accepts a well-formed demo snapshot', () => {
    const snapshot = snapshotFrom(parseFeedFixture(handoffFixture()));
    expect(validateFeedSnapshot(snapshot, { mode: 'demo' })).toEqual(snapshot);
    expect(createFeedSnapshotSchema({ mode: 'demo' }).safeParse(snapshot).success).toBe(true);
  });

  it.each([
    ['platform inside items (FEED-01)', (s: FeedSnapshot) => ({ ...s, items: [...s.items, s.platform] }), 'items.11.isPlatform'],
    ['non-platform record pinned', (s: FeedSnapshot) => ({ ...s, platform: s.items[0] }), 'platform.isPlatform'],
    ['null platform claiming a match', (s: FeedSnapshot) => ({ ...s, platform: null, platformMatchesQuery: true }), 'platformMatchesQuery'],
    ['totalMatches below the page size', (s: FeedSnapshot) => ({ ...s, totalMatches: 2 }), 'totalMatches'],
    ['duplicate item', (s: FeedSnapshot) => ({ ...s, items: [...s.items, s.items[0]], totalMatches: 12 }), 'items.11.pairId'],
    ['duplicate reward asset', (s: FeedSnapshot) => ({ ...s, rewardAssets: [s.items[0]?.quote, s.items[0]?.quote] }), 'rewardAssets.1'],
    ['demo item marked available', (s: FeedSnapshot) => ({ ...s, items: s.items.map((p, i) => (i === 0 ? { ...p, routeState: 'available' } : p)) }), 'items.0.routeState'],
    ['launch after snapshot asOf', (s: FeedSnapshot) => ({ ...s, provenance: { ...s.provenance, asOf: '2026-09-25T11:00:00Z' } }), 'items.9.launchedAt'],
  ] as const)('rejects %s', (_label, mutate, expectedPath) => {
    const snapshot = mutate(snapshotFrom(parseFeedFixture(handoffFixture())));
    const result = createFeedSnapshotSchema({ mode: 'demo' }).safeParse(snapshot);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain(expectedPath);
    expect(() => validateFeedSnapshot(snapshot, { mode: 'demo' })).toThrow(FeedValidationError);
  });
});

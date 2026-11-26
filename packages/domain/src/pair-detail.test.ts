/**
 * Pair detail contract (SH-012; 01-PRODUCT "Pair detail", 05 "Burn mechanics", FEED-07, FEED-10).
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import {
  DataValidationError,
  pairDetailSchema,
  parsePairDetailsFixture,
  safeParsePairDetail,
  validatePairDetail,
  wholeUnitCapacity,
  type PairDetail,
  type PairDetailsFixture,
  type PairRecord,
} from './index';
import { handoffFixture, setAt, deleteAt } from './test-support/handoff';
import { AS_OF, feedPair, orchardDetail, roundTripDetail, t } from './test-support/m23';
import { createPrng } from './test-support/prng';

type Path = (string | number)[];
const ORCHARD = (): PairRecord => feedPair('orchard');
const ROUND = (): PairRecord => feedPair('round-trip');

function pathsOf(detail: unknown, pair: PairRecord = ORCHARD()): string[] {
  const result = safeParsePairDetail(detail, pair, { asOf: AS_OF });
  return result.ok ? [] : result.issues.map((issue) => issue.path);
}

function mutated(path: Path, value: unknown, base: () => PairDetail = orchardDetail): PairDetail {
  const detail = base();
  setAt(detail, path, value);
  return detail;
}

describe('PairDetail validator', () => {
  it('accepts the ORCHARD (nft, R=Q) and ROUND TRIP (token, R=T) builders unchanged', () => {
    expect(validatePairDetail(orchardDetail(), ORCHARD(), { asOf: AS_OF })).toEqual(orchardDetail());
    expect(pathsOf(roundTripDetail(), ROUND())).toEqual([]);
  });

  it('infers the PairDetail type', () => {
    expectTypeOf<z.output<typeof pairDetailSchema>>().toEqualTypeOf<PairDetail>();
    expectTypeOf(validatePairDetail).returns.toEqualTypeOf<PairDetail>();
  });

  it('throws a typed DataValidationError', () => {
    expect(() => validatePairDetail(mutated(['supply', 'currentRaw'], '1'), ORCHARD(), { asOf: AS_OF })).toThrow(DataValidationError);
  });

  it('rejects a detail for another pair', () => {
    expect(pathsOf(orchardDetail(), ROUND())).toContain('pairId');
  });

  it('computes whole-unit capacity as floor(current / unit)', () => {
    expect(wholeUnitCapacity('260000000000000000000000', '1000000000000000000')).toBe('260000');
    expect(wholeUnitCapacity('2999999999999999999', '1000000000000000000')).toBe('2');
    expect(() => wholeUnitCapacity('1', '0')).toThrow(RangeError);
  });
});

describe('supply identities (FEED-07; separate concepts, never derived counts)', () => {
  it.each([
    ['current supply differs from the feed', ['supply', 'currentRaw'], t(259_999), 'supply.currentRaw'],
    ['fee-burned differs from the feed', ['supply', 'feeBurnedRaw'], t(119), 'supply.feeBurnedRaw'],
    ['initial cap is not current + burned (demo basis)', ['supply', 'initialCapRaw'], t(260_000), 'supply.initialCapRaw'],
    ['live basis on demo data', ['supply', 'initialCapBasis'], 'onchain_initial_supply', 'supply.initialCapBasis'],
    ['circulating differs from the feed', ['supply', 'circulatingRaw'], t(249_999), 'supply.circulatingRaw'],
    ['capacity is not floor(current / unit)', ['supply', 'wholeUnitCapacity', 'count'], '259999', 'supply.wholeUnitCapacity.count'],
    ['active NFT count above capacity', ['supply', 'activeNftCount'], 260_001, 'supply.activeNftCount'],
    ['exclusion basis unavailable with a circulating value', ['supply', 'exclusionBasis'], 'unavailable', 'supply.exclusionBasis'],
  ] as const)('rejects %s', (_label, path, value, expected) => {
    expect(pathsOf(mutated([...path], value))).toContain(expected);
  });

  it('accepts the chain exclusion basis ledger_eligible_supply with a circulating value, and not without one (ADR-0012)', () => {
    expect(pathsOf(mutated(['supply', 'exclusionBasis'], 'ledger_eligible_supply'))).toEqual([]);
    const pair = { ...ORCHARD(), circulatingSupplyRaw: null };
    const detail = orchardDetail();
    detail.supply = { ...detail.supply, circulatingRaw: null, exclusionBasis: 'ledger_eligible_supply' };
    expect(pathsOf(detail, pair)).toContain('supply.exclusionBasis');
  });

  it('accepts an observed active NFT count within capacity and never requires one', () => {
    expect(pathsOf(mutated(['supply', 'activeNftCount'], 12))).toEqual([]);
    expect(pathsOf(mutated(['supply', 'activeNftCount'], null))).toEqual([]);
  });

  it('rejects burned above the initial cap and circulating above current (even when the feed agrees)', () => {
    const pair = { ...ORCHARD(), circulatingSupplyRaw: t(260_001) };
    const detail = mutated(['supply', 'circulatingRaw'], t(260_001));
    expect(pathsOf(detail, pair)).toContain('supply.circulatingRaw');
    const burned = orchardDetail();
    burned.supply = { ...burned.supply, initialCapBasis: 'onchain_initial_supply', initialCapRaw: t(100) };
    expect(pathsOf(burned, { ...ORCHARD(), chainId: 31337 })).toContain('supply.feeBurnedRaw');
  });

  it('token pairs carry no capacity, no active NFT count and no nft block', () => {
    expect(pathsOf(mutated(['supply', 'wholeUnitCapacity'], { count: '1', basis: 'floor_current_supply_over_unit' }, roundTripDetail), ROUND())).toContain(
      'supply.wholeUnitCapacity',
    );
    expect(pathsOf(mutated(['supply', 'activeNftCount'], 0, roundTripDetail), ROUND())).toContain('supply.activeNftCount');
    expect(pathsOf({ ...roundTripDetail(), nft: orchardDetail().nft }, ROUND())).toContain('nft');
  });
});

describe('NFT block and gallery', () => {
  it('is required for nft_collection pairs', () => {
    const detail = orchardDetail();
    deleteAt(detail, ['nft']);
    expect(pathsOf(detail)).toContain('nft');
    expect(pathsOf(mutated(['supply', 'wholeUnitCapacity'], null))).toContain('supply.wholeUnitCapacity');
  });

  it.each([
    ['mirror address differs from the pair', ['nft', 'mirrorAddress'], '0x00000000000000000000000000000000000007d3', 'nft.mirrorAddress'],
    ['unit differs from the pair', ['nft', 'unitRaw'], '1', 'nft.unitRaw'],
    ['duplicate token id', ['nft', 'gallery', 1, 'tokenId'], '7', 'nft.gallery.1.tokenId'],
    ['token id 0', ['nft', 'gallery', 0, 'tokenId'], '0', 'nft.gallery.0.tokenId'],
    ['token id with a leading zero', ['nft', 'gallery', 0, 'tokenId'], '07', 'nft.gallery.0.tokenId'],
    ['malformed art id', ['nft', 'gallery', 0, 'artId'], '../orchard', 'nft.gallery.0.artId'],
    ['control character in a name', ['nft', 'gallery', 0, 'name'], 'ORCHARD\u0007', 'nft.gallery.0.name'],
    ['duplicate trait', ['nft', 'gallery', 0, 'attributes', 1], { trait: 'Season', value: 'Winter' }, 'nft.gallery.0.attributes.1.trait'],
  ] as const)('rejects %s', (_label, path, value, expected) => {
    expect(pathsOf(mutated([...path], value))).toContain(expected);
  });

  it('accepts a mixed-case mirror address and an item without artwork', () => {
    expect(pathsOf(mutated(['nft', 'mirrorAddress'], '0x00000000000000000000000000000000000007D2'))).toEqual([]);
  });
});

describe('price history: only observed points inside the launch window, explicit gaps (FEED-10)', () => {
  it.each([
    ['a point before launch', ['priceHistory', 'points', 0, 't'], '2026-09-22T11:59:59Z', 'priceHistory.points.0.t'],
    ['a point after asOf', ['priceHistory', 'points', 2, 't'], '2026-09-25T12:00:01Z', 'priceHistory.points.2.t'],
    ['points out of order', ['priceHistory', 'points', 1, 't'], '2026-09-22T11:00:00Z', 'priceHistory.points.1.t'],
    ['a duplicate timestamp', ['priceHistory', 'points', 1, 't'], '2026-09-22T12:00:00Z', 'priceHistory.points.1.t'],
    ['a latest point that disagrees with the feed price', ['priceHistory', 'points', 2, 'priceUsd'], '2.39', 'priceHistory.points.2.priceUsd'],
    ['a numeric price', ['priceHistory', 'points', 0, 'priceUsd'], 1.8, 'priceHistory.points.0.priceUsd'],
    ['a zero-length series', ['priceHistory', 'points'], [], 'priceHistory.points'],
  ] as const)('rejects %s', (_label, path, value, expected) => {
    expect(pathsOf(mutated([...path], value))).toContain(expected);
  });

  it('rejects an observed series that is all gaps (that is "unavailable")', () => {
    const detail = orchardDetail();
    detail.priceHistory = { state: 'observed', unit: 'usd_per_t', points: [{ t: '2026-09-23T00:00:00Z', priceUsd: null }] };
    expect(pathsOf(detail)).toContain('priceHistory.points');
  });

  it('accepts trailing zeros as the same price ("2.4" vs "2.40")', () => {
    expect(pathsOf(mutated(['priceHistory', 'points', 2, 'priceUsd'], '2.4000'))).toEqual([]);
  });
});

describe('rewards: one row per asset, never summed (03-FEED)', () => {
  it.each([
    ['a duplicate asset row', (d: PairDetail) => d.rewards.push({ ...(d.rewards[0] as PairDetail['rewards'][number]) }), 'rewards.1.asset'],
    ['an unrelated asset', (d: PairDetail) => setAt(d, ['rewards', 0, 'asset', 'address'], '0x000000000000000000000000000000000000232a'), 'rewards.0.asset'],
    ['a T row on an R=Q pair', (d: PairDetail) => d.rewards.push({ asset: ORCHARD().token, paidRaw: '0', accruedRaw: null }), 'rewards.1.asset'],
  ] as const)('rejects %s', (_label, apply, expected) => {
    const detail = orchardDetail();
    apply(detail);
    expect(pathsOf(detail)).toContain(expected);
  });

  it('rejects accrued T on an R=T pair (holder accrual is a Q entitlement until claimed)', () => {
    expect(pathsOf(mutated(['rewards', 0, 'accruedRaw'], '1', roundTripDetail), ROUND())).toContain('rewards.0.accruedRaw');
  });
});

describe('activity: demo rows, ordered, inside the window, reconciled burns', () => {
  it.each([
    ['a row before launch', ['activity', 1, 'at'], '2026-09-22T11:00:00Z', 'activity.1.at'],
    ['a row after asOf', ['activity', 3, 'at'], '2026-09-25T12:00:01Z', 'activity.3.at'],
    ['rows out of order', ['activity', 3, 'at'], '2026-09-23T11:00:00Z', 'activity.3.at'],
    ['a block that goes backwards', ['activity', 3, 'block'], '100', 'activity.3.block'],
    ['launch at another time', ['activity', 0, 'at'], '2026-09-22T12:00:01Z', 'activity.0.at'],
    ['a second launch row', ['activity', 1, 'kind'], 'launch', 'activity.1.kind'],
    ['a burn of the quote asset', ['activity', 3, 'amounts', 0, 'asset'], ORCHARD().quote, 'activity.3.amounts.0.asset'],
    ['burns above the fee-burned total', ['activity', 3, 'amounts', 0, 'amountRaw'], t(121), 'activity'],
    ['a demo transaction hash (fake explorer link)', ['activity', 1, 'txHash'], `0x${'ab'.repeat(32)}`, 'activity.1.txHash'],
    ['an unrelated asset', ['activity', 1, 'amounts', 0, 'asset', 'address'], '0x00000000000000000000000000000000000003eb', 'activity.1.amounts.0.asset'],
  ] as const)('rejects %s', (_label, path, value, expected) => {
    expect(pathsOf(mutated([...path], value))).toContain(expected);
  });

  it('accepts activity without a launch row (a partial window)', () => {
    const detail = orchardDetail();
    detail.activity = detail.activity.slice(1);
    expect(pathsOf(detail)).toEqual([]);
  });
});

describe('labels and terms', () => {
  it.each([
    ['approved fee status', ['feeTerms', 'status'], 'approved', 'feeTerms.status'],
    ['another headline target', ['feeTerms', 'headlineFeeTargetBps'], 250, 'feeTerms.headlineFeeTargetBps'],
    ['a non-canonical protocol share', ['feeTerms', 'qProtocolShare'], { num: 2, den: 6 }, 'feeTerms.qProtocolShare'],
    ['a canonical status on demo data', ['canonicalStatus'], 'approved_factory', 'canonicalStatus'],
    ['an unknown artwork state', ['artwork'], { state: 'ok' }, 'artwork.artId'],
    ['a description over 500 code points', ['description'], 'd'.repeat(501), 'description'],
    ['a bidi override in the description', ['description'], 'abc\u202Edef', 'description'],
  ] as const)('rejects %s', (_label, path, value, expected) => {
    expect(pathsOf(mutated([...path], value))).toContain(expected);
  });

  it('accepts unavailable artwork with a reason', () => {
    expect(pathsOf(mutated(['artwork'], { state: 'unavailable', reason: 'not_uploaded' }))).toEqual([]);
  });
});

describe('validator is total (never throws on hostile input)', () => {
  const JUNK: readonly unknown[] = [null, undefined, 0, -1, 1.5, '', 'x', '1e21', true, [], {}, [null], { state: 'ok' }];
  const PATHS: readonly Path[] = [
    [], ['pairId'], ['supply'], ['supply', 'currentRaw'], ['supply', 'wholeUnitCapacity'], ['supply', 'activeNftCount'], ['nft'],
    ['nft', 'gallery'], ['nft', 'gallery', 0], ['nft', 'unitRaw'], ['priceHistory'], ['priceHistory', 'points'], ['priceHistory', 'points', 0],
    ['rewards'], ['rewards', 0, 'asset'], ['activity'], ['activity', 0], ['activity', 0, 'amounts'], ['activity', 1, 'at'], ['feeTerms'],
    ['feeTerms', 'qProtocolShare'], ['provenance'],
  ];

  it('returns issues instead of throwing (seed 20260925, 2000 runs)', () => {
    const prng = createPrng(20260925);
    for (let run = 0; run < 2000; run += 1) {
      const path = prng.pick(PATHS);
      const value = prng.pick(JUNK);
      const input: unknown = path.length === 0 ? value : mutated(path, value);
      expect(() => safeParsePairDetail(input, ORCHARD(), { asOf: AS_OF })).not.toThrow();
    }
  });
});

describe('pair-details fixture file', () => {
  const feed = handoffFixture();
  const file = (): PairDetailsFixture => ({
    schemaVersion: '1.0',
    mode: 'demo',
    chainId: 31337,
    asOf: feed.asOf,
    feedSnapshotId: feed.snapshotId,
    details: [orchardDetail(), roundTripDetail()],
  });
  const filePaths = (input: unknown): string[] => {
    try {
      parsePairDetailsFixture(input, feed);
      return [];
    } catch (error) {
      if (!(error instanceof DataValidationError)) throw error;
      return error.issues.map((issue) => issue.path);
    }
  };

  it('accepts details that match their feed records', () => {
    expect(parsePairDetailsFixture(file(), feed).details).toHaveLength(2);
  });

  it.each([
    ['an unknown pair id', ['details', 1, 'pairId'], '31337:0x0000000000000000000000000000000000000099', 'details.1.pairId'],
    ['a duplicate pair (address case only)', ['details', 1, 'pairId'], '31337:0x0000000000000000000000000000000000000066', 'details.1.pairId'],
    ['another snapshot', ['feedSnapshotId'], 'demo-other', 'feedSnapshotId'],
    ['another asOf', ['asOf'], '2026-09-25T12:00:01Z', 'asOf'],
    ['live mode', ['mode'], 'live', 'mode'],
    ['a detail that disagrees with its record', ['details', 0, 'supply', 'currentRaw'], '1', 'details.0.supply.currentRaw'],
  ] as const)('rejects %s', (_label, path, value, expected) => {
    const input = file();
    setAt(input, [...path], value);
    expect(filePaths(input)).toContain(expected);
  });
});

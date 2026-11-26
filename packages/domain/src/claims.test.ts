/**
 * Accounts and claims contract (SH-014, SH-015; 03-FEED "Holder counts and rewards"; ECO-04/05/06/07).
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import {
  AmountError,
  DataValidationError,
  claimViewSchema,
  estimatePayoutRaw,
  positionSchema,
  safeParseClaimView,
  safeParsePosition,
  splitWholeUnits,
  validateAccountClaims,
  validateAccountPositions,
  validateClaimView,
  type AccountClaims,
  type ClaimView,
  type PairRecord,
  type Position,
} from './index';
import { setAt } from './test-support/handoff';
import {
  AS_OF,
  CURRENT_HOLDER,
  DEMO_PROVENANCE,
  PAST_HOLDER,
  feedPair,
  framesClaim,
  framesClaimConversionFails,
  orchardClaim,
  orchardPosition,
  roundTripPosition,
  t,
} from './test-support/m23';
import { createPrng } from './test-support/prng';

type Path = (string | number)[];
const ORCHARD = (): PairRecord => feedPair('orchard');
const FRAMES = (): PairRecord => feedPair('tiny-frames');
const ROUND = (): PairRecord => feedPair('round-trip');
const pairs = (): Map<string, PairRecord> => new Map([ORCHARD(), FRAMES(), ROUND()].map((pair) => [pair.pairId, pair]));

function mutated<T>(base: () => T, path: Path, value: unknown): T {
  const copy = base();
  setAt(copy, path, value);
  return copy;
}

const positionPaths = (position: unknown, pair: PairRecord = ORCHARD()): string[] => {
  const result = safeParsePosition(position, pair);
  return result.ok ? [] : result.issues.map((issue) => issue.path);
};
const claimPaths = (claim: unknown, pair: PairRecord): string[] => {
  const result = safeParseClaimView(claim, pair, { asOf: AS_OF });
  return result.ok ? [] : result.issues.map((issue) => issue.path);
};

describe('exact helpers', () => {
  it('splits a balance into whole NFT units and a fraction (bigint only)', () => {
    expect(splitWholeUnits(3_250_000_000_000_000_000n, 10n ** 18n)).toEqual({ whole: 3n, fraction: 250_000_000_000_000_000n });
    expect(splitWholeUnits(999n, 1000n)).toEqual({ whole: 0n, fraction: 999n });
    expect(() => splitWholeUnits(1n, 0n)).toThrow(RangeError);
    expect(() => splitWholeUnits(-1n, 1n)).toThrow(RangeError);
  });

  it.each([
    [81_574_883_741_628_284n, '2000', 18, 18, 163_149_767_483_256_568_000n],
    [1_500_000n, '0.8', 6, 18, 1_200_000_000_000_000_000n],
    [1n, '0.5', 18, 18, 0n],
    [3n, '0.333', 0, 0, 0n],
    [0n, '2000', 18, 18, 0n],
    [10n ** 18n, '1234.5678', 18, 6, 1_234_567_800n],
  ])('estimatePayoutRaw(%s, %s, q%i, t%i) = %s (floor, exact)', (claimable, rate, qDecimals, tDecimals, expected) => {
    expect(estimatePayoutRaw(claimable, rate, qDecimals, tDecimals)).toBe(expected);
  });

  it('rejects negative amounts and malformed rates', () => {
    expect(() => estimatePayoutRaw(-1n, '1', 18, 18)).toThrow(RangeError);
    expect(() => estimatePayoutRaw(1n, '1e3', 18, 18)).toThrow(AmountError);
    expect(() => estimatePayoutRaw(1n, '1', 37, 18)).toThrow(AmountError);
  });
});

describe('Position', () => {
  it('accepts an NFT position (whole NFTs + fraction) and a token position', () => {
    expect(positionPaths(orchardPosition())).toEqual([]);
    expect(positionPaths(roundTripPosition(), ROUND())).toEqual([]);
    expectTypeOf<z.output<typeof positionSchema>>().toEqualTypeOf<Position>();
  });

  it.each([
    ['whole count is not floor(balance / unit)', ['wholeNftCount'], '4', 'wholeNftCount'],
    ['fraction is not balance mod unit', ['fractionalRaw'], '0', 'fractionalRaw'],
    ['more NFT ids than whole units', ['nftTokenIds'], ['7', '12', '31', '44'], 'nftTokenIds'],
    ['duplicate NFT ids', ['nftTokenIds'], ['7', '7', '31'], 'nftTokenIds.1'],
    ['NFT id 0', ['nftTokenIds', 0], '0', 'nftTokenIds.0'],
    ['a zero balance (positions list current holdings only)', ['balanceRaw'], '0', 'balanceRaw'],
    ['a balance above total supply', ['balanceRaw'], t(260_001), 'balanceRaw'],
    ['another pair', ['pairId'], '31337:0x0000000000000000000000000000000000000067', 'pairId'],
    ['a numeric balance', ['balanceRaw'], 3.25, 'balanceRaw'],
  ] as const)('rejects %s', (_label, path, value, expected) => {
    expect(positionPaths(mutated(orchardPosition, [...path], value))).toContain(expected);
  });

  it('accepts fewer NFT ids than whole units (skip-NFT accounts)', () => {
    expect(positionPaths(mutated(orchardPosition, ['nftTokenIds'], ['7']))).toEqual([]);
  });

  it.each([
    ['a whole count', ['wholeNftCount'], '1500', 'wholeNftCount'],
    ['a fraction', ['fractionalRaw'], '0', 'fractionalRaw'],
    ['NFT ids', ['nftTokenIds'], ['1'], 'nftTokenIds'],
  ] as const)('rejects %s on a token position', (_label, path, value, expected) => {
    expect(positionPaths(mutated(roundTripPosition, [...path], value), ROUND())).toContain(expected);
  });
});

describe('ClaimView: R = Q (ORCHARD, current holder)', () => {
  it('accepts the builder and infers the type', () => {
    expect(validateClaimView(orchardClaim(), ORCHARD(), { asOf: AS_OF })).toEqual(orchardClaim());
    expectTypeOf<z.output<typeof claimViewSchema>>().toEqualTypeOf<ClaimView>();
  });

  it('ECO-04: rewardSide must equal the pair reward side', () => {
    expect(claimPaths(mutated(orchardClaim, ['rewardSide'], 'T'), ORCHARD())).toContain('rewardSide');
    expect(() => validateClaimView(mutated(orchardClaim, ['rewardSide'], 'T'), ORCHARD(), { asOf: AS_OF })).toThrow(DataValidationError);
  });

  it.each([
    ['payout asset is T on an R=Q pair', ['payoutAsset'], feedPair('orchard').token, 'payoutAsset'],
    ['earned is not claimable + claimed', ['earnedQRaw'], '1', 'earnedQRaw'],
    ['claimed differs from settled history', ['claimedQRaw'], '13588773871356901', 'claimedQRaw'],
    ['an estimate on an R=Q claim', ['convertibleEstimate'], framesClaim().convertibleEstimate, 'convertibleEstimate'],
    ['estimated payout differs from claimable', ['estimatedPayoutRaw'], '1', 'estimatedPayoutRaw'],
    ['conversion on an R=Q claim', ['conversionAvailable'], true, 'conversionAvailable'],
    ['a fallback flag on an R=Q claim', ['directSourceFallbackAvailable'], true, 'directSourceFallbackAvailable'],
    ['history before launch', ['history', 0, 'at'], '2026-09-22T11:59:59Z', 'history.0.at'],
    ['history after asOf', ['history', 0, 'at'], '2026-09-25T12:00:01Z', 'history.0.at'],
    ['a settled payout in an unrelated asset', ['history', 0, 'payoutAsset'], feedPair('round-trip').quote, 'history.0.payoutAsset'],
    ['the zero owner', ['owner'], '0x0000000000000000000000000000000000000000', 'owner'],
    ['another pair', ['pairId'], '31337:0x0000000000000000000000000000000000000067', 'pairId'],
    ['a numeric amount', ['claimableQRaw'], 1, 'claimableQRaw'],
    ['a malformed asOfBlock', ['asOfBlock'], '-1', 'asOfBlock'],
  ] as const)('rejects %s', (_label, path, value, expected) => {
    expect(claimPaths(mutated(orchardClaim, [...path], value), ORCHARD())).toContain(expected);
  });

  it('accepts a zero claim (never held)', () => {
    const zero = orchardClaim();
    const empty: ClaimView = {
      ...zero,
      earnedQRaw: '0',
      claimableQRaw: '0',
      claimedQRaw: '0',
      pendingHarvestQRaw: '0',
      estimatedPayoutRaw: '0',
      history: [],
    };
    expect(claimPaths(empty, ORCHARD())).toEqual([]);
  });
});

describe('ClaimView: R = T (TINY FRAMES, past holder with zero balance)', () => {
  it('accepts the builder: settled + reverted history, convertible estimate', () => {
    expect(claimPaths(framesClaim(), FRAMES())).toEqual([]);
  });

  it('accepts the conversion_fails shape: no estimate, labelled emergency direct-Q fallback', () => {
    expect(claimPaths(framesClaimConversionFails(), FRAMES())).toEqual([]);
  });

  it.each([
    ['payout asset is Q on an R=T pair', ['payoutAsset'], feedPair('tiny-frames').quote, 'payoutAsset'],
    ['estimate payout is not floor(claimable x rate)', ['convertibleEstimate', 'payoutRaw'], '163149767483256568001', 'convertibleEstimate.payoutRaw'],
    ['minimum is not floor(payout x 0.99)', ['convertibleEstimate', 'minPayoutRaw'], '161518269808424002321', 'convertibleEstimate.minPayoutRaw'],
    ['a user-edited tolerance', ['convertibleEstimate', 'toleranceBps'], 50, 'convertibleEstimate.toleranceBps'],
    ['a deadline before the estimate time', ['convertibleEstimate', 'deadline'], '2026-09-25T11:59:59Z', 'convertibleEstimate.deadline'],
    ['an estimate from a non-demo source', ['convertibleEstimate', 'source'], 'router', 'convertibleEstimate.source'],
    ['a malformed rate', ['convertibleEstimate', 'tPerQ'], '2e3', 'convertibleEstimate.tPerQ'],
    ['estimated payout differs from the estimate', ['estimatedPayoutRaw'], '1', 'estimatedPayoutRaw'],
    ['an estimate while conversion is unavailable', ['conversionAvailable'], false, 'convertibleEstimate'],
    ['a reverted attempt that consumed Q (ECO-07)', ['history', 1, 'qConsumedRaw'], '1', 'history.1.qConsumedRaw'],
    ['a reverted attempt that paid out', ['history', 1, 'payoutRaw'], '1', 'history.1.payoutRaw'],
    ['history out of order', ['history', 1, 'at'], '2026-09-25T02:00:00Z', 'history.1.at'],
    ['a fallback flag without the labelled fallback', ['directSourceFallbackAvailable'], true, 'directSourceFallback'],
  ] as const)('rejects %s', (_label, path, value, expected) => {
    expect(claimPaths(mutated(framesClaim, [...path], value), FRAMES())).toContain(expected);
  });

  it.each(['v4_quoter_eth_call', 'converter_eth_call'] as const)('accepts the chain quote source %s (ADR-0012)', (source) => {
    expect(claimPaths(mutated(framesClaim, ['convertibleEstimate', 'source'], source), FRAMES())).toEqual([]);
  });

  it('rejects an estimate without estimateAsOf', () => {
    const claim = framesClaim();
    delete claim.estimateAsOf;
    expect(claimPaths(claim, FRAMES())).toContain('estimateAsOf');
  });

  // M2/M3 review notes (SH-015 part 2): an expired quote or a zero rate is not a convertible estimate.
  const pathsAt = (claim: unknown, asOf: string): string[] => {
    const result = safeParseClaimView(claim, FRAMES(), { asOf });
    return result.ok ? [] : result.issues.map((issue) => issue.path);
  };

  it('rejects an estimate read at or after its deadline (an expired quote)', () => {
    expect(pathsAt(framesClaim(), '2026-09-25T12:19:59.999Z')).toEqual([]);
    expect(pathsAt(framesClaim(), '2026-09-25T12:20:00Z')).toContain('convertibleEstimate.deadline');
    expect(pathsAt(framesClaim(), '2026-09-25T13:00:00Z')).toContain('convertibleEstimate.deadline');
  });

  it('accepts the same claim without an estimate after the deadline (the UI must refresh the quote)', () => {
    const claim = framesClaim();
    delete claim.estimateAsOf;
    const expired: ClaimView = { ...claim, convertibleEstimate: null, estimatedPayoutRaw: null };
    expect(pathsAt(expired, '2026-09-25T13:00:00Z')).toEqual([]);
  });

  it.each(['0', '0.0', '0.000000'])('rejects a zero rate tPerQ %s (no quote pays nothing for a positive entitlement)', (rate) => {
    const claim = framesClaim();
    const zero: ClaimView = {
      ...claim,
      estimatedPayoutRaw: '0',
      convertibleEstimate: claim.convertibleEstimate && { ...claim.convertibleEstimate, tPerQ: rate, payoutRaw: '0', minPayoutRaw: '0' },
    };
    expect(claimPaths(zero, FRAMES())).toContain('convertibleEstimate.tPerQ');
  });

  it.each([
    ['fallback amount differs from claimable', ['directSourceFallback', 'payoutRaw'], '1', 'directSourceFallback.payoutRaw'],
    ['fallback pays T', ['directSourceFallback', 'payoutAsset'], feedPair('tiny-frames').token, 'directSourceFallback.payoutAsset'],
    ['fallback without its flag', ['directSourceFallbackAvailable'], false, 'directSourceFallback'],
    ['an unlabelled fallback', ['directSourceFallback', 'label'], 'direct', 'directSourceFallback.label'],
  ] as const)('conversion_fails: rejects %s', (_label, path, value, expected) => {
    expect(claimPaths(mutated(framesClaimConversionFails, [...path], value), FRAMES())).toContain(expected);
  });
});

describe('account wrappers', () => {
  const claims = (): AccountClaims => ({ owner: PAST_HOLDER, asOfBlock: '39600', claims: [framesClaim()], provenance: { ...DEMO_PROVENANCE } });
  const wrapperPaths = (fn: () => unknown): string[] => {
    try {
      fn();
      return [];
    } catch (error) {
      if (!(error instanceof DataValidationError)) throw error;
      return error.issues.map((issue) => issue.path);
    }
  };

  it('validates every claim against its pair and the wrapper owner/block', () => {
    expect(validateAccountClaims(claims(), pairs(), { asOf: AS_OF })).toEqual(claims());
    expect(wrapperPaths(() => validateAccountClaims(mutated(claims, ['owner'], CURRENT_HOLDER), pairs(), { asOf: AS_OF }))).toContain('claims.0.owner');
    expect(wrapperPaths(() => validateAccountClaims(mutated(claims, ['asOfBlock'], '39601'), pairs(), { asOf: AS_OF }))).toContain('claims.0.asOfBlock');
    const duplicate = claims();
    duplicate.claims.push(framesClaim());
    expect(wrapperPaths(() => validateAccountClaims(duplicate, pairs(), { asOf: AS_OF }))).toContain('claims.1.pairId');
    const unknown = mutated(claims, ['claims', 0, 'pairId'], '31337:0x0000000000000000000000000000000000000099');
    expect(wrapperPaths(() => validateAccountClaims(unknown, pairs(), { asOf: AS_OF }))).toContain('claims.0.pairId');
  });

  it('validates positions against their pairs', () => {
    const positions = { owner: CURRENT_HOLDER, asOfBlock: '39600', positions: [orchardPosition(), roundTripPosition()], provenance: { ...DEMO_PROVENANCE } };
    expect(validateAccountPositions(positions, pairs())).toEqual(positions);
    const duplicate = { ...positions, positions: [orchardPosition(), orchardPosition()] };
    expect(wrapperPaths(() => validateAccountPositions(duplicate, pairs()))).toContain('positions.1.pairId');
  });
});

describe('validators are total (never throw on hostile input)', () => {
  const JUNK: readonly unknown[] = [null, undefined, 0, -1, 1.5, '', 'x', '1e21', true, [], {}, [null]];
  const PATHS: readonly Path[] = [
    [], ['rewardSide'], ['earnedQRaw'], ['claimableQRaw'], ['history'], ['history', 0], ['history', 0, 'at'], ['convertibleEstimate'],
    ['convertibleEstimate', 'tPerQ'], ['convertibleEstimate', 'payoutRaw'], ['payoutAsset'], ['directSourceFallback'], ['provenance'],
  ];

  it('claims and positions return issues instead of throwing (seed 20260925, 2000 runs)', () => {
    const prng = createPrng(20260925);
    for (let run = 0; run < 2000; run += 1) {
      const path = prng.pick(PATHS);
      const value = prng.pick(JUNK);
      const claim: unknown = path.length === 0 ? value : mutated(framesClaim, path, value);
      expect(() => safeParseClaimView(claim, FRAMES(), { asOf: AS_OF })).not.toThrow();
      const position: unknown = path.length === 0 ? value : mutated(orchardPosition, [prng.pick(['balanceRaw', 'wholeNftCount', 'nftTokenIds'])], value);
      expect(() => safeParsePosition(position, ORCHARD())).not.toThrow();
    }
  });
});

import { describe, expect, it } from 'vitest';
import {
  FRACTIONS_PER_NFT_TIERS,
  MAX_COLLECTION_FRACTIONS,
  collectionSupplyRaw,
  fractionalizationIssues,
  fractionsPerNftFromUnitRaw,
  isFractionTier,
  nftUnitRawForTier,
  totalFractions,
} from './index';

const paths = (size: unknown, tier: bigint | null) => fractionalizationIssues(size, tier).map((issue) => issue.path.join('.'));

describe('F08 fractionalization ratio (ADR-0009)', () => {
  it('offers exactly the ten power-of-ten tiers 1 … 10^9', () => {
    expect(FRACTIONS_PER_NFT_TIERS.map(String)).toEqual([
      '1',
      '10',
      '100',
      '1000',
      '10000',
      '100000',
      '1000000',
      '10000000',
      '100000000',
      '1000000000',
    ]);
    expect(isFractionTier(0n)).toBe(false);
    expect(isFractionTier(20n)).toBe(false);
    expect(isFractionTier(10n ** 10n)).toBe(false);
  });

  it('maps a tier to its raw unit r × 10^18 and back', () => {
    for (const tier of FRACTIONS_PER_NFT_TIERS) {
      const unit = nftUnitRawForTier(tier);
      expect(BigInt(unit)).toBe(tier * 10n ** 18n);
      expect(fractionsPerNftFromUnitRaw(unit)).toBe(tier);
    }
    expect(() => nftUnitRawForTier(3n)).toThrow(RangeError);
    for (const bad of ['0', '1', '1500000000000000000', '10000000000000000000000000000', '1e18', 1e18, null, '01000000000000000000']) {
      expect(fractionsPerNftFromUnitRaw(bad), String(bad)).toBeNull();
    }
  });

  it('computes totals exactly as bigint, far beyond 2^53', () => {
    expect(totalFractions(1_000n, 1_000_000n)).toBe(MAX_COLLECTION_FRACTIONS);
    expect(collectionSupplyRaw(1_000n, 1_000_000n)).toBe('1000000000000000000000000000'); // 10^27 raw, inside uint96
    expect(BigInt(collectionSupplyRaw(1n, 1_000_000_000n)) < 2n ** 96n).toBe(true);
  });

  it('accepts N × r up to 10^9 and rejects one fraction more', () => {
    expect(paths('1000000000', 1n)).toEqual([]);
    expect(paths('1000000001', 1n)).toEqual(['collectionSize']);
    expect(paths('1000', 1_000_000n)).toEqual([]);
    expect(paths('1001', 1_000_000n)).toEqual(['collectionSize']);
    expect(paths('1', 1_000_000_000n)).toEqual([]);
    expect(paths('2', 1_000_000_000n)).toEqual(['collectionSize']);
    // A size far beyond Number.MAX_SAFE_INTEGER is still compared exactly.
    expect(paths('99999999999999999999999999', 1n)).toEqual(['collectionSize']);
  });

  it('reports malformed sizes and tiers without throwing', () => {
    for (const size of ['', '0', '01', '-5', '2.5', ' 3', 7, null, undefined]) {
      expect(paths(size, 10n), String(size)).toEqual(['collectionSize']);
    }
    expect(paths('10', null)).toEqual(['nftUnitRaw']);
    expect(paths('10', 3n)).toEqual(['nftUnitRaw']);
    expect(paths('x', null)).toEqual(['collectionSize', 'nftUnitRaw']);
  });
});

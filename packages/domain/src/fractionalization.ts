/**
 * NFT fractionalization ratio (F06, F08; ADR-0009 "Ratio design"). At creation the creator sets the collection size N
 * (whole NFTs) and picks a preset tier r = fractions per NFT from the powers of ten 1 … 10^9, with N × r ≤ 10^9 for
 * the FULL collection. Units have 18 decimals, so one NFT is `unit = r × 10^18` raw and the whole collection is
 * `N × r × 10^18` raw (≤ 10^27, far inside DN404's uint96). Partial fractions go down to 10^-18 of a fraction.
 *
 * Everything here is bigint or a decimal string: sizes and supplies are never JavaScript numbers.
 */
import { isRawAmount } from './amounts';
import type { GuardIssue } from './guards';
import type { RawAmount } from './types';

/** The whole collection holds at most one billion fractions (F08). */
export const MAX_COLLECTION_FRACTIONS = 1_000_000_000n;
/** Decimals of every fraction (ADR-0009: standard 18 decimals). */
export const FRACTION_DECIMALS = 18;
const ONE_FRACTION_RAW = 10n ** BigInt(FRACTION_DECIMALS);

/** Tier exponents k for r = 10^k (1, 10, …, 1,000,000,000 fractions per NFT). */
export const FRACTION_TIER_EXPONENTS: readonly number[] = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
export const FRACTIONS_PER_NFT_TIERS: readonly bigint[] = Object.freeze(FRACTION_TIER_EXPONENTS.map((k) => 10n ** BigInt(k)));

export function isFractionTier(fractionsPerNft: bigint): boolean {
  return FRACTIONS_PER_NFT_TIERS.includes(fractionsPerNft);
}

/** `r × 10^18` as a raw amount. Throws RangeError for anything that is not a tier. */
export function nftUnitRawForTier(fractionsPerNft: bigint): RawAmount {
  if (!isFractionTier(fractionsPerNft)) throw new RangeError('fractions per NFT must be a power of ten from 1 to 1,000,000,000');
  return (fractionsPerNft * ONE_FRACTION_RAW).toString();
}

/** The tier r of a raw NFT unit, or null when the unit is not `10^k × 10^18` with k in 0…9. Total: never throws. */
export function fractionsPerNftFromUnitRaw(unitRaw: unknown): bigint | null {
  if (!isRawAmount(unitRaw)) return null;
  const unit = BigInt(unitRaw);
  if (unit === 0n || unit % ONE_FRACTION_RAW !== 0n) return null;
  const tier = unit / ONE_FRACTION_RAW;
  return isFractionTier(tier) ? tier : null;
}

/** Total fractions of the collection, N × r (bigint, exact). */
export function totalFractions(collectionSize: bigint, fractionsPerNft: bigint): bigint {
  return collectionSize * fractionsPerNft;
}

/** Total raw supply of the collection, N × r × 10^18. */
export function collectionSupplyRaw(collectionSize: bigint, fractionsPerNft: bigint): RawAmount {
  return (collectionSize * fractionsPerNft * ONE_FRACTION_RAW).toString();
}

/**
 * Issues with a collection size (decimal string, as typed or stored) and a tier. Total: tolerates malformed input.
 * Paths: `collectionSize`, `nftUnitRaw` (the tier), and `collectionSize` again for the N × r cap.
 */
export function fractionalizationIssues(collectionSize: unknown, fractionsPerNft: bigint | null): GuardIssue[] {
  const issues: GuardIssue[] = [];
  let size: bigint | null = null;
  if (!isRawAmount(collectionSize)) {
    issues.push({ path: ['collectionSize'], message: 'collection size must be a whole number of NFTs' });
  } else {
    size = BigInt(collectionSize);
    if (size === 0n) issues.push({ path: ['collectionSize'], message: 'a collection has at least one NFT' });
  }
  if (fractionsPerNft === null || !isFractionTier(fractionsPerNft)) {
    issues.push({ path: ['nftUnitRaw'], message: 'fractions per NFT must be a power of ten from 1 to 1,000,000,000 (ADR-0009)' });
    return issues;
  }
  if (size !== null && size > 0n && totalFractions(size, fractionsPerNft) > MAX_COLLECTION_FRACTIONS) {
    issues.push({
      path: ['collectionSize'],
      message: `collection size × fractions per NFT must not exceed ${MAX_COLLECTION_FRACTIONS} fractions (F08)`,
    });
  }
  return issues;
}

/**
 * The Box kind step's words (box creation flow § 2.2, § 2.3): the fee split in plain fractions, why a choice is off
 * beside the other side's (BP-13, said from the side it is shown on), and the cap amount first.
 */
import { FEE_SHARE_DEPTH, FEE_SHARE_FIT, FEE_SHARE_Q_STREAM, QStream, TStream } from '@squarehole/box-spec';
import { describe, expect, it } from 'vitest';
import { curvePriceRatio, curveSharePercent, feeSplitLine, plainShare, poolLine } from './FixedValues';
import { capLine, offReason } from './KindStep';

describe('the fee words', () => {
  it('the split line in plain fractions from the version constants: "1% fee: ⅔ picked · ⅓ fixed"', () => {
    expect(feeSplitLine()).toBe('1% fee: ⅔ picked · ⅓ fixed');
    expect([plainShare(FEE_SHARE_Q_STREAM), plainShare(FEE_SHARE_FIT + FEE_SHARE_DEPTH), plainShare(FEE_SHARE_FIT), plainShare(FEE_SHARE_DEPTH)]).toEqual(['⅔', '⅓', '⅕', '2/15']);
    expect([curveSharePercent(), curvePriceRatio()]).toEqual(['80%', '14.7']);
  });

  it('the pool line: both sides’ 2/15 paired and locked, § 2.3 verbatim (F72 (B), built in core v1)', () => {
    expect(poolLine()).toBe('2/15 of buyers’ fees and 2/15 of sellers’ fees into this box’s pool. Paired and locked: the box adds both sides together and owns the liquidity for good');
    expect(poolLine()).not.toMatch(/finalis|open/);
  });

  it('BP-13 from either side: the reason names the other side’s choice, never the option itself', () => {
    // Sellers' Burn FIT (SELL_FOR_Q) off beside buyers' Burn KITE.
    expect(offReason('sellers', QStream.BUYBACK_BURN_T, 'KITE', 'ETH', false)).toEqual({
      hint: 'Not with buyers’ Burn KITE',
      full: 'Not beside Burn KITE on buyers’ fees: the box would sell and buy back in one pool.',
    });
    // Buyers' Burn KITE (BUYBACK_BURN_T) off beside sellers' Burn FIT, which sells.
    expect(offReason('buyers', TStream.SELL_FOR_Q, 'KITE', 'ETH', false)).toEqual({
      hint: 'Not with sellers’ Burn FIT',
      full: 'Not beside Burn FIT on sellers’ fees (sells KITE for ETH): the box would sell and buy back in one pool.',
    });
    // With a Q that burns, the sellers' burn is said as that Q.
    expect(offReason('buyers', TStream.SELL_FOR_Q, 'KITE', 'FITQ', true).hint).toBe('Not with sellers’ Burn FITQ');
  });

  it('the cap: a fixed amount per 30 days (F74 U2), bigint', () => {
    expect(capLine(10n ** 18n, 'ETH')).toBe('1 ETH / 30 days');
    expect(capLine(32n * 10n ** 18n, 'ETH')).toBe('32 ETH / 30 days');
  });
});

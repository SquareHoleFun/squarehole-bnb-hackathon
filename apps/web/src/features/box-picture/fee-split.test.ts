/**
 * SH-251: the picture's fifteenths against the contract's PLAIN path (no sources: `hasSources` false). Vectors from the
 * contract's own tests of that path:
 * - packages/contracts/test/box-v2/cq11-b/ReceiverMoney.t.sol `test_donationsAreBuyersAndCounterIsClipped` (150 of P on
 *   the buyers' side books creatorP 100: 10 of 15 parts);
 * - the same file's `testFuzz_conservationAndCarries` (fees a and c on the buyers' side, b on the sellers', each side
 *   carrying its own remainder: units = (a + c) / 15 + b / 15; fitOwed 2 units, platformOwed 1, the choice 10, the pool 2);
 * - packages/contracts/test/box-v2/items-pool/Booking.t.sol (the choice is amount / 15 * 10).
 * And the explainer's worked example (README, "the split, from the contract"): 1 ETH, fee 0.01 ETH, 10 wei carried.
 */
import { describe, expect, it } from 'vitest';
import { LP_FEE } from '@squarehole/box-spec';
import { FEE_PIPS, HUNDRED_TRADES, NO_TRADES, PIPS, addTrade, feeOf, splitFifteenths, type FeeSide } from './fee-split';

const E18 = 10n ** 18n;

/** The fuzz test's world, run step by step through the picture's function. */
function books(fees: readonly (readonly [bigint, FeeSide])[]) {
  const carry: Record<FeeSide, bigint> = { buyers: 0n, sellers: 0n };
  let pick = 0n; let pool = 0n; let fit = 0n; let platform = 0n;
  for (const [fee, side] of fees) {
    const split = splitFifteenths(fee, carry[side]);
    carry[side] = split.carry;
    pick += split.pick; pool += split.pool; fit += split.fit; platform += split.platform;
  }
  return { pick, pool, fit, platform, carry };
}

describe('SH-251 the fee in fifteenths (ReceiverBooksV21._splitSource without sources)', () => {
  it('1% of a trade, rounded down (the release\'s LP_FEE of 1,000,000)', () => {
    expect(FEE_PIPS).toBe(BigInt(LP_FEE));
    expect(FEE_PIPS).toBe(10_000n);
    expect(PIPS).toBe(1_000_000n);
    expect(feeOf(E18)).toBe(10n ** 16n);
    expect(feeOf(99n)).toBe(0n);
  });

  it('ReceiverMoney.t.sol donations: 150 on the buyers books 100 for the choice', () => {
    expect(splitFifteenths(150n, 0n)).toEqual({ pick: 100n, pool: 20n, fit: 20n, platform: 10n, carry: 0n });
  });

  it('the explainer example: 1 ETH pays 0.01 ETH, 666,666,666,666,666 wei a part and 10 wei carried', () => {
    expect(splitFifteenths(10n ** 16n, 0n)).toEqual({ pick: 6_666_666_666_666_660n, pool: 1_333_333_333_333_332n, fit: 1_333_333_333_333_332n, platform: 666_666_666_666_666n, carry: 10n });
    // The next fee of the same side takes the 10 wei with it.
    expect(splitFifteenths(10n ** 16n, 10n).pick).toBe(6_666_666_666_666_670n);
    expect(splitFifteenths(10n ** 16n, 10n).carry).toBe(5n);
  });

  it('ReceiverMoney.t.sol conservation and carries (a box without sources): each side carries its own remainder', () => {
    const cases: readonly (readonly [bigint, bigint, bigint])[] = [[0n, 0n, 0n], [7n, 29n, 8n], [14n, 14n, 1n], [150n, 14n, 1n], [10n ** 16n + 3n, 5n, 11n], [2n ** 96n - 1n, 2n ** 96n - 1n, 2n ** 96n - 1n]];
    for (const [a, b, c] of cases) {
      const run = books([[a, 'buyers'], [b, 'sellers'], [c, 'buyers']]);
      const units = (a + c) / 15n + b / 15n;
      expect(run.fit, `${a}/${b}/${c}`).toBe(2n * units);
      expect(run.platform).toBe(units);
      expect(run.pick).toBe(10n * units);
      expect(run.pool).toBe(2n * units);
      expect(run.pick + run.pool + run.fit + run.platform + run.carry.buyers + run.carry.sellers).toBe(a + b + c);
    }
  });

  it('Booking.t.sol: the choice is amount / 15 * 10 without a carry', () => {
    for (const amount of [15n, 16n, 1_000n, 123_456_789n]) expect(splitFifteenths(amount, 0n).pick).toBe((amount / 15n) * 10n);
  });

  it('refuses a negative fee or carry', () => {
    expect(() => splitFifteenths(-1n, 0n)).toThrow(RangeError);
    expect(() => splitFifteenths(0n, -1n)).toThrow(RangeError);
  });

  it('states its limit: for every box it shows the buyers’ fifteenths BEFORE the collection tip, carry included', () => {
    // Every box pays whoever collects its buyers' fees a tip of up to 5% first, when a collector is named and the
    // amount reaches the minimum (BoxReceiverV2.sol 130-135 without sources; ReceiverBooksV21.sol 262-273 with them,
    // where the remainder is also not carried, 293-297). The picture takes no tip and says so behind What happens' (?)
    // once approved. This pins that the model is the plain fifteenths whatever the choice, so nobody reads it as the
    // contract's exact figure.
    const anyBox = addTrade(NO_TRADES, 'buyers', 10n ** 18n);
    expect(anyBox.buyers).toBe(6_666_666_666_666_660n);
    expect(anyBox.carry.buyers).toBe(10n);
    // With the largest tip (5% of the fee) the contract's 10 parts would be lower; the model does not take it.
    const tipped = splitFifteenths(10n ** 16n - (10n ** 16n * 500n) / 10_000n, 0n).pick;
    expect(anyBox.buyers).toBeGreaterThan(tipped);
  });

  it('100 trades: 50 buys and 50 sells, every wei of every fee accounted for', () => {
    expect(HUNDRED_TRADES.filter((side) => side === 'buyers')).toHaveLength(50);
    let totals = NO_TRADES;
    for (const side of HUNDRED_TRADES) totals = addTrade(totals, side, E18);
    expect(totals.trades).toBe(100);
    expect(totals.traded).toBe(100n * E18);
    expect(totals.fees).toBe(100n * 10n ** 16n);
    expect(totals.buyers + totals.sellers + totals.pool + totals.squareHole + totals.carry.buyers + totals.carry.sellers).toBe(totals.fees);
    // Each side's 50 fees of 10^16 carry exactly as one fee of 50 * 10^16 would (the remainders add up).
    expect(totals.buyers).toBe(((50n * 10n ** 16n) / 15n) * 10n);
    expect(totals.carry.buyers).toBe((50n * 10n ** 16n) % 15n);
  });
});

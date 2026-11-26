import { describe, expect, it } from 'vitest';
import { BAND_TARGET_WEI, MISFITS_LAUNCH_SHAPE, REHEARSAL_SHAPE } from '../src/shape';
import {
  computeSwapStepExactIn,
  getAmount0Delta,
  getAmount1Delta,
  getSqrtPriceAtTick,
  MAX_TICK,
  mulDiv,
  mulDivRoundingUp,
  positionFeeFromSwap,
  Q96,
  tickAtSqrtPrice,
} from '../src/v4-math';
import { loadRecordedFixture } from './scripted-chain';
import { decodeBlockLogs } from '../src/events';
import { SEPOLIA_REHEARSAL } from '../src/config';

const S = REHEARSAL_SHAPE;

describe('v4 math port (exact against the pinned library and the live chain)', () => {
  it('reproduces TickMath at the known anchors', () => {
    expect(getSqrtPriceAtTick(0)).toBe(Q96);
    expect(getSqrtPriceAtTick(-MAX_TICK)).toBe(4_295_128_739n); // TickMath.MIN_SQRT_PRICE
    expect(getSqrtPriceAtTick(MAX_TICK)).toBe(1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n); // MAX_SQRT_PRICE
    expect(() => getSqrtPriceAtTick(MAX_TICK + 1)).toThrow(RangeError);
  });

  it('recomputes the Misfits launch shape (F40 L6): the smallest liquidity raising exactly the target, no dust', () => {
    const M = MISFITS_LAUNCH_SHAPE;
    const lower = getSqrtPriceAtTick(M.tickLower);
    const upper = getSqrtPriceAtTick(M.tickUpper);
    expect([lower, upper]).toEqual([S.sqrtPriceLowerX96, S.sqrtPriceUpperX96]);
    expect(mulDiv(M.curveTokens, Q96, upper - lower)).toBe(M.liquidity);
    expect(getAmount1Delta(lower, upper, M.liquidity, true)).toBe(M.curveTokensDeposited);
    expect(M.curveTokensDeposited).toBe(M.curveTokens);
    expect(getAmount0Delta(lower, upper, M.liquidity, false)).toBe(BAND_TARGET_WEI);
    expect(getAmount0Delta(lower, upper, M.liquidity - 1n, false)).toBe(BAND_TARGET_WEI - 1n);
    expect(M.curveRaiseWei).toBe(4_206_980_085_000_000_000n);
    // The 0.0015 ETH bootstrap buy on this shape (MisfitsGenesis burns what it bought).
    const step = computeSwapStepExactIn(upper, lower, M.liquidity, M.bootstrapWei, BigInt(M.lpFeePips));
    expect(step.amountOut).toBe(1_079_101_566_195_790_658_621_806n);
  });

  it("recomputes every constant of the rehearsal's deployed shape the way FitLaunchShape.t.sol did", () => {
    const lower = getSqrtPriceAtTick(S.tickLower);
    const upper = getSqrtPriceAtTick(S.tickUpper);
    expect(lower).toBe(S.sqrtPriceLowerX96);
    expect(upper).toBe(S.sqrtPriceUpperX96);
    // LiquidityAmounts.getLiquidityForAmount1 = mulDiv(amount1, Q96, √Pu − √Pl), floored.
    expect(mulDiv(S.curveTokens, Q96, upper - lower)).toBe(S.liquidity);
    expect(getAmount1Delta(lower, upper, S.liquidity, true)).toBe(S.curveTokensDeposited);
    expect(S.curveTokens - S.curveTokensDeposited).toBe(10_159n);
    expect(getAmount0Delta(lower, upper, S.liquidity, false)).toBe(S.curveRaiseWei);
    expect(S.tickLower % S.tickSpacing).toBe(0);
    expect(S.tickUpper % S.tickSpacing).toBe(0);
  });

  it('rounds like FullMath and SqrtPriceMath', () => {
    expect(mulDiv(7n, 3n, 2n)).toBe(10n);
    expect(mulDivRoundingUp(7n, 3n, 2n)).toBe(11n);
    expect(mulDivRoundingUp(6n, 3n, 2n)).toBe(9n);
    const a = getSqrtPriceAtTick(200_000);
    const b = getSqrtPriceAtTick(200_060);
    expect(getAmount0Delta(a, b, S.liquidity, true) - getAmount0Delta(a, b, S.liquidity, false)).toBe(1n);
    expect(getAmount0Delta(b, a, S.liquidity, false)).toBe(getAmount0Delta(a, b, S.liquidity, false));
  });

  it('finds the tick of a sqrt price by the library definition', () => {
    for (const tick of [-MAX_TICK, -1, 0, 1, 177_180, 204_039, 204_040, 204_060, MAX_TICK - 1]) {
      expect(tickAtSqrtPrice(getSqrtPriceAtTick(tick))).toBe(tick);
      if (tick < MAX_TICK - 1) expect(tickAtSqrtPrice(getSqrtPriceAtTick(tick + 1) - 1n)).toBe(tick);
    }
  });

  it('replays the live bootstrap swap exactly (genesis tx 0x0cdf2c47…, Sepolia block 11,811,774)', () => {
    const fixture = loadRecordedFixture();
    const events = decodeBlockLogs(fixture.logs, SEPOLIA_REHEARSAL);
    const swap = events.find((e) => e.kind === 'swap');
    const fees = events.find((e) => e.kind === 'fees_realised');
    const boot = events.find((e) => e.kind === 'bootstrapped');
    if (swap?.kind !== 'swap' || fees?.kind !== 'fees_realised' || boot?.kind !== 'bootstrapped') throw new Error('fixture lacks the bootstrap');
    const step = computeSwapStepExactIn(S.sqrtPriceUpperX96, S.sqrtPriceLowerX96, S.liquidity, S.bootstrapWei, BigInt(S.lpFeePips));
    expect(step.sqrtPriceNextX96).toBe(swap.sqrtPriceX96);
    expect(step.sqrtPriceNextX96).toBe(2_134_673_235_199_704_036_912_890_647_912_850n);
    expect(tickAtSqrtPrice(step.sqrtPriceNextX96)).toBe(swap.tick);
    expect(swap.tick).toBe(204_040);
    expect(step.amountOut).toBe(swap.amount1);
    expect(step.amountOut).toBe(boot.tokensOut);
    expect(-swap.amount0).toBe(step.amountIn + step.feeAmount);
    expect(step.amountIn).toBe(1_485_000_000_000_000n);
    expect(step.feeAmount).toBe(15_000_000_000_000n);
    // The hook's realised fee is a wei lower: fee growth and the position's share both round down.
    expect(positionFeeFromSwap(step.feeAmount, S.liquidity)).toBe(fees.ethFee);
    expect(fees.ethFee).toBe(14_999_999_999_999n);
  });
});

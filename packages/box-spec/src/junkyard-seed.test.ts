import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { boxCurve } from './layout-v2';
import { getAmount0Delta, getAmount1Delta, getSqrtPriceAtTick, getTickAtSqrtPrice, Q96 } from './v4-math';

it('G1-C1 bounds the saved tGOLD quote against PoolManager steps and still seeds the shop', () => {
  const example = JSON.parse(readFileSync(new URL('../examples/v2/junkyard.json', import.meta.url), 'utf8'));
  const quote = JSON.parse(readFileSync(new URL('../../chain/scripts/sepolia-launch-packs/junkyard/creator-buy.json', import.meta.url), 'utf8'));
  const raise = BigInt(example.raise.amount);
  const ethRaise = 4206980085000000000n;
  const creatorBuyP = BigInt(quote.creatorBuy);
  const bootstrapP = (1500000000000000n * raise + ethRaise - 1n) / ethRaise;
  expect(example.priceCoin.symbol).toBe('TEST_GOLD');
  expect(raise).toBe(1000000000000000000n);
  expect(quote.raise).toBe(raise.toString());
  expect(quote.bootstrap).toBe(bootstrapP.toString());
  expect(quote.factoryPayment).toBe((bootstrapP + creatorBuyP).toString());
  const c = boxCurve(raise, false);
  // Analytical estimate: one rounding per swap, ignoring bitmap-word steps.
  const afterBuy = (spot: bigint, input: bigint) => {
    const numerator = c.liquidity * Q96;
    const denominator = numerator + input * 990000n / 1000000n * spot;
    return (numerator * spot + denominator - 1n) / denominator;
  };
  const start = afterBuy(c.sqrtPriceStartX96, bootstrapP);
  const end = afterBuy(start, creatorBuyP);
  const estimated = getAmount1Delta(end, start, c.liquidity, false);

  // Independent pinned v4 Pool.swap / TickBitmap / SwapMath path, Q as currency0,
  // only the curve endpoints initialized, 1% LP fee and no protocol fee. Even an
  // uninitialized word boundary ends a step: input/fee round up, output rounds down.
  const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
  let spot = c.sqrtPriceStartX96, tick = c.tickStart, liquidity = 0n;
  const steps: { tickNext: number; input: bigint; fee: bigint; output: bigint }[] = [];
  const swap = (input: bigint) => {
    let remaining = input, output = 0n;
    while (remaining > 0n) {
      expect(spot).toBeGreaterThan(c.sqrtPriceEndX96);
      const wordStart = Math.floor(Math.floor(tick / 60) / 256) * 256 * 60;
      const initialized = [c.tickUpper, c.tickLower].find(t => t <= tick && t >= wordStart);
      const tickNext = initialized ?? wordStart;
      const target = getSqrtPriceAtTick(tickNext);
      const lessFee = remaining * 990000n / 1000000n;
      const toTarget = getAmount0Delta(target, spot, liquidity, true);
      const stepInput = lessFee >= toTarget ? toTarget : lessFee;
      const fee = lessFee >= toTarget ? ceil(stepInput * 10000n, 990000n) : remaining - stepInput;
      const next = lessFee >= toTarget ? target : ceil((liquidity * Q96) * spot, liquidity * Q96 + stepInput * spot);
      const stepOutput = getAmount1Delta(next, spot, liquidity, false);
      remaining -= stepInput + fee;
      output += stepOutput;
      steps.push({ tickNext, input: stepInput, fee, output: stepOutput });
      if (next === target) {
        if (initialized === c.tickUpper) liquidity += c.liquidity;
        if (initialized === c.tickLower) liquidity -= c.liquidity;
        tick = tickNext - 1;
      } else tick = getTickAtSqrtPrice(next);
      spot = next;
    }
    return output;
  };
  swap(bootstrapP);
  const creatorStepStart = steps.length;
  const acquired = swap(creatorBuyP);
  // Prior af1 local-EVM measurement, independent of the analytical estimator.
  expect(acquired).toBe(180195814884384475344482735n);
  expect(steps.length - creatorStepStart).toBeGreaterThan(1);
  expect(creatorBuyP).toBe(71278844301225191n);
  expect(acquired).toBeGreaterThan(170000000n * 10n ** 18n);
  expect(acquired).toBeLessThan(190000000n * 10n ** 18n);
  const originalTarget = 180195814884384477544867602n;
  expect(quote.targetTokens).toBe(originalTarget.toString());
  expect(estimated).toBe(180195814884384478029602580n);
  expect(estimated - acquired).toBe(2685119845n);
  expect(originalTarget - acquired).toBe(2200384867n);
  expect(quote.outputPolicy).toBe('minimum-for-measured-preset');
  expect(quote.tokensOut).toBeUndefined();
  expect(quote.holderRemainder).toBeUndefined();
  expect(quote.estimatedTokensOut).toBe(estimated.toString());
  expect(quote.minimumTokensOut).toBe(acquired.toString());
  expect(quote.targetShortfallBound).toBe((originalTarget - acquired).toString());
  expect(quote.estimateShortfallBound).toBe((estimated - acquired).toString());
  expect(getAmount1Delta(afterBuy(start, creatorBuyP - 1n), start, c.liquidity, false)).toBeLessThan(originalTarget);
  const seed = 180000000n * 10n ** 18n;
  expect(BigInt(example.contents.shop.seedT)).toBe(seed);
  expect(quote.seedTokens).toBe(seed.toString());
  expect(acquired - seed).toBe(195814884384475344482735n);
  expect(quote.minimumHolderRemainder).toBe((acquired - seed).toString());
  expect(example.creator.kind).toBe('safe');
  expect(example.fees.sellers).toEqual({ choice: 'shop', ceilingPreset: '2' });
});

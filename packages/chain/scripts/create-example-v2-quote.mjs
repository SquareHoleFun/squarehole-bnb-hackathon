import './register-ts.mjs';
import assert from 'node:assert/strict';
const { boxCurve } = await import('../../box-spec/src/layout-v2.ts');
const { getAmount1Delta, Q96 } = await import('../../box-spec/src/v4-math.ts');

// Historical J1 output is an analytical search target, not a guaranteed swap output.
export const JUNKYARD_TARGET_T = 180195814884384477544867602n;
/** Two-swap estimate. PoolManager also rounds at bitmap-word boundaries, omitted here. */
export function estimateJunkyardTokensOut(raise, bootstrap, buy) {
  const c = boxCurve(raise, false);
  const after = (spot, input) => {
    const numerator = c.liquidity * Q96;
    const denominator = numerator + input * 990000n / 1000000n * spot;
    return (numerator * spot + denominator - 1n) / denominator;
  };
  const start = after(c.sqrtPriceStartX96, bootstrap);
  return getAmount1Delta(after(start, buy), start, c.liquidity, false);
}

/** Minimum input reaching the analytical target. A fresh actual-chain quote/simulation is required.
 * Only junkyardMinimumTokensOut's measured preset has an offline output floor; other inputs have none.
 */
export function quoteJunkyardCreatorBuy(raise, bootstrap) {
  assert.ok(raise > 0n && bootstrap > 0n && bootstrap < raise, 'invalid raise or bootstrap');
  let lo = 0n;
  let hi = raise - bootstrap;
  assert.ok(estimateJunkyardTokensOut(raise, bootstrap, hi) >= JUNKYARD_TARGET_T, 'raise cannot cover Junkyard seed');
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (estimateJunkyardTokensOut(raise, bootstrap, mid) < JUNKYARD_TARGET_T) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}

/** Output floor for the af1 local-EVM preset ONLY: Q currency0, initial curve endpoints,
 * bootstrap then creator swap, 10000-pip LP fee, zero protocol fee. The target shortfall
 * is 2200384867 raw TRASH (estimate overstatement: 2685119845). junkyard-seed.test.ts
 * reproduces PoolManager's step/rounding path independently. This is not a live quote.
 */
export function junkyardMinimumTokensOut(raise, bootstrap, buy) {
  assert.deepEqual([raise, bootstrap, buy], [1000000000000000000n, 356550297290034n, 71278844301225191n],
    'minimum output is only bounded for the measured preset; obtain a fresh actual-chain quote');
  return JUNKYARD_TARGET_T - 2200384867n;
}

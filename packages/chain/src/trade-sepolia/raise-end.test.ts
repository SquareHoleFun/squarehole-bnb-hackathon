import { describe, expect, it } from 'vitest';
import { boxCurve } from '../../../box-spec/src/layout-v2';
import { COIN, COORDINATOR, fixture, LOCAL, USER } from './test-support';
import { prepareTradeSepolia, type TradePreparation } from './trade';

const planOf = (result: TradePreparation) => {
  if (!result.ok) throw new Error(result.reason);
  return result.plan;
};

describe('SH-194: the quote identifies a buy that fills the raise', () => {
  it.each([6, 18])('uses the curve end at the plan block, before and after approval (%i decimals)', async decimals => {
    const unit = 10n ** BigInt(decimals);
    const amount = 5n * unit;
    const f = fixture({ p: COIN, raise: unit });
    const before = planOf(await f.prepare('buy', amount));
    expect(before.expectedInput).toBeLessThan(amount);
    expect(before.expectedSqrtPriceX96).toBe(boxCurve(unit, false).sqrtPriceEndX96);
    expect(before.raiseEnd).toEqual({ input: before.expectedInput });
    f.state.allowance = amount;
    const after = planOf(await f.prepare('buy', amount));
    expect(after.raiseEnd).toEqual(before.raiseEnd);
    expect(after.expectedInput).toBe(before.expectedInput);
    // The exact last input can fill the raise without leaving a remainder.
    const exact = planOf(await f.prepare('buy', before.expectedInput as bigint));
    expect(exact.raiseEnd).toEqual({ input: exact.amountIn });
    expect(exact.expectedInput).toBe(exact.amountIn);
  });

  it('a pressed price limit stops a partial buy before the raise end', async () => {
    const f = fixture({ p: COIN });
    const curve = boxCurve(f.state.raise, false);
    const limit = (curve.sqrtPriceStartX96 + 3n * curve.sqrtPriceEndX96) / 4n;
    const plan = planOf(await prepareTradeSepolia({ rpc: f.rpc, chainId: 31337, coordinator: COORDINATOR,
      from: USER, side: 'buy', amountIn: 5n * 10n ** 18n, localDeployment: LOCAL,
      floor: { sqrtPriceLimitX96: limit, minimumOutput: null } }));
    expect(plan.expectedInput).toBeLessThan(plan.amountIn);
    expect(plan.expectedSqrtPriceX96).toBe(limit);
    expect(plan.raiseEnd).toBeNull();
  });

  it.each([[3, 'buy'], [3, 'sell'], [5, 'buy'], [5, 'sell']] as const)('does not label an ordinary phase %i %s as filling the raise', async (phase, side) => {
    expect(planOf(await fixture({ phase }).prepare(side)).raiseEnd).toBeNull();
  });

  it.each([0n, 931_974n])('a closing window buy includes the retained launch tax (%s pips)', async taxPips => {
    const amount = 50_000_003n;
    const f = fixture({ phase: 2, p: COIN, raise: 1_000_000n, taxPips });
    const before = planOf(await f.prepare('buy', amount));
    const pool = planOf(await fixture({ p: COIN, raise: 1_000_000n }).prepare('buy', amount));
    const spent = pool.expectedInput as bigint;
    const kept = (spent * taxPips + (1_000_000n - taxPips) - 1n) / (1_000_000n - taxPips);
    expect(before.raiseEnd).toEqual({ input: spent + kept });
    expect(before.raiseEnd?.input).toBeLessThan(amount);
    // Display-only: the existing window minimum-output/one-press guard still uses the whole typed input.
    expect(before.expectedInput).toBeNull();
    f.state.allowance = amount;
    const after = planOf(await f.prepare('buy', amount));
    expect(after.raiseEnd).toEqual(before.raiseEnd);
    expect(Object.isFrozen(after.raiseEnd)).toBe(true);
    expect(after.expectedInput).toBeNull();
  });
});

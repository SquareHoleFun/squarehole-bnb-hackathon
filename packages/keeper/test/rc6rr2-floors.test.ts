import { describe, expect, it } from 'vitest';
import { decide, openBudget } from '../src/decide';
import { feesFor, type GasConstraints } from '../src/gas';
import { JOBS } from '../src/jobs';
import type { Sim } from '../src/types';
import { options } from './support/v2';

// RC6RR2-HP-2 / SH-RC7-HOOK-PAGE: signed floors cover twice the integrator's cold exhausted-tip measurements.
const OSAKA: GasConstraints = { fork: 'osaka', transactionCap: 16_777_216n, blockGasLimit: 60_000_000n };
const CANCUN: GasConstraints = { fork: 'cancun', transactionCap: null, blockGasLimit: 60_000_000n };
const AMSTERDAM: GasConstraints = { fork: 'amsterdam', transactionCap: 16_777_216n, blockGasLimit: 60_000_000n, stateGas: 0n };
const GWEI = 1_000_000_000n;
const ctx = (gasConstraints: GasConstraints) => ({ fees: feesFor(GWEI, 50_000_000n), budget: openBudget(undefined, 1n, 0n),
  limits: options().limits, privateEndpoint: false, version: 2 as const, gasConstraints });
const press = (estimate: bigint, zeroOutput = false): Sim => ({ ok: true, tipWei: null, estimate, ...(zeroOutput ? { zeroOutput: true as const } : {}) });

describe('RC6RR2-HP-2 and RR2-LIM-1: the positive-P floor follows the destination fork', () => {
  it('signs a positive-P press at 8,200,000 before Amsterdam and 16,000,000 on it', () => {
    for (const rules of [OSAKA, CANCUN]) expect(decide('sellFees', press(1_500_000n), ctx(rules))).toMatchObject({ send: true, gas: 8_200_000n });
    expect(decide('sellFees', press(1_500_000n), ctx(AMSTERDAM))).toMatchObject({ send: true, gas: 16_000_000n });
    // A larger pending estimate still wins over either floor.
    expect(decide('sellFees', press(9_000_000n), ctx(OSAKA))).toMatchObject({ send: true, gas: 10_800_000n });
  });
  it('8,200,000 keeps twice the cold 32-source press whose tip exhausts the stipend before Amsterdam (4,001,971)', () => {
    expect(8_200_000n).toBeGreaterThanOrEqual(2n * 4_001_971n);
    expect(16_000_000n).toBeGreaterThanOrEqual(2n * 7_668_544n);
  });
  it('at a 1 gwei base fee one press before Amsterdam reserves 16.81 mETH, about a third of the 51 mETH ordinary room', () => {
    const d = decide('sellFees', press(1_500_000n), ctx(OSAKA));
    expect(d).toMatchObject({ send: true, costWei: 8_200_000n * 2_050_000_000n });
    const { oursWeiPerDay, reserveWeiPerDay } = options().limits;
    expect(d.send && 3n * d.costWei).toBeLessThanOrEqual(oursWeiPerDay - reserveWeiPerDay);
  });
  it('still publishes the larger floor as the job allowance', () => {
    expect(JOBS.find(j => j.name === 'sellFees')?.gasPerRun).toBe(16_000_000n);
  });
});

describe('RC6RR2-KEEPER-1: a simulated zero-P page pays no tip and has its own floor', () => {
  it('signs a zero-P press at 3,500,000 on every fork, more than twice the cold 32-dust page (1,581,472 on Amsterdam)', () => {
    expect(decide('sellFees', press(760_852n, true), ctx(OSAKA))).toMatchObject({ send: true, gas: 3_500_000n });
    expect(decide('sellFees', press(760_852n, true), ctx(CANCUN))).toMatchObject({ send: true, gas: 3_500_000n });
    expect(decide('sellFees', press(1_581_472n, true), ctx(AMSTERDAM))).toMatchObject({ send: true, gas: 3_500_000n });
    expect(3_500_000n).toBeGreaterThanOrEqual(2n * 1_581_472n);
  });
  it('never lowers the floor of a positive-P page, and a larger zero-P estimate still wins', () => {
    expect(decide('sellFees', press(760_852n), ctx(OSAKA))).toMatchObject({ gas: 8_200_000n });
    expect(decide('sellFees', press(4_000_000n, true), ctx(OSAKA))).toMatchObject({ gas: 4_800_000n });
    // Only sellFees has a zero-output floor.
    expect(decide('collect', press(100_000n, true), ctx(OSAKA))).toMatchObject({ gas: 5_000_000n });
  });
});

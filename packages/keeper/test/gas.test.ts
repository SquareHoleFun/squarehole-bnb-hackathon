import { describe, expect, it } from 'vitest';
import { GasAdmissionError, type GasConstraints, costWei, estimatePending, feesFor, gasLimitFrom, pendingFees, reservedCostWei, transactionGas, tipPays } from '../src/gas';

const GWEI = 1_000_000_000n;

describe('gas from an estimate with fee fields against the pending block (core-v2-plan.md:312)', () => {
  it('adds the larger of 20% and 150k to the estimate', () => {
    expect(gasLimitFrom(100_000n)).toBe(250_000n);
    expect(gasLimitFrom(750_000n)).toBe(900_000n);
    expect(gasLimitFrom(2_000_000n)).toBe(2_400_000n);
  });

  it('reads the pending block\'s base fee and estimates against the pending block with fee fields', async () => {
    const calls: Record<string, unknown>[] = [];
    const client = {
      request: async (args: { method: 'eth_getBlockByNumber'; params: readonly ['pending', false] }) => {
        calls.push(args);
        return { baseFeePerGas: '0xb2d05e00', transactions: [] };
      },
      estimateGas: async (args: Record<string, unknown>) => {
        calls.push(args);
        return 400_000n;
      },
    };
    const fees = await pendingFees(client, GWEI / 10n);
    expect(fees).toEqual({ baseFeePerGas: 3n * GWEI, maxPriorityFeePerGas: GWEI / 10n, maxFeePerGas: 6n * GWEI + GWEI / 10n });
    const req = { account: '0x00000000000000000000000000000000000000a1', to: '0x00000000000000000000000000000000000000b2', data: '0x1234' } as const;
    expect(await estimatePending(client, req, fees)).toBe(400_000n);
    expect(calls[0]).toEqual({ method: 'eth_getBlockByNumber', params: ['pending', false] });
    expect(calls[1]).toMatchObject({ ...req, blockTag: 'pending', maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
  });

  it('budgets failure and hatch at the measured fail-safe floor', () => {
    expect(transactionGas('fail', 100_000n)).toBe(15_000_000n);
    expect(transactionGas('failClosed', 4_000_000n)).toBe(15_000_000n);
  });

  it.each(['cancun', 'osaka', 'amsterdam'] as const)('RC7: signs collect by fork (%s), with higher estimates still winning', fork => {
    const rules = { fork, transactionCap: 16_777_216n, blockGasLimit: 30_000_000n,
      ...(fork === 'amsterdam' ? { stateGas: 0n } : {}) };
    const floor = fork === 'amsterdam' ? 8_000_000n : 5_000_000n; // part 3 review: 8M on Amsterdam
    expect(transactionGas('collect', 100_000n, rules)).toBe(floor);
    expect(transactionGas('collect', 7_000_000n, rules)).toBe(8_400_000n);
    expect(() => transactionGas('collect', 100_000n, { ...rules, blockGasLimit: floor - 1n }))
      .toThrow(/required floor/);
    expect(reservedCostWei('collect', 100_000n, feesFor(1n, 1n), rules)).toBe(floor * 3n);
    expect(transactionGas('collect', 100_000n, rules, 1)).toBe(250_000n);
  });

  it('defers malformed pending limits as an admission error, before any reservation', () => {
    const rules = { fork: 'osaka', transactionCap: 16_777_216n, blockGasLimit: 30_000_000n } as const;
    for (const field of ['blockGasLimit', 'transactionCap', 'stateGas'] as const) {
      for (const value of [undefined, '30000000', 30_000_000, null]) {
        if (field === 'stateGas' && value === undefined) continue;
        expect(() => gasLimitFrom(100_000n, 0n, { ...rules, [field]: value } as unknown as GasConstraints))
          .toThrow(GasAdmissionError);
      }
    }
  });

  it('weighs a tip against what the step costs at the pending fees', () => {
    const fees = feesFor(10n * GWEI, GWEI);
    expect(costWei(100_000n, fees)).toBe(1_100_000n * GWEI);
    expect(tipPays(1_100_000n * GWEI, 100_000n, fees)).toBe(true);
    expect(tipPays(1_099_999n * GWEI, 100_000n, fees)).toBe(false);
    expect(tipPays(null, 100_000n, fees)).toBe(false);
  });
});

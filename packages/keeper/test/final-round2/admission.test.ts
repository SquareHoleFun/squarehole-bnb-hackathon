import { describe, expect, it } from 'vitest';
import { charge, decide, openBudget } from '../../src/decide';
import { feesFor, gasLimitFrom, transactionGas } from '../../src/gas';
import { runTick, type KeeperState } from '../../src/run';
import { addr, box, options, quiet, v2, world } from '../support/v2';

const CAP = 16_777_216n;
const osaka = { fork: 'osaka', transactionCap: CAP, blockGasLimit: 30_000_000n } as const;
const fees = feesFor(1n, 1n);
const limits = { ...options().limits, oursWeiPerDay: 1_000_000_000n,
  totalWeiPerDay: 1_000_000_000n, reserveWeiPerDay: 0n };
const ctx = () => ({ fees, budget: openBudget(undefined, 100n, 0n), limits, privateEndpoint: false });

describe('FINAL2-OC02 gas admission before durable reservation', () => {
  it.each([13_981_014n, 14_000_000n, CAP])('caps padding without cutting the %s estimate', estimate => {
    const gas = transactionGas('shopReturn', estimate, osaka);
    expect(gas).toBeLessThanOrEqual(CAP);
    expect(gas).toBeGreaterThanOrEqual(estimate);
  });

  it('refuses an estimate or named floor above the destination limit', () => {
    expect(() => transactionGas('collect', CAP + 1n, osaka)).toThrow(/gas/);
    expect(() => transactionGas('shopReturn', 100_000n, { ...osaka, transactionCap: 1_999_999n })).toThrow(/gas/);
    const d = decide('collect', { ok: true, estimate: CAP + 1n, tipWei: 10n ** 30n }, ctx());
    expect(d).toMatchObject({ send: false, why: expect.stringContaining('gas') });
    expect(charge(ctx().budget, 'collect', d)).toEqual(ctx().budget);
  });

  it('uses block room for padding but refuses room below the estimate or floor', () => {
    expect(transactionGas('shopReturn', 14_000_000n, { ...osaka, blockGasLimit: 14_500_000n })).toBe(14_500_000n);
    expect(() => transactionGas('shopReturn', 14_000_000n, { ...osaka, blockGasLimit: 13_999_999n })).toThrow(/gas/);
    expect(() => transactionGas('shopReturn', 100_000n, { ...osaka, blockGasLimit: 1_999_999n })).toThrow(/gas/);
  });

  it('preserves Amsterdam state gas separately from the execution cap', () => {
    const rules = { ...osaka, fork: 'amsterdam', stateGas: 10_000_000n } as const;
    expect(transactionGas('collect', 24_000_000n, rules)).toBe(CAP + rules.stateGas);
    expect(transactionGas('collect', 24_000_000n, { ...rules, blockGasLimit: 25_000_000n })).toBe(25_000_000n);
    expect(() => transactionGas('collect', CAP + rules.stateGas + 1n, rules)).toThrow(/gas/);
    expect(() => transactionGas('collect', 24_000_000n, { ...rules, blockGasLimit: 23_999_999n })).toThrow(/gas/);
  });

  it('uses explicit pre-Osaka rules and rejects invalid or unproven gas components', () => {
    expect(transactionGas('collect', 20_000_000n, { fork: 'cancun', transactionCap: null, blockGasLimit: 30_000_000n })).toBe(24_000_000n);
    for (const invalid of [-1n, 0n]) expect(() => gasLimitFrom(invalid)).toThrow(/gas/);
    expect(() => gasLimitFrom(100n, -1n)).toThrow(/gas/);
    expect(() => transactionGas('collect', 100n, { ...osaka, fork: 'amsterdam' })).toThrow(/gas/);
    expect(() => transactionGas('collect', 100n, { ...osaka, fork: 'amsterdam', stateGas: 101n })).toThrow(/gas/);
    expect(() => transactionGas('collect', 100n, { ...osaka, stateGas: 1n })).toThrow(/gas/);
  });

  // run.ts is unowned. This local consumer double pins its exact required handoff:
  // pass destination constraints to decide, then checkpoint/send the returned gas.
  it('returns one constrained envelope for a consumer to reserve durably before sending', async () => {
    const d = decide('shopReturn', { ok: true, estimate: 14_000_000n, tipWei: null },
      { ...ctx(), gasConstraints: { ...osaka, blockGasLimit: 14_500_000n } });
    expect(d).toMatchObject({ send: true, gas: 14_500_000n, costWei: 43_500_000n });
    if (!d.send) throw new Error('admission refused');
    const events: string[] = [];
    const reserved = charge(ctx().budget, 'shopReturn', d);
    const checkpoint = async () => { events.push('checkpoint'); };
    await checkpoint();
    const send = async (gas: bigint) => {
      expect(reserved.totalWei).toBe(gas * fees.maxFeePerGas);
      events.push('send');
    };
    await send(d.gas);
    expect(events).toEqual(['checkpoint', 'send']);
  });

  it.each(['success', 'timeout', 'disk failure', 'over cap', 'budget'] as const)(
    'production runner reserves the admitted Osaka envelope: %s', async mode => {
      const w = world(box({ failed: true, graduated: false, v2: { ...v2, m2: [
        { job: 'shopReturn', to: addr(70), fn: 'returnStarter', args: [[0n]], key: 'cap-return' },
      ] } }));
      const saved: KeeperState[] = [];
      const sent: bigint[] = [];
      const tick = runTick({ read: async () => w,
        simulate: async c => ({ ok: c.job === 'shopReturn', tipWei: null, estimate: mode === 'over cap' ? CAP + 1n : 14_000_000n }),
        send: async (_c, gas) => {
          expect(saved.at(-1)?.budget?.totalWei).toBe(gas * fees.maxFeePerGas);
          expect(gas).toBe(CAP);
          sent.push(gas);
          if (mode === 'timeout') throw new Error('accepted then timeout');
          return 'local';
        },
      }, {}, { ...options(), dryRun: false, priorityFeeWei: 1n,
        limits: mode === 'budget' ? { ...limits, totalWeiPerDay: CAP * 3n - 1n } : limits,
        checkpoint: async state => {
          if (mode === 'disk failure') throw new Error('disk failure');
          saved.push(state);
        },
      }, quiet);
      if (mode === 'disk failure') {
        await expect(tick).rejects.toThrow('disk failure');
        expect(sent).toEqual([]);
        return;
      }
      const out = await tick;
      const sends = mode === 'success' || mode === 'timeout';
      expect(sent).toEqual(sends ? [CAP] : []);
      expect(out.state.budget.totalWei).toBe(sends ? CAP * 3n : 0n);
      expect(out.state.budget.oursWei).toBe(out.state.budget.totalWei);
      expect(out.report.sent).toHaveLength(mode === 'success' ? 1 : 0);
    });
});

import { describe, expect, it, vi } from 'vitest';
import { parseTransaction, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ViemChain } from '../src/chain';
import { describeConfig, destinationGasAdapters, destinationGasReader, noReservoirEstimator } from '../src/config';
import { COLLECT_FLOORS, EIP7825_GAS_CAP as CAP, GasAdmissionError, SELL_FEES_FLOORS, V2_GAS_FLOORS,
  gasLimitFrom, transactionGas, type GasClient } from '../src/gas';
import { emptyMemory, plan } from '../src/plan';
import { runTick } from '../src/run';
import { fakeClient, fakeNode } from './support/fake-rpc';
import { addr, box, options, quiet, v2, world } from './support/v2';

const policy = { fork: 'amsterdam', transactionCap: CAP } as const;
const request = { account: addr(1), to: addr(2), data: '0x1234', value: 1n,
  maxFeePerGas: 3n, maxPriorityFeePerGas: 1n, blockTag: 'pending' } as const;
// Integrator's read-only Sepolia captures: reth/geth and Erigon (transfer).
const recorded = { transfer: '0x32a1f', erigonTransfer: '0x31f38', store: '0x1ec99',
  stores148: '0xfac224', stores200: '0x152c67c' } as const;

describe('AMST-01 no-reservoir pending estimate', () => {
  it.each(Object.values(recorded))('forwards exactly one pending request and freezes the pair (%s)', async hex => {
    const estimateGas = vi.fn<GasClient['estimateGas']>(async () => BigInt(hex));
    const pair = await noReservoirEstimator({ estimateGas })(request);
    expect(estimateGas).toHaveBeenCalledExactlyOnceWith(request);
    expect(estimateGas.mock.calls[0]?.[0]).toBe(request);
    expect(pair).toEqual({ gas: BigInt(hex), stateGas: 0n });
    expect(Object.isFrozen(pair)).toBe(true);
  });

  it.each([undefined, null, '207391', 207391, 0n, -1n])('rejects malformed reply %s', async reply => {
    const client = { estimateGas: async () => reply } as unknown as Pick<GasClient, 'estimateGas'>;
    await expect(noReservoirEstimator(client)(request)).rejects.toBeInstanceOf(GasAdmissionError);
  });

  it.each(['cancun', 'osaka', 'amsterdam'] as const)('selects the estimator only on Amsterdam: %s', async fork => {
    const g = destinationGasAdapters({ ...policy, fork }, { estimateGas: async () => 100n });
    expect(typeof g.reader).toBe('function');
    expect(typeof g.estimator).toBe(fork === 'amsterdam' ? 'function' : 'undefined');
    const candidate = { job: 'collect', key: 'test', to: addr(2), fn: 'collect', args: [] } as const;
    if (g.estimator) {
      const pair = await g.estimator(request);
      expect(await g.reader(candidate, 100n, { timestamp: 1n, gasLimit: CAP }, pair)).toEqual({ ...policy, stateGas: 0n });
      await expect(g.reader(candidate, 101n, { timestamp: 1n, gasLimit: CAP }, pair)).rejects.toThrow('pending estimate mismatch');
    }
    const summary = describeConfig({ ...options(), destinationGas: { ...policy, fork } });
    expect(summary.includes('state gas: no reservoir (limit <= cap)')).toBe(fork === 'amsterdam');
  });

  it('pins EIP-8037/8038 state charges and recorded estimation tolerance using bigint', () => {
    const stateCost = 1530n;
    const newAccount = 120n * stateCost;
    const newSlot = 64n * stateCost;
    expect(21_000n + newAccount).toBe(204_600n);
    expect(newSlot).toBe(97_920n);
    const exactStore = 21_000n + 2n * 3n + 2_100n + 4_000n + newSlot;
    expect(exactStore).toBe(125_026n);
    for (const [hex, exact] of [[recorded.transfer, 204_600n], [recorded.erigonTransfer, 204_600n],
      [recorded.store, exactStore]] as const) {
      expect(BigInt(hex)).toBeGreaterThanOrEqual(exact);
      expect(BigInt(hex) * 1000n).toBeLessThanOrEqual(exact * 1015n);
    }
    expect(BigInt(recorded.stores148)).toBe(16_433_700n);
    expect(BigInt(recorded.stores200)).toBe(22_201_980n);
  });
});

describe('AMST-02 same cap and floors as Osaka with a zero reservoir', () => {
  const estimates = [1n, 15_000n, 204_600n, 207_391n, 0xfac224n, 0xfe24c5n, CAP - 1n, CAP, CAP + 1n, 0x152c67cn];
  const outcome = (f: () => bigint) => {
    try {
      const gas = f();
      expect(gas).toBeLessThanOrEqual(CAP);
      return gas;
    } catch (error) {
      expect(error).toBeInstanceOf(GasAdmissionError);
      return (error as Error).message;
    }
  };
  it('checks every estimate, floor, block limit and both full and smaller configured caps', () => {
    for (const estimate of estimates) for (const blockGasLimit of [200_000_000n, 30_000_000n, 16_000_000n, 1_000_000n]) {
      for (const transactionCap of [CAP, 1_000_000n]) {
        const osaka = { fork: 'osaka', transactionCap, blockGasLimit } as const;
        const amsterdam = { ...osaka, fork: 'amsterdam', stateGas: 0n } as const;
        for (const floor of [...Object.values(V2_GAS_FLOORS), ...Object.values(SELL_FEES_FLOORS), ...Object.values(COLLECT_FLOORS)]) {
          expect(outcome(() => gasLimitFrom(estimate, floor, amsterdam))).toEqual(outcome(() => gasLimitFrom(estimate, floor, osaka)));
        }
        // sellFees and (since RC7-RECEIVER-QUOTA af2) collect sign at fork-specific floors, checked below.
        for (const job of Object.keys(V2_GAS_FLOORS).filter(job => job !== 'sellFees' && job !== 'collect')) {
          expect(outcome(() => transactionGas(job, estimate, amsterdam))).toEqual(outcome(() => transactionGas(job, estimate, osaka)));
        }
        for (const rules of [amsterdam, osaka]) for (const zeroOutput of [false, true]) {
          const floor = zeroOutput ? SELL_FEES_FLOORS.zeroOutput
            : rules.fork === 'amsterdam' ? SELL_FEES_FLOORS.amsterdam : SELL_FEES_FLOORS.beforeAmsterdam;
          expect(outcome(() => transactionGas('sellFees', estimate, rules, 2, zeroOutput)))
            .toEqual(outcome(() => gasLimitFrom(estimate, floor, rules)));
        }
        for (const rules of [amsterdam, osaka]) {
          const floor = rules.fork === 'amsterdam' ? COLLECT_FLOORS.amsterdam : COLLECT_FLOORS.beforeAmsterdam;
          expect(outcome(() => transactionGas('collect', estimate, rules))).toEqual(outcome(() => gasLimitFrom(estimate, floor, rules)));
        }
      }
    }
  });
});

function runner(estimateGas: Hex | (() => never), paired = true, drand = false) {
  const account = privateKeyToAccount(`0x${'11'.repeat(32)}`); // public test key, fake transport only
  const cfg = { ...options(), keeper: account.address, dryRun: false, destinationGas: policy, priorityFeeWei: 1n };
  const node = fakeNode({ estimateGas });
  const pub = fakeClient(node);
  const c = drand
    ? { job: 'drandRequestWord', to: addr(70), fn: 'requestGraduationWord', args: [], key: 'amsterdam-drand' } as const
    : { job: 'shopReturn', to: addr(70), fn: 'returnStarter', args: [[0n]], key: 'amsterdam-return' } as const;
  node.calls[`${c.to}:${c.fn}`] = () => drand ? undefined : 1n;
  const g = destinationGasAdapters(policy, pub);
  const chain = new ViemChain(cfg, pub, account.address, { public: account, private: null }, null, quiet,
    destinationGasReader(policy), paired ? g.estimator : undefined);
  const w = c.job === 'shopReturn' ? world(box({ failed: true, graduated: false, v2: { ...v2, m2: [c] } }))
    : { ...world(), boxes: [], drand: [c] };
  // Discovery is independent; simulation, pending admission, signing and sending use the production adapter.
  vi.spyOn(chain, 'read').mockResolvedValue(w);
  return { cfg, node, chain, w, c };
}

describe('AMST-03 ViemChain and runTick on a fake Amsterdam node', () => {
  it('pads a drand job with no floor by 150,000 and signs through the same adapter', async () => {
    const h = runner(recorded.store, true, true);
    const out = await runTick(h.chain, {}, h.cfg, quiet);
    expect(out.report.sent).toEqual([expect.objectContaining({ job: 'drandRequestWord', gas: 276_105n })]);
    expect(h.node.sent).toHaveLength(1);
    for (const sent of h.node.sent) expect(parseTransaction(sent.raw).gas).toBe(276_105n);
  });
  it.each([[recorded.stores148, CAP], [recorded.store, V2_GAS_FLOORS.shopReturn]] as const)(
    'signs the admitted limit for %s', async (hex, expected) => {
      const h = runner(hex);
      const out = await runTick(h.chain, {}, h.cfg, quiet);
      expect(out.report.sent).toContainEqual(expect.objectContaining({ job: h.c.job, gas: expected }));
      expect(h.node.sent).toHaveLength(1);
      for (const sent of h.node.sent) expect(parseTransaction(sent.raw).gas).toBe(expected);
      expect(out.state.budget.totalWei).toBe(expected * 3n);
    });

  it('defers an estimate above the cap without charge or loss of eligibility', async () => {
    const h = runner(recorded.stores200);
    const mem = emptyMemory();
    const out = await runTick(h.chain, { mem }, h.cfg, quiet);
    expect(out.report.skipped).toContainEqual(expect.objectContaining({ job: h.c.job, why: 'gas admission: estimate exceeds destination limit' }));
    expect(out.state.budget.totalWei).toBe(0n);
    expect(out.state.mem.attempts[h.c.key]).toBeUndefined();
    expect(plan(h.w, out.state.mem, h.cfg).candidates).toContainEqual(expect.objectContaining({ key: h.c.key }));
    expect(h.node.sent).toEqual([]);
    h.node.estimateGas = recorded.store;
    const retry = await runTick(h.chain, out.state, h.cfg, quiet);
    expect(retry.report.sent.some(c => c.job === h.c.job)).toBe(true);
  });

  it.each(['transport', 'missing estimator'] as const)('retains the per-job simulation error for %s', async mode => {
    const h = runner(mode === 'transport' ? () => { throw new Error('fake transport failure'); } : recorded.store, mode !== 'missing estimator');
    const out = await runTick(h.chain, {}, h.cfg, quiet);
    const skip = out.report.skipped.find(c => c.job === h.c.job);
    expect(skip?.why).toBe('simulation error');
    expect(String(skip?.error)).toContain(mode === 'transport' ? 'fake transport failure' : 'reviewed pending state gas unavailable');
    expect(h.node.sent).toEqual([]);
    expect(out.state.budget.totalWei).toBe(0n);
  });
});

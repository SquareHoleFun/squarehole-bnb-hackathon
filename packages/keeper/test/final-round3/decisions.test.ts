import { describe, expect, it } from 'vitest';
import { ViemChain, interpret } from '../../src/chain';
import { destinationGasReader, loadConfig } from '../../src/config';
import { EIP7825_GAS_CAP as CAP, transactionGas, type GasConstraints } from '../../src/gas';
import { emptyMemory, plan } from '../../src/plan';
import { runTick, type KeeperState } from '../../src/run';
import type { Candidate } from '../../src/types';
import { fakeClient, fakeNode } from '../support/fake-rpc';
import { box, keeper, options, quiet, time, v2, world } from '../support/v2';

describe('FINAL3 Safe debt and owner-claim properties (F127/F130)', () => {
  it.each(['curve', 'graduated', 'failed'] as const)('keeps the two Safe debts independent in %s', async phase => {
    const b = box({ graduated: phase === 'graduated', failed: phase === 'failed',
      fitOwed: 1n, platformOwed: (1n << 220n) + 1n, v2: { ...v2, qDecimals: null } });
    const w = world(b);
    const cfg = { ...options(), dryRun: false, priorityFeeWei: 1n };
    const candidates = plan(w, emptyMemory(), cfg).candidates;
    const safe = candidates.filter(c => c.job === 'receiverPayFit' || c.job === 'receiverPayPlatform');
    expect(safe.map(c => c.fn)).toEqual(['payFit', 'payPlatform']);
    for (const c of safe) {
      expect(c.to).toBe(b.receiver);
      expect(c.args).toEqual([]); // Caller cannot choose a beneficiary or a tip.
      expect(interpret(c, 1n, null)).toMatchObject({ ok: true, tipWei: null });
      expect(interpret(c, 0n, null).ok).toBe(false);
    }
    expect(candidates.some(c => /claimFor|claimCreator|^claim$/.test(c.fn))).toBe(false);
    const sent: string[] = [];
    const port = { read: async () => w,
      simulate: async (c: Candidate) => ({ ok: c.job === 'receiverPayPlatform', tipWei: null, estimate: 12_000_000n }),
      send: async (c: Candidate) => { sent.push(c.fn); return 'local'; },
    };
    const first = await runTick(port, {}, cfg, quiet);
    expect(sent).toEqual(['payPlatform']);
    expect(first.state.budget.totalWei).toBe(14_400_000n * 3n);
    const fitKey = safe.find(c => c.fn === 'payFit')?.key;
    const platformKey = safe.find(c => c.fn === 'payPlatform')?.key;
    if (!fitKey || !platformKey) throw new Error('both Safe candidates are required');
    expect(first.state.mem.attempts[fitKey]?.next).toBe(102n);
    expect(first.state.mem.attempts[platformKey]?.next).toBe(102n);
    expect(plan(world(b, 101n), first.state.mem, cfg).candidates
      .some(c => c.key === fitKey || c.key === platformKey)).toBe(false);
    expect(plan(world(b, 102n), first.state.mem, cfg).candidates
      .filter(c => c.key === fitKey || c.key === platformKey)).toHaveLength(2);
  });
});

describe('FINAL3 destination admission, reservation and exact signed envelope', () => {
  it.each(['cancun', 'osaka', 'amsterdam'] as const)('checks cap-minus-one, cap and cap-plus-one on %s', fork => {
    for (const stateGas of fork === 'amsterdam' ? [0n, 8_000_000n] : [0n]) {
      const rules: GasConstraints = { fork, transactionCap: CAP, blockGasLimit: 30_000_000n, stateGas };
      for (const offset of [-1n, 0n]) {
        const estimate = CAP + stateGas + offset;
        expect(transactionGas('receiverPayFit', estimate, rules)).toBe(CAP + stateGas);
      }
      expect(() => transactionGas('receiverPayFit', CAP + stateGas + 1n, rules)).toThrow(/estimate exceeds/);
      expect(() => transactionGas('royaltyFlush', 100_000n, { ...rules, blockGasLimit: 7_999_999n }))
        .toThrow(/floor exceeds|state gas/);
      const noState = { ...rules, stateGas: 0n, blockGasLimit: 8_000_000n };
      expect(transactionGas('royaltyFlush', 100_000n, noState)).toBe(8_000_000n);
    }
  });

  it.each(['cancun', 'osaka', 'amsterdam'] as const)('uses the real adapter and runner before charging on %s', async fork => {
    const cfg = loadConfig({ SH_KEEPER_RPC_URL: 'http://fake.invalid', SH_KEEPER_DESTINATION_FORK: fork,
      SH_KEEPER_TRANSACTION_GAS_CAP: String(CAP) });
    const b = box({ failed: true, fitOwed: 1n, platformOwed: 0n });
    const w = world(b);
    const node = fakeNode();
    node.calls[`${b.receiver}:payFit`] = () => 1n;
    const stateGas = fork === 'amsterdam' ? 8_000_000n : 0n;
    let estimate = CAP + stateGas + 1n;
    const chain = new ViemChain(cfg, fakeClient(node), keeper, { public: null, private: null }, null, quiet,
      destinationGasReader(cfg.destinationGas), async () => ({ gas: estimate, stateGas }));
    const order: string[] = [];
    const saved: KeeperState[] = [];
    const port = { read: async () => w,
      simulate: async (c: Candidate, fees: Parameters<ViemChain['simulate']>[1]) => c.job === 'receiverPayFit'
        ? chain.simulate(c, fees) : { ok: false, estimate: 0n, tipWei: null },
      gasConstraints: chain.gasConstraints.bind(chain),
      send: async (_c: Candidate, gas: bigint) => {
        order.push('send');
        expect(gas).toBe(CAP + stateGas);
        expect(saved.at(-1)?.budget?.totalWei).toBe(gas * 3n);
        throw new Error('accepted then disconnected');
      },
    };
    const opts = { ...options(), dryRun: false, priorityFeeWei: 1n,
      checkpoint: async (state: KeeperState) => { saved.push(state); order.push('checkpoint'); } };
    const deferred = await runTick(port, {}, opts, quiet);
    expect(deferred.state.budget.totalWei).toBe(0n);
    expect(order).toEqual(['checkpoint']);
    expect(deferred.report.skipped.find(s => s.job === 'receiverPayFit')?.why).toMatch(/gas admission/);
    estimate -= 1n;
    order.length = 0;
    const ambiguous = await runTick(port, deferred.state, opts, quiet);
    expect(order).toEqual(['checkpoint', 'send', 'checkpoint']);
    expect(ambiguous.state.budget.totalWei).toBe((CAP + stateGas) * 3n);
    expect(ambiguous.report.skipped.find(s => s.job === 'receiverPayFit')?.why).toBe('send error');
    // Same-block retry after an ambiguous send cannot reserve or sign a second payment.
    order.length = 0;
    const retry = await runTick(port, ambiguous.state, opts, quiet);
    expect(order).toEqual(['checkpoint']);
    expect(retry.state.budget.totalWei).toBe(ambiguous.state.budget.totalWei);
  });

  it('uses the exact executed-year rule without scheduling user claims', () => {
    const failedAt = time;
    const b = box({ failed: true, graduated: false, v2: { ...v2, tLeft: 1n, pot: 1n } });
    const jobs = (timestamp: bigint) => plan(world(b, 100n, timestamp), emptyMemory(), options()).candidates.map(c => c.fn);
    expect(jobs(failedAt + 31_536_000n - 1n)).not.toContain('sweepAfterLastClaim');
    expect(jobs(failedAt + 31_536_000n)).not.toContain('sweepAfterLastClaim');
    expect(jobs(failedAt + 31_536_000n)).not.toContain('claim');
  });
});

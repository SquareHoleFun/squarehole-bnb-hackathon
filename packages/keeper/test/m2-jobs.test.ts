import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodeFunctionData, toHex, type PublicClient } from 'viem';
import { abiFor } from '../src/abi';
import { ViemChain, interpret } from '../src/chain';
import { emptyMemory, plan } from '../src/plan';
import { runTick, type KeeperState } from '../src/run';
import { transactionGas, feesFor } from '../src/gas';
import { encodeState, decodeState } from '../src/state';
import { oursList } from '../src/jobs';
import { addr, keeper, options, quiet, time } from './support/v2';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing test value');
  return value;
}
const [registry, co, token, hook, shop, receiver, router, ledger] = [addr(90), addr(1), addr(10), addr(2), addr(30), addr(3), addr(6), addr(17)] as const;
function fixture() {
  const state = { block: 100n, timestamp: time, closed: true, funded: true, complete: false, failed: false, residueBlocked: false,
    credit: 10n ** 22n, residue: 7n, frozenT: 99n, count: 2n, batch: 3n, holders: 2n, returned: new Set<bigint>(),
    broken: new Set<string>(), brokenBatches: new Set<bigint>(), shopKind: true,
    calls: [] as { functionName: string; args: readonly unknown[]; blockNumber?: bigint }[] };
  const client = {
    getChainId: async () => 11155111,
    request: async () => ({ number: toHex(state.block), timestamp: toHex(state.timestamp), baseFeePerGas: '0x1' }),
    getBlock: async () => ({ number: state.block, timestamp: state.timestamp, baseFeePerGas: 1n, gasLimit: 30_000_000n }),
    readContract: async (r: { functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => {
      const { functionName: fn, args = [] } = r; state.calls.push({ ...r, args });
      if (state.broken.has(fn)) throw new Error(`unavailable ${fn}`);
      switch (fn) {
        case 'boxCount': return 1n;
        case 'roleOf': return ({ 0: co, 1: token, 2: hook, 3: shop, 5: receiver, 6: router, 17: ledger } as Record<string, string>)[String(args[1])] ?? addr(0);
        case 'poolId': return `0x${'11'.repeat(32)}`;
        case 'poolManager': return addr(50);
        case 'q': return addr(0);
        case 'graduated': case 'closed': case 'gateOpen': case 'graduationSettled': return true;
        case 'failed': return state.failed;
        case 'openAt': case 'closedAt': return time - 10n;
        case 'deadline': return time + 1000n;
        case 'holderLedger': return ledger;
        case 'currentTradeBatch': return state.batch;
        case 'tradeBatch': return { tradeUnits: 100n, protocolUnits: 1n, netP: state.credit, closed: state.closed };
        case 'holderBatchClosed': return state.funded;
        case 'holderBatchPaid': return state.credit;
        case 'batchState':
          if (state.brokenBatches.has(args[0] as bigint)) throw new Error('unavailable batch');
          return [state.complete, state.complete ? state.holders : 0n, 0n, state.residue];
        case 'claimState': return [0n, 1n];
        case 'collectionSize': return state.count;
        case 'failedT': return state.frozenT;
        default: return 0n;
      }
    },
    getLogs: async () => [],
    getBytecode: async () => `0x363d3d373d3d3d363d73${'11'.repeat(20)}5af43d82803e903d91602b57fd5bf3${'00'.repeat(234)}${state.shopKind ? '04' : '00'}`,
    simulateContract: async ({ functionName: fn, args = [] }: { functionName: string; args: readonly unknown[] }) => {
      if (fn === 'collect') return { result: { buyersP: 0n, sellersP: 0n, qToReserve: 0n, tip: 0n } };
      if (fn === 'settleBatch') return { result: false }; // incomplete pages still make progress
      if (fn === 'flushResidue') return { result: state.residueBlocked ? 0n : state.residue };
      if (fn === 'burnFailedT') return { result: state.frozenT };
      if (fn === 'returnStarter') return { result: state.returned.has((args[0] as [bigint])[0]) ? 0n : 1n };
      return { result: 0n };
    },
    estimateGas: async () => 100_000n,
  } as unknown as PublicClient;
  const cfg = { ...options(), boxRegistry: registry };
  const restart = () => new ViemChain(cfg, client, keeper, { public: null, private: null }, null, quiet);
  const chain = restart();
  const candidates = async () => plan(await chain.read(), emptyMemory(), cfg).candidates.filter((c) => c.to === ledger || c.to === shop);
  return { state, chain, candidates, cfg, restart };
}

describe('M2-51 keeper exits', () => {
  it('F127: funded holder credits never schedule a payout push', async () => {
    const f = fixture(); f.state.complete = true; f.state.failed = true;
    const cs = await f.candidates();
    expect(cs.some((c) => c.fn === 'claimFor')).toBe(false);
    expect(cs.some((c) => c.fn === 'flushResidue')).toBe(true);
    expect(cs.some((c) => c.fn === 'returnStarter')).toBe(true);
    expect(f.state.calls.some((c) => c.functionName === 'claimable' || c.functionName === 'holderAt')).toBe(false);
  });
  it('G1-D3 settles only closed batches with positive final funding', async () => {
    const f = fixture();
    for (const credit of [0n, 10n ** 22n]) {
      f.state.credit = credit;
      const cs = await f.candidates();
      expect(cs.map((c) => [c.fn, c.args])).toEqual(credit === 0n ? [] : [['settleBatch', [1n, 16n]], ['settleBatch', [2n, 16n]]]);
      if (credit !== 0n) expect(interpret(required(cs[0]), false, null).ok).toBe(true);
    }
    f.state.funded = false; expect(await f.candidates()).toEqual([]);
    f.state.funded = true; f.state.closed = false; expect(await f.candidates()).toEqual([]);
  });
  it('flushes only proved residue and recovers failed shops; encodes the actual interfaces', async () => {
    const f = fixture(); f.state.complete = true; f.state.failed = true;
    const cs = await f.candidates();
    expect(cs).toEqual(expect.arrayContaining([
      expect.objectContaining({ to: ledger, fn: 'flushResidue', args: [1n] }),
      expect.objectContaining({ to: shop, fn: 'burnFailedT', args: [] }),
      expect.objectContaining({ to: shop, fn: 'returnStarter', args: [[0n]] }),
    ]));
    expect(new Set(cs.map((c) => c.key)).size).toBe(cs.length);
    for (const c of cs) expect(encodeFunctionData({ abi: abiFor(c), functionName: c.fn, args: c.args })).toMatch(/^0x/);
    expect(f.state.calls.every((c) => c.blockNumber === 99n)).toBe(true);
    for (const c of cs) expect(interpret(c, 0n, null).ok).toBe(false);
  });
  it.each([
    [20n, 20n, 20n, [1n]],
    [16n, 16n, 16n, [2n]],
    [16n, 16n, 16n, [4n]],
    [24n, 24n, 24n, [3n]],
    [32n, 32n, 32n, [4n]],
    [16n, 24n, 32n, [2n, 6n, 4n]],
  ])('visits every bounded exit page with %s batches, %s holders, %s starters and strides %s', async (batches, holders, starters, strides) => {
    const f = fixture(); Object.assign(f.state, { complete: true, failed: true, batch: batches + 1n, holders, count: starters });
    const residues = new Set<bigint>(), returns = new Set<bigint>();
    const ticks = ((batches + 7n) / 8n) * ((holders + 7n) / 8n);
    for (let i = 0n; i < ticks; i++) {
      f.state.block += required(strides[Number(i % BigInt(strides.length))]);
      f.state.calls = [];
      const cs = await f.candidates();
      expect(f.state.calls.filter((c) => c.functionName === 'tradeBatch').length).toBeLessThanOrEqual(8);
      expect(f.state.calls.filter((c) => c.functionName === 'claimable')).toHaveLength(0);
      expect(cs.filter((c) => c.fn === 'claimFor')).toHaveLength(0);
      expect(cs.filter((c) => c.fn === 'returnStarter').length).toBeLessThanOrEqual(8);
      expect(f.state.calls.every((c) => c.blockNumber === f.state.block - 1n)).toBe(true);
      for (const c of cs.filter((c) => c.fn === 'flushResidue')) residues.add(c.args[0] as bigint);
      for (const c of cs.filter((c) => c.fn === 'returnStarter')) returns.add((c.args[0] as [bigint])[0]);
    }
    expect(BigInt(residues.size)).toBe(batches);
    expect(BigInt(returns.size)).toBe(starters);
  });
  it('discovers every unsettled batch while observing only every second block', async () => {
    const f = fixture(); f.state.batch = 17n;
    const batches = new Set<bigint>();
    for (let i = 0; i < 4; i++) {
      f.state.block += 2n;
      for (const c of await f.candidates()) if (c.fn === 'settleBatch') batches.add(c.args[0] as bigint);
    }
    expect(batches.size).toBe(16);
  });
  it.each([false, true])('keeps fair discovery across a fresh process each tick, budget exhausted=%s', async (exhausted) => {
    const f = fixture(); Object.assign(f.state, { complete: true, failed: true, batch: 17n, holders: 16n, count: 16n });
    const residues = new Set<string>(), returns = new Set<string>();
    let journal = encodeState({}, 'm2');
    const cfg = { ...f.cfg, priorityFeeWei: 1n, limits: { ...f.cfg.limits, maxTxPerBlock: 128,
      ...(exhausted ? { oursWeiPerDay: 0n, totalWeiPerDay: 0n, reserveWeiPerDay: 0n } : {}) },
    checkpoint: async (s: KeeperState) => { journal = encodeState(s, 'm2'); } };
    for (let i = 0; i < 4; i++) {
      f.state.block += 4n;
      const chain = f.restart();
      const port = { read: chain.read.bind(chain), send: chain.send.bind(chain),
        simulate: async (...args: Parameters<ViemChain['simulate']>) => {
          const c = args[0];
          if (c.fn === 'flushResidue') residues.add(String(c.args[0]));
          if (c.fn === 'returnStarter') returns.add(String((c.args[0] as [bigint])[0]));
          return chain.simulate(...args);
        } };
      const out = await runTick(port, decodeState(journal, 'm2'), cfg, quiet);
      if (exhausted) expect(out.report.sent).toHaveLength(0);
    }
    expect(returns.size).toBe(16);
    expect(residues.size).toBe(16);
  });
  it('retains cursor progress in the pre-send checkpoint when a tick is interrupted', async () => {
    const f = fixture(); Object.assign(f.state, { complete: true, failed: true, batch: 17n, holders: 16n, count: 16n });
    let journal = encodeState({}, 'm2');
    await expect(runTick(f.chain, {}, { ...f.cfg, checkpoint: async (s) => {
      journal = encodeState(s, 'm2');
      throw new Error('interrupted after durable reservation');
    } }, quiet)).rejects.toThrow('interrupted after durable reservation');
    const saved = decodeState(journal, 'm2');
    expect(required(saved.budget).totalWei).toBeGreaterThan(0n);
    expect(saved.m2Scan).toBeDefined();
    f.state.block += 4n;
    const world = await f.restart().read(saved.m2Scan);
    const cs = plan(world, emptyMemory(), f.cfg).candidates;
    expect(cs.filter((c) => c.fn === 'flushResidue').map((c) => c.args[0])).toEqual([9n, 10n, 11n, 12n, 13n, 14n, 15n, 16n]);
    expect(cs.filter((c) => c.fn === 'returnStarter').map((c) => c.args[0])).toEqual([[8n], [9n], [10n], [11n], [12n], [13n], [14n], [15n]]);
    // Reading another page must not rewrite the saved checkpoint in memory before fsync.
    expect(saved).toEqual(decodeState(journal, 'm2'));
  });
  it('revalidates shrinking, empty and regrown counts across reorgs and retries failed reads', async () => {
    const f = fixture(); Object.assign(f.state, { complete: true, failed: true, batch: 33n, holders: 32n, count: 32n });
    await f.candidates(); await f.candidates();
    Object.assign(f.state, { block: 80n, batch: 3n, holders: 2n, count: 2n });
    const smaller = await f.candidates();
    expect(smaller.filter((c) => c.fn === 'flushResidue')).toHaveLength(2);
    expect(smaller.filter((c) => c.fn === 'returnStarter').map((c) => c.args)).toEqual([[[0n]], [[1n]]]);
    Object.assign(f.state, { batch: 1n, count: 0n, frozenT: 0n });
    expect(await f.candidates()).toEqual([]);
    Object.assign(f.state, { batch: 17n, holders: 16n, count: 16n });
    f.state.brokenBatches.add(1n); f.state.broken.add('collectionSize');
    const partial = await f.candidates();
    expect(partial.some((c) => c.fn === 'flushResidue' && c.args[0] === 1n)).toBe(false);
    expect(partial.some((c) => c.fn === 'returnStarter')).toBe(false);
    f.state.broken.clear(); f.state.brokenBatches.clear();
    const residues = new Set<string>(), returns = new Set<string>();
    for (let i = 0; i < 4; i++) {
      f.state.block += 4n;
      for (const c of await f.candidates()) {
        if (c.fn === 'flushResidue') residues.add(String(c.args[0]));
        if (c.fn === 'returnStarter') returns.add(String((c.args[0] as [bigint])[0]));
      }
    }
    expect(returns.size).toBe(16); expect(residues.size).toBe(16);
    f.state.closed = false;
    expect((await f.candidates()).filter((c) => c.to === ledger)).toEqual([]);
    f.state.closed = true; f.state.credit = 0n; f.state.residue = 0n;
    expect((await f.candidates()).filter((c) => c.to === ledger)).toEqual([]);
  });
  it('backs off unavailable residue flushes, deduplicates restart attempts, and reserves fixed daily gas before sending', async () => {
    const f = fixture(); f.state.complete = true; f.state.residueBlocked = true;
    const sent: string[] = [];
    let saved: KeeperState = {};
    const cfg = { ...f.cfg, dryRun: false, priorityFeeWei: 1n,
      limits: { ...f.cfg.limits, reserveWeiPerDay: 0n, oursWeiPerDay: 1_500_000n, totalWeiPerDay: 1_500_000n },
      checkpoint: async (s: KeeperState) => { saved = s; } };
    const port = { read: () => f.chain.read(), simulate: async (...args: Parameters<ViemChain['simulate']>) =>
      args[0].to === ledger ? f.chain.simulate(...args) : { ok: false, tipWei: null, estimate: 0n },
    send: async (c: { fn: string }, gas: bigint) => {
      expect(required(saved.budget).totalWei).toBeGreaterThanOrEqual(gas * feesFor(1n, 1n).maxFeePerGas);
      sent.push(c.fn); return 'hash';
    } };
    const first = await runTick(port, {}, cfg, quiet);
    expect(first.report.skipped.some((s) => s.job === 'holderResidue' && s.why === 'nothing to do')).toBe(true);
    const second = await runTick(port, first.state, cfg, quiet);
    expect(second.report.sent).toHaveLength(0);
    f.state.block += 2n; f.state.residueBlocked = false;
    const third = await runTick(port, second.state, cfg, quiet);
    expect(third.state.budget.totalWei).toBeLessThanOrEqual(cfg.limits.totalWeiPerDay);
    expect(third.report.skipped.some((s) => s.why.includes('ceiling'))).toBe(true);
    expect(sent).not.toContain('claimFor');
  });
  it('isolates failed T reads from NFT recovery and never probes other role-3 vault kinds', async () => {
    const f = fixture(); f.state.failed = true; f.state.broken.add('failedT');
    expect((await f.candidates()).filter((c) => c.fn === 'returnStarter')).toHaveLength(2);
    f.state.broken.clear(); f.state.shopKind = false; f.state.calls = [];
    expect((await f.candidates()).filter((c) => c.to === shop)).toEqual([]);
    expect(f.state.calls.some((c) => c.functionName === 'failedT')).toBe(false);
  });
  it('ignores holder credit reads while residue and shop recovery remain available', async () => {
    const f = fixture(); f.state.complete = true; f.state.failed = true; f.state.broken.add('claimable');
    const cs = await f.candidates();
    expect(cs.some((c) => c.fn === 'claimFor')).toBe(false);
    expect(cs.some((c) => c.fn === 'flushResidue')).toBe(true);
    expect(cs.some((c) => c.fn === 'returnStarter')).toBe(true);
    f.state.broken.clear();
    expect((await f.candidates()).filter((c) => c.fn === 'claimFor')).toHaveLength(0);
    f.state.credit = 0n; f.state.residue = 0n; f.state.frozenT = 0n;
    expect((await f.candidates()).filter((c) => c.to === ledger)).toEqual([]);
  });
  it('reconciles reorged closure without remembering completed work', async () => {
    const f = fixture(); f.state.complete = true;
    expect((await f.candidates()).filter((c) => c.fn === 'flushResidue')).toHaveLength(2);
    f.state.batch = 1n; expect(await f.candidates()).toEqual([]);
    f.state.batch = 3n; f.state.complete = false;
    expect((await f.candidates()).map((c) => c.fn)).toEqual(['settleBatch', 'settleBatch']);
  });
  it('retries partial settlement and an unavailable residue flush after durable backoff, without replenishing a spent day', async () => {
    const f = fixture();
    const sent: string[] = [];
    const port = { read: () => f.chain.read(), simulate: async (...args: Parameters<ViemChain['simulate']>) =>
      args[0].to === ledger ? f.chain.simulate(...args) : { ok: false, tipWei: null, estimate: 0n },
    send: async (c: { fn: string }) => { sent.push(c.fn); return 'hash'; } };
    const cfg = { ...f.cfg, dryRun: false, priorityFeeWei: 1n };
    const first = await runTick(port, {}, cfg, quiet);
    expect(sent).toEqual(['settleBatch', 'settleBatch']);
    const restart = decodeState(encodeState(first.state, 'm2'), 'm2');
    expect((await runTick(port, restart, cfg, quiet)).report.sent).toHaveLength(0);
    f.state.block += 2n; f.state.complete = true; f.state.residueBlocked = true;
    const paused = await runTick(port, restart, cfg, quiet);
    const spent = paused.state.budget.totalWei;
    f.state.residueBlocked = false; f.state.block++;
    const wait = await runTick(port, paused.state, cfg, quiet);
    expect(wait.state.budget.totalWei).toBe(spent);
    f.state.block++;
    const paid = await runTick(port, wait.state, cfg, quiet);
    expect(paid.report.sent.some((c) => c.job === 'holderResidue')).toBe(true);
    expect(paid.state.budget.totalWei).toBeGreaterThan(spent);
    f.state.credit = 0n; f.state.residue = 0n; f.state.timestamp += 86400n; f.state.block++;
    const nextDay = await runTick(port, paid.state, cfg, quiet);
    expect(nextDay.report.sent).toHaveLength(0); expect(nextDay.state.budget.totalWei).toBe(0n);
  });
  it('publishes every untipped M2 job and preserves the named optional-call gas allowance', () => {
    for (const job of ['holderSettle', 'holderResidue', 'shopBurn', 'shopReturn']) {
      expect(oursList().find((j) => j.job === job)?.when).toBe('always');
    }
    expect(transactionGas('shopReturn', 100_000n)).toBe(2_000_000n);
    const probe = readFileSync(new URL('./solidity/M2Calls.t.sol', import.meta.url), 'utf8');
    const floor = required(probe.match(/KEEPER_RETURN_FLOOR = ([\d_]+);/)?.[1]);
    expect(BigInt(floor.replaceAll('_', ''))).toBe(transactionGas('shopReturn', 100_000n));
    expect(transactionGas('shopReturn', 100_000n)).toBeGreaterThan(800_000n + 800_000n / 63n + 220_000n);
    expect(transactionGas('shopBurn', 100_000n)).toBe(5_000_000n);
    expect(transactionGas('shopBurn', 100_000n)).toBeGreaterThan(1_250_000n + 2_500_000n + 2_500_000n / 63n + 220_000n);
    expect(transactionGas('shopReturn', 2_000_000n)).toBe(2_400_000n);
  });
});

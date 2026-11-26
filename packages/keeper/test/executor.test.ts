import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionData, zeroAddress } from 'viem';
import { buildAction, executorAbi as fundingAbi } from '../../burn-bot/src/builders';
import { lot, manifest, snapshot } from '../../burn-bot/test/fixtures';
import { abiFor } from '../src/abi';
import { ViemChain, interpret } from '../src/chain';
import { loadConfig } from '../src/config';
import { afterRun, emptyMemory, plan } from '../src/plan';
import { runTick, type KeeperState } from '../src/run';
import type { Candidate } from '../src/types';
import { fakeClient, fakeNode, REVERT } from './support/fake-rpc';
import { addr, box, keeper, options, quiet, time, world } from './support/v2';

const funded = { budget: 10n ** 18n, batchThreshold: 10n ** 17n, twapReady: true };
const fit = (executor = funded) => box({ version: 1, v2: undefined, priceSource: addr(88), executor });
const readyWorld = () => ({ ...world(fit()), fitGraduated: true });
const execution = (): Candidate => ({ job: 'executorExecute', key: 'executorExecute:1:0',
  to: addr(88), fn: 'execute', args: [1n], version: 1, boxId: 0n, retryAfterBlocks: 2n });

describe('M3 FIT funding to bounded keeper execution', () => {
  it('requires confirmed graduation, valid budget/readiness and a positive bounded chunk count', () => {
    const w = readyWorld();
    expect(plan(w, emptyMemory(), options()).candidates).toContainEqual(expect.objectContaining({ fn: 'execute', args: [1n] }));
    for (const b of [fit({ ...funded, budget: 0n }), fit({ ...funded, budget: funded.batchThreshold - 1n }),
      fit({ ...funded, twapReady: false }), fit({ ...funded, batchThreshold: 0n }),
      { ...fit(), graduated: false }, { ...fit(), failed: true }, { ...fit(), executor: undefined },
      { ...fit(), version: 2 as const }, { ...fit(), id: 1n }]) {
      expect(plan({ ...w, boxes: [b] }, emptyMemory(), options()).candidates.some(c => c.fn === 'execute')).toBe(false);
    }
    expect(plan({ ...w, fitGraduated: false }, emptyMemory(), options()).candidates.some(c => c.fn === 'execute')).toBe(false);
    for (const value of ['0', '-1', '1.5', '33']) {
      expect(() => loadConfig({ SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_RPC_URL: 'http://fake.invalid', SH_KEEPER_EXECUTOR_MAX_CHUNKS: value })).toThrow(/EXECUTOR_MAX_CHUNKS/);
    }
  });

  it('uses simulation results, including a held FIT burn, and backs off no-work and sends across restart', () => {
    const c = execution();
    expect(interpret(c, [0n, 0n, 0n], null).ok).toBe(false);
    expect(interpret(c, [1n, 50n, 40n], null)).toMatchObject({ ok: true, tipWei: null });
    expect(interpret(c, [0n, 0n, 40n], null)).toMatchObject({ ok: true, tipWei: null });
    for (const sent of [false, true]) {
      const w = readyWorld();
      const mem = afterRun(emptyMemory(), c, sent, w);
      expect(plan(w, mem, options()).candidates.some(c => c.fn === 'execute')).toBe(false);
      expect(plan({ ...w, block: { ...w.block, number: 102n } }, mem, options()).candidates.some(c => c.fn === 'execute')).toBe(true);
    }
  });

  it('fundBudget handoff reads actual readiness, simulates execute and reserves our gas before send', async () => {
    const node = fakeNode({ block: { number: 100n, timestamp: time, baseFeePerGas: 1n } });
    const co = manifest.box0.coordinator, ex = manifest.box0.executor, hk = addr(42), rc = addr(43), pm = addr(44);
    let budget = 0n;
    let burnt = 0n;
    node.calls = {
      [`${co}:graduated`]: () => true, [`${co}:executor`]: () => ex,
      [`${hk}:poolId`]: () => `0x${'11'.repeat(32)}`, [`${hk}:poolManager`]: () => pm, [`${hk}:closed`]: () => true,
      [`${rc}:fitOwed`]: () => 0n, [`${rc}:platformOwed`]: () => 0n,
      [`${ex}:fitGraduated`]: () => true, [`${ex}:launchPhase`]: () => co,
      [`${ex}:budget`]: () => budget, [`${ex}:batchThreshold`]: () => funded.batchThreshold,
      [`${ex}:twap`]: () => [true, 0, 1800],
      [`${ex}:oracle`]: () => ({ tick: 0, time: 1791302400, tickCumulative: 0n, head: 0, filled: 2 }),
      [`${ex}:checkpointAt`]: () => ({ time: 1791302400, tickCumulative: 0n }),
      [`${pm}:extsload`]: () => `0x${'00'.repeat(32)}`,
      [`${ex}:execute`]: args => { expect(args).toEqual([1n]); return [1n, budget, 50n]; },
    };
    const cfg = loadConfig({ SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_RPC_URL: 'http://fake.invalid', SH_KEEPER_BOX0: [co, hk, rc, ex].join(',') });
    const chain = new ViemChain(cfg, fakeClient(node), keeper, { public: null, private: null }, null, quiet);
    expect(plan(await chain.read(), emptyMemory(), options()).candidates.some(c => c.fn === 'execute')).toBe(false);
    const amount = funded.budget;
    const source = { ...lot('fit', zeroAddress), amount };
    const snap = { ...snapshot(), balances: { [zeroAddress]: amount } };
    expect(() => buildAction(manifest, { ...snap, box0: { ...snap.box0, graduated: false } }, source,
      { kind: 'fund', lotId: source.id, amount })).toThrow();
    const call = buildAction(manifest, snap, source, { kind: 'fund', lotId: source.id, amount }).calls[0];
    if (!call) throw new Error('missing funding call');
    expect(call.to).toBe(ex);
    expect(decodeFunctionData({ abi: fundingAbi, data: call.data }).functionName).toBe('fundBudget');
    budget += call.value; // Canonically confirmed funding in the fake RPC, never merely a proposal.
    expect((await chain.read()).boxes[0]?.executor).toEqual(funded);
    const checkpoints: KeeperState[] = [];
    const runConfig = { ...options(), dryRun: false, checkpoint: async (s: KeeperState) => { checkpoints.push(s); } };
    const port = { read: () => chain.read(), simulate: (c: Candidate, fees: Parameters<ViemChain['simulate']>[1]) => chain.simulate(c, fees),
      send: async (c: Candidate) => {
        expect(c.fn).toBe('execute');
        const data = encodeFunctionData({ abi: abiFor(c), functionName: c.fn, args: c.args });
        expect(decodeFunctionData({ abi: abiFor(c), data }).args).toEqual([1n]);
        expect(checkpoints.at(-1)?.budget?.oursWei).toBeGreaterThan(0n);
        budget = 0n; burnt += 50n;
        return '0x01';
      } };
    const result = await runTick(port, {}, runConfig, quiet);
    expect(result.report.sent).toContainEqual(expect.objectContaining({ job: 'executorExecute', asOurs: true }));
    expect(budget).toBe(0n); expect(burnt).toBe(50n);
    expect((await runTick(port, result.state, runConfig, quiet)).report.sent).toHaveLength(0);

    budget = funded.budget;
    node.block.number += 25n;
    const exhausted = { ...result.state, budget: { ...result.state.budget, oursWei: runConfig.limits.oursWeiPerDay } };
    const deferred = await runTick(port, exhausted, runConfig, quiet);
    expect(deferred.report.sent).toHaveLength(0);
    expect(deferred.report.skipped).toContainEqual(expect.objectContaining({ job: 'executorExecute', why: 'ours budget spent' }));
    expect(budget).toBe(funded.budget);

    for (const fn of ['budget', 'batchThreshold', 'twap']) {
      const saved = node.calls[`${ex}:${fn}`];
      if (!saved) throw new Error('missing executor read fixture');
      node.calls[`${ex}:${fn}`] = () => { throw REVERT; };
      expect((await chain.read()).boxes[0]?.executor).toBeUndefined();
      node.calls[`${ex}:${fn}`] = saved;
    }
    node.calls[`${co}:executor`] = () => addr(999);
    expect((await chain.read()).boxes[0]?.executor).toBeUndefined();
  });
});

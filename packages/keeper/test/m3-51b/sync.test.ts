import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionData } from 'viem';
import { abiFor } from '../../src/abi';
import { feesFor, transactionGas } from '../../src/gas';
import { jobSpec } from '../../src/jobs';
import { runTick, type ChainPort, type KeeperState } from '../../src/run';
import { decodeState, encodeState } from '../../src/state';
import { m3Fixture, parts } from '../support/m3';
import { quiet } from '../support/v2';

const restartState = (state: KeeperState) => decodeState(encodeState(state, 'm3-51b'), 'm3-51b');
const min = (a: bigint, b: bigint) => a < b ? a : b;

describe('M3-51b / M3-53 request 4: permissionless sync(32)', () => {
  it.each([
    [1n, 0n, 0n, 0n, true],
    [0n, 1n, 0n, 0n, true],
    [65n, 35n, 0n, 0n, true],
    [65n, 35n, 65n, 35n, false],
    [0n, 0n, 0n, 0n, false],
    [1n, 1n, 2n, 0n, false],
    [1n, 1n, 0n, 2n, false],
  ] as const)('compares funding %s and lifecycle %s with cursors %s/%s', async (funding, lifecycle, processedFunding, processedLifecycle, due) => {
    const f = m3Fixture();
    Object.assign(f.s, { funding, lifecycle, processedFunding, processedLifecycle });
    const work = (await f.candidates()).filter((c) => c.job === 'itemSync');
    expect(work).toHaveLength(due ? 1 : 0);
    if (!due) return;
    expect(work[0]).toMatchObject({ to: parts.ledger, fn: 'sync', args: [32n], syncSources: [parts.receiver, parts.vault] });
    const c = work[0];
    if (!c) throw new Error('missing due sync');
    expect(decodeFunctionData({ abi: abiFor(c), data: encodeFunctionData({ abi: abiFor(c), functionName: c.fn, args: c.args }) }))
      .toEqual({ functionName: 'sync', args: [32n] });
  });

  it('drains multiple pages across restarts, then rediscovers a new collect without an event', async () => {
    const f = m3Fixture();
    Object.assign(f.s, { funding: 65n, lifecycle: 35n, residue: 0n, duplicates: true });
    const keys = new Set<string>();
    const send: ChainPort['send'] = vi.fn(async (c) => {
      expect(c.job).toBe('itemSync');
      const page = c.args[0] as bigint;
      keys.add(c.key);
      f.s.processedFunding = min(f.s.funding, f.s.processedFunding + page);
      f.s.processedLifecycle = min(f.s.lifecycle, f.s.processedLifecycle + page);
      return 'sync-transaction';
    });
    let state: KeeperState = {};
    for (const [funding, lifecycle] of [[32n, 32n], [64n, 35n], [65n, 35n]]) {
      const chain = f.restart();
      const out = await runTick({ read: chain.read.bind(chain), simulate: chain.simulate.bind(chain), send }, state,
        { ...f.cfg, dryRun: false }, quiet);
      expect(out.report.sent).toHaveLength(1);
      expect([f.s.processedFunding, f.s.processedLifecycle]).toEqual([funding, lifecycle]);
      state = restartState(out.state);
      f.s.block += f.cfg.retryBlocks;
    }
    expect(keys.size).toBe(1);
    expect(send).toHaveBeenCalledTimes(3);
    expect((await f.candidates()).some((c) => c.job === 'itemSync')).toBe(false);
    // Canonical journals, not events or cached completion, drive discovery after another collect.
    f.s.duplicates = false;
    f.s.funding++;
    expect((await f.candidates()).find((c) => c.job === 'itemSync')?.args).toEqual([32n]);
    expect(f.s.credit).toBe(10n ** 24n);
    expect(f.s.reads.some((r) => /ownerOf|itemCredit|ticketCredit/.test(r.fn))).toBe(false);
  });

  it('uses the pending estimate with headroom, reserves before send, and resumes within the next daily budget', async () => {
    const f = m3Fixture(); f.s.residue = 0n;
    const estimate = 4_000_000n;
    const gas = 4_800_000n;
    const cost = gas * feesFor(1n, 1n).maxFeePerGas;
    expect(transactionGas('itemSync', estimate)).toBe(gas);
    expect(jobSpec('itemSync')).toMatchObject({ tip: 'none', budget: 'ours', reserved: true });
    let saved: KeeperState = {};
    const send = vi.fn(async (_c, limit) => {
      expect(limit).toBe(gas);
      expect(saved.budget?.totalWei).toBe(cost);
      expect(saved.budget?.oursWei).toBe(cost);
      return 'sync-transaction';
    }) as ChainPort['send'];
    const port: ChainPort = {
      read: f.chain.read.bind(f.chain), send,
      simulate: async (c, fees) => ({ ...await f.chain.simulate(c, fees), estimate }),
    };
    const cfg = { ...f.cfg, dryRun: false,
      limits: { ...f.cfg.limits, oursWeiPerDay: cost, totalWeiPerDay: cost, reserveWeiPerDay: 0n },
      checkpoint: async (s: KeeperState) => { saved = restartState(s); } };
    await runTick(port, {}, cfg, quiet);
    expect(send).toHaveBeenCalledTimes(1);
    f.s.block += f.cfg.retryBlocks;
    const spent = await runTick(port, saved, cfg, quiet);
    expect(spent.report.skipped).toContainEqual(expect.objectContaining({ job: 'itemSync', why: 'daily ceiling reached' }));
    expect(send).toHaveBeenCalledTimes(1);
    f.s.now += 86_400n; f.s.block++;
    await runTick(port, saved, cfg, quiet);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('admits sync from protected capacity only when funded and never broadcasts a dry run', async () => {
    const f = m3Fixture(); f.s.residue = 0n;
    const cost = transactionGas('itemSync', 100_000n) * feesFor(1n, 1n).maxFeePerGas;
    const send = vi.fn(async () => { throw new Error('dry run must not broadcast'); });
    const port: ChainPort = { read: f.chain.read.bind(f.chain), simulate: f.chain.simulate.bind(f.chain), send };
    const cfg = { ...f.cfg, dryRun: true,
      limits: { ...f.cfg.limits, oursWeiPerDay: cost, totalWeiPerDay: cost - 1n, reserveWeiPerDay: cost - 1n } };
    const deferred = await runTick(port, {}, cfg, quiet);
    expect(deferred.report.sent).toHaveLength(0);
    expect(deferred.report.skipped).toContainEqual(expect.objectContaining({ job: 'itemSync', why: 'daily ceiling reached' }));
    expect(deferred.state.budget.totalWei).toBe(0n);
    const dry = await runTick(port, deferred.state,
      { ...cfg, limits: { ...cfg.limits, totalWeiPerDay: cost, reserveWeiPerDay: cost } }, quiet);
    expect(dry.report.sent).toEqual([expect.objectContaining({ job: 'itemSync', asOurs: true })]);
    expect(dry.state.budget.totalWei).toBe(cost);
    expect(dry.state.budget.oursWei).toBe(cost);
    expect(send).not.toHaveBeenCalled();
    expect([f.s.processedFunding, f.s.processedLifecycle]).toEqual([0n, 0n]);
  });

  it('backs off refused syncs across restarts without suppressing independent residue work', async () => {
    const f = m3Fixture(); f.s.broken.add('simulate:sync');
    const first = await runTick(f.chain, {}, f.cfg, quiet);
    expect(first.report.skipped).toContainEqual(expect.objectContaining({ job: 'itemSync', why: 'simulation error' }));
    expect(first.report.sent.map((c) => c.job)).toEqual(['itemResidue']);
    const state = restartState(first.state);
    f.s.broken.clear();
    expect((await runTick(f.restart(), state, f.cfg, quiet)).report.sent).toHaveLength(0);
    f.s.block += f.cfg.retryBlocks;
    const retry = await runTick(f.restart(), state, f.cfg, quiet);
    expect(retry.report.sent.filter((c) => c.job === 'itemSync')).toHaveLength(1);
    const sync = (await f.candidates()).find((c) => c.job === 'itemSync');
    expect(sync).toBeDefined(); if (!sync) return;
    f.s.pendingCaughtUp = true;
    expect((await f.chain.simulate(sync, feesFor(1n, 1n))).ok).toBe(false);
  });
});

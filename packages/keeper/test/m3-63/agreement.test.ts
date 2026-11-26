import { describe, expect, it, vi } from 'vitest';
import { zeroAddress } from 'viem';
import { feesFor, transactionGas } from '../../src/gas';
import { runTick, type ChainPort, type KeeperState } from '../../src/run';
import { decodeState, encodeState } from '../../src/state';
import { jobSpec } from '../../src/jobs';
import { m3Fixture, parts, YEAR } from '../support/m3';
import { quiet } from '../support/v2';

const restart = (state: KeeperState) => decodeState(encodeState(state, 'm363'), 'm363');

describe('M363-KEEPER: permissionless maintenance cannot spend wallet credits', () => {
  it.each([[1n, 0n, true], [0n, 1n, true], [0n, 0n, false]])('funding/lifecycle backlog %s/%s triggers only bounded sync and residue', async (funding, lifecycle, due) => {
    const f = m3Fixture(); Object.assign(f.s, { funding, lifecycle, duplicates: true });
    const work = (await f.candidates()).filter(c => ['itemSync', 'itemResidue'].includes(c.job));
    expect(work.filter(c => c.job === 'itemSync')).toHaveLength(due ? 1 : 0);
    if (due) expect(work.find(c => c.job === 'itemSync')).toMatchObject({ fn: 'sync', to: parts.ledger, args: [32n] });
    expect(new Set(work.map(c => c.key)).size).toBe(work.length);
    expect(work.map(c => c.fn)).not.toContain('claim');
    expect(f.s.reads.some(r => /ownerOf|itemCredit|ticketCredit/.test(r.fn))).toBe(false);
  });

  it('wrong wiring, impossible cursors and a pending catch-up never authorize sync', async () => {
    const f = m3Fixture(); f.s.wiring = false;
    expect((await f.candidates()).some(c => c.job.startsWith('item'))).toBe(false);
    f.s.wiring = true; f.s.processedFunding = f.s.funding + 1n;
    expect((await f.candidates()).some(c => c.job === 'itemSync')).toBe(false);
    f.s.processedFunding = 0n;
    const sync = (await f.candidates()).find(c => c.job === 'itemSync');
    if (!sync) throw new Error('missing fixture sync');
    f.s.pendingCaughtUp = true;
    expect((await f.chain.simulate(sync, feesFor(1n, 1n))).ok).toBe(false);
    expect(f.s.simulations).not.toContain('sync');
  });

  it('a measured Amsterdam 32-record estimate exceeds the floor and is durably budgeted before sending', async () => {
    const f = m3Fixture(); f.s.residue = 0n;
    const estimate = 12_064_763n, gas = transactionGas('itemSync', estimate), cost = gas * feesFor(1n, 1n).maxFeePerGas;
    expect(gas).toBe(14_477_715n); expect(gas).toBeGreaterThan(3_000_000n);
    let saved: KeeperState = {};
    const send = vi.fn(async (_c: Parameters<ChainPort['send']>[0], limit: bigint) => {
      expect(limit).toBe(gas); expect(saved.budget?.oursWei).toBe(cost); return 'review-double-tx';
    }) as ChainPort['send'];
    const port: ChainPort = { read: f.chain.read.bind(f.chain), simulate: async (c, fees) => ({ ...await f.chain.simulate(c, fees), estimate }), send };
    const cfg = { ...f.cfg, dryRun: false, limits: { ...f.cfg.limits, oursWeiPerDay: cost, totalWeiPerDay: cost, reserveWeiPerDay: 0n },
      checkpoint: async (s: KeeperState) => { saved = restart(s); } };
    const first = await runTick(port, {}, cfg, quiet);
    expect(first.report.sent).toEqual([expect.objectContaining({ job: 'itemSync', asOurs: true, gas })]);
    f.s.block += f.cfg.retryBlocks;
    const second = await runTick(port, restart(saved), cfg, quiet);
    expect(second.report.sent).toEqual([]); expect(send).toHaveBeenCalledTimes(1);
    expect(second.report.skipped).toContainEqual(expect.objectContaining({ job: 'itemSync', why: 'daily ceiling reached' }));
    f.s.now += 86_400n; f.s.block++;
    await runTick(port, restart(saved), cfg, quiet); expect(send).toHaveBeenCalledTimes(2);
  });

  it('a sync refusal leaves independent residue work retryable and never pays a claim', async () => {
    const f = m3Fixture(); f.s.broken.add('simulate:sync');
    const first = await runTick(f.chain, {}, f.cfg, quiet);
    expect(first.report.sent.map(c => c.job)).toEqual(['itemResidue']);
    const state = restart(first.state); f.s.broken.clear();
    expect((await runTick(f.restart(), state, f.cfg, quiet)).report.sent).toEqual([]);
    f.s.block += f.cfg.retryBlocks;
    expect((await runTick(f.restart(), state, f.cfg, quiet)).report.sent.map(c => c.job)).toContain('itemSync');
    expect(f.s.credit).toBe(10n ** 24n);
    for (const name of ['itemSync', 'itemResidue', 'pileLoadSeed', 'pileReturnSeed'] as const) expect(jobSpec(name)).toMatchObject({ tip: 'none', budget: 'ours' });
  });

  it('seed maintenance authenticates the pile, never supplies native value or redeems owner T', async () => {
    const f = m3Fixture(); Object.assign(f.s, { item: false, pile: true, graduated: false, gate: false });
    expect((await f.candidates()).filter(c => c.job.startsWith('pile'))).toMatchObject([{ fn: 'loadSeed', to: parts.vault, args: [] }]);
    f.s.asset = zeroAddress;
    expect((await f.candidates()).some(c => c.job === 'pileLoadSeed')).toBe(false);
    f.s.failed = true;
    expect((await f.candidates()).filter(c => c.job.startsWith('pile'))).toMatchObject([{ fn: 'returnSeed', args: [], to: parts.vault }]);
    f.s.sameFactory = false;
    expect((await f.candidates()).some(c => c.job.startsWith('pile'))).toBe(false);
    expect(f.s.simulations).not.toContain('redeem');
  });

  it('RC5 never schedules a sweep with a fixed nonzero count', async () => {
    const f = m3Fixture(); Object.assign(f.s, { failed: true, graduated: false, item: false, left: 2n ** 100n + 1n });
    f.s.failedAt = f.s.now - YEAR + 1n;
    expect((await f.candidates()).some(c => c.fn === 'sweepAfterLastClaim')).toBe(false);
    f.s.now++;
    expect((await f.candidates()).some(c => c.fn === 'sweepAfterLastClaim')).toBe(false);
    expect(f.s.left).toBe(2n ** 100n + 1n);
    expect(f.s.reads.some(r => r.fn === 'totalSupply')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { encodeFunctionData } from 'viem';
import { abiFor } from '../src/abi';
import { feesFor, transactionGas } from '../src/gas';
import { oursList } from '../src/jobs';
import { runTick, type KeeperState } from '../src/run';
import { decodeState, encodeState } from '../src/state';
import { m3Fixture, parts, YEAR } from './support/m3';
import { addr, quiet } from './support/v2';

describe('M3-51 permissionless maintenance, F127 and RC5-A', () => {
  it('syncs both journals in bounded pages without enumerating owners or spending their credit', async () => {
    const f = m3Fixture();
    const cs = await f.candidates();
    expect(cs).toContainEqual(expect.objectContaining({ job: 'itemSync', to: parts.ledger, fn: 'sync', args: [32n] }));
    expect(cs).toContainEqual(expect.objectContaining({ job: 'itemResidue', to: parts.ledger, fn: 'flushResidue', args: [] }));
    for (const c of cs) expect(encodeFunctionData({ abi: abiFor(c), functionName: c.fn, args: c.args })).toMatch(/^0x/);
    expect(cs.some((c) => /claimFor|redeem|claimCreator/.test(c.fn))).toBe(false);
    expect(f.s.reads.some((r) => /itemCredit|ownerOf|ticketCredit/.test(r.fn))).toBe(false);
    expect(f.s.credit).toBe(10n ** 24n);
    expect(f.s.reads.every((r) => r.blockNumber === 99n)).toBe(true);
  });
  it('catches lifecycle-only work before graduation and stops sync when both cursors catch up', async () => {
    const f = m3Fixture(); Object.assign(f.s, { graduated: false, funding: 0n, lifecycle: 1n });
    expect((await f.candidates()).some((c) => c.fn === 'sync')).toBe(true);
    f.s.processedLifecycle = 1n;
    expect((await f.candidates()).some((c) => c.fn === 'sync')).toBe(false);
    f.s.processedLifecycle = 2n;
    expect((await f.candidates()).some((c) => c.fn === 'sync')).toBe(false);
  });
  it('rechecks pending cursors for a void sync result so another keeper cannot create paid no-work', async () => {
    const f = m3Fixture();
    const c = (await f.candidates()).find((c) => c.fn === 'sync');
    expect(c).toBeDefined(); if (!c) return;
    expect((await f.chain.simulate(c, feesFor(1n, 1n))).ok).toBe(true);
    f.s.pendingCaughtUp = true;
    expect((await f.chain.simulate(c, feesFor(1n, 1n))).ok).toBe(false);
    expect(f.s.simulations.filter((fn) => fn === 'sync')).toHaveLength(1);
    expect(f.s.reads.filter((r) => r.blockTag === 'pending')).toHaveLength(8);
  });
  it('uses canonical roles, isolates missing histories, and rejects an unauthenticated pile predicate', async () => {
    const f = m3Fixture(); Object.assign(f.s, { failed: true, graduated: false, pile: true });
    f.s.wiring = false;
    expect((await f.candidates()).some((c) => c.to === parts.ledger)).toBe(false);
    expect((await f.candidates()).some((c) => c.fn === 'returnSeed')).toBe(true);
    f.s.wiring = true; f.s.broken.add('itemFundingCount');
    expect((await f.candidates()).some((c) => c.fn === 'returnSeed')).toBe(true);
    f.s.sameFactory = false;
    expect((await f.candidates()).some((c) => c.fn === 'returnSeed')).toBe(false);
    f.s.sameFactory = true; f.s.broken.add('isPileVault');
    expect((await f.candidates()).some((c) => c.fn === 'returnSeed')).toBe(false);
    expect((await f.candidates()).some((c) => c.fn === 'sweepAfterLastClaim')).toBe(false);
  });
  it('loads only a pending nonzero ERC-20 seed from its seeder; never sends native value or redeems T', async () => {
    const f = m3Fixture(); Object.assign(f.s, { item: false, pile: true, gate: false, graduated: false });
    const c = (await f.candidates()).find((c) => c.fn === 'loadSeed');
    expect(c).toEqual(expect.objectContaining({ job: 'pileLoadSeed', to: parts.vault, args: [] }));
    if (c) expect((await f.chain.simulate(c, feesFor(1n, 1n))).ok).toBe(true);
    for (const patch of [{ asset: addr(0) }, { seed: 0n }, { pendingSeed: false }, { gate: true }, { graduated: true }, { failed: true }]) {
      const g = m3Fixture(); Object.assign(g.s, { item: false, pile: true, gate: false, graduated: false }, patch);
      expect((await g.candidates()).some((c) => c.fn === 'loadSeed')).toBe(false);
    }
    expect((await f.candidates()).some((c) => c.fn === 'redeem')).toBe(false);
  });
  it.each([addr(0), parts.asset])('returns a failed seed of %s only through its fixed-recipient function', async (asset) => {
    const f = m3Fixture(); Object.assign(f.s, { failed: true, graduated: false, pile: true, asset });
    const c = (await f.candidates()).find((c) => c.fn === 'returnSeed');
    expect(c).toEqual(expect.objectContaining({ job: 'pileReturnSeed', to: parts.vault, args: [] }));
    if (!c) return;
    expect((await f.chain.simulate(c, feesFor(1n, 1n))).ok).toBe(true);
    f.s.seedReturn = 0n;
    expect((await f.chain.simulate(c, feesFor(1n, 1n))).ok).toBe(false);
    f.s.pile = false;
    expect((await f.candidates()).some((c) => c.fn === 'returnSeed')).toBe(false);
  });
  it('never schedules a pot sweep before or after one year', async () => {
    const f = m3Fixture(); Object.assign(f.s, { failed: true, graduated: false });
    f.s.now = f.s.failedAt + YEAR - 1n;
    expect((await f.candidates()).some((c) => c.fn === 'sweepAfterLastClaim')).toBe(false);
    f.s.now++;
    expect((await f.candidates()).some((c) => c.fn === 'sweepAfterLastClaim')).toBe(false);
    f.s.now--; f.s.left = 0n;
    expect((await f.candidates()).some((c) => c.fn === 'sweepAfterLastClaim')).toBe(false);
    f.s.left = 1n; f.s.broken.add('failedAt');
    expect((await f.candidates()).some((c) => c.fn === 'sweepAfterLastClaim')).toBe(false);
  });
  it('leaves empty and late pots alone without collecting failed receiver money', async () => {
    const f = m3Fixture(); Object.assign(f.s, { failed: true, graduated: false, pot: 0n });
    for (const pot of [0n, 10n ** 24n]) {
      f.s.pot = pot;
      const jobs = await f.candidates();
      expect(jobs.some(c => c.fn === 'sweepAfterLastClaim')).toBe(false);
      expect(jobs.some(c => c.fn === 'collect')).toBe(false);
    }
    expect(f.s.reads.some(r => r.fn === 'quoteClaim' || r.fn === 'failedAt')).toBe(false);
  });
  it('deduplicates events, persists retry backoff across restart, and keeps failed seed retries independent', async () => {
    const f = m3Fixture(); Object.assign(f.s, { failed: true, graduated: false, pile: true, duplicates: true });
    f.s.broken.add('simulate:returnSeed');
    const first = await runTick(f.chain, {}, f.cfg, quiet);
    expect(first.report.skipped).toContainEqual(expect.objectContaining({ job: 'pileReturnSeed', why: 'simulation error' }));
    expect(first.report.sent.filter((c) => c.job === 'itemSync')).toHaveLength(1);
    expect(first.report.sent.filter((c) => String(c.job) === 'sweepAfterLastClaim')).toHaveLength(0);
    const saved = decodeState(encodeState(first.state, 'm3'), 'm3');
    expect((await runTick(f.restart(), saved, f.cfg, quiet)).report.sent).toHaveLength(0);
    f.s.block += 2n; f.s.broken.clear();
    const retry = await runTick(f.restart(), saved, f.cfg, quiet);
    expect(retry.report.sent.filter((c) => c.job === 'pileReturnSeed')).toHaveLength(1);
    // Reorg restores work; no event or in-memory completion overrides canonical state.
    f.s.processedFunding = f.s.funding; f.s.processedLifecycle = f.s.lifecycle;
    expect((await f.candidates()).some((c) => c.fn === 'sync')).toBe(false);
    f.s.processedLifecycle--;
    expect((await f.candidates()).some((c) => c.fn === 'sync')).toBe(true);
  });
  it('reserves untipped gas before broadcast, keeps the spent day on restart, and resumes next UTC day', async () => {
    const f = m3Fixture(); f.s.processedFunding = f.s.funding; f.s.processedLifecycle = f.s.lifecycle;
    const cost = transactionGas('itemResidue', 100_000n) * feesFor(1n, 1n).maxFeePerGas;
    let saved: KeeperState = {};
    let sends = 0;
    const cfg = { ...f.cfg, dryRun: false, limits: { ...f.cfg.limits, reserveWeiPerDay: 0n, oursWeiPerDay: cost, totalWeiPerDay: cost },
      checkpoint: async (s: KeeperState) => { saved = decodeState(encodeState(s, 'm3'), 'm3'); } };
    const port = { read: f.chain.read.bind(f.chain), simulate: f.chain.simulate.bind(f.chain),
      send: async () => { expect(saved.budget?.totalWei).toBe(cost); sends++; return 'hash'; } };
    await runTick(port, {}, cfg, quiet);
    expect(sends).toBe(1);
    f.s.block += 2n;
    const next = await runTick(port, saved, cfg, quiet);
    expect(sends).toBe(1); expect(next.state.budget.totalWei).toBe(cost);
    f.s.now += 86_400n; f.s.block++;
    await runTick(port, saved, cfg, quiet);
    expect(sends).toBe(2);
  });
  it('publishes every M3 operator job without tips or removed jobs', () => {
    for (const job of ['itemSync', 'itemResidue', 'pileLoadSeed', 'pileReturnSeed']) {
      expect(oursList().find((j) => j.job === job)?.when).toBe('always');
    }
    expect(oursList().some((j) => /claimFor|pairing|heldNFT|settleCap/.test(j.job))).toBe(false);
  });
});

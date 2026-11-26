import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { emptyMemory, plan, afterRun } from '../../../../../keeper/src/plan';
import { transactionGas } from '../../../../../keeper/src/gas';
import { runTick, type ChainPort, type KeeperState } from '../../../../../keeper/src/run';
import { decodeState, encodeState } from '../../../../../keeper/src/state';
import { box, world, options, quiet, v2, time } from '../../../../../keeper/test/support/v2';
import { m3Fixture, YEAR, parts } from '../../../../../keeper/test/support/m3';

describe('FINAL-JOBS: canonical lifecycle, bounded maintenance and reserved gas', () => {
  it('the filled hatch uses the first close time, and excludes graduation at the exact seven-day boundary', () => {
    const b = box({ graduated: false });
    const before = plan(world(b, 100n, v2.closedAt + 604_799n), emptyMemory(), options()).candidates;
    const due = plan(world(b, 101n, v2.closedAt + 604_800n), emptyMemory(), options()).candidates;
    expect(before.some(c => c.fn === 'graduate')).toBe(true); expect(before.some(c => c.fn === 'fail')).toBe(false);
    expect(due.some(c => c.fn === 'fail')).toBe(true); expect(due.some(c => c.fn === 'graduate')).toBe(false);
    for (const terminal of [box({ failed: true, graduated: false }), box({ graduated: true })]) {
      expect(plan(world(terminal, 102n, time + 700_000n), emptyMemory(), options()).candidates.some(c => c.fn === 'fail')).toBe(false);
    }
  });

  it('the held gate uses fourteen days and an unfilled box uses its own deadline', () => {
    const gate = box({ graduated: false, gateOpen: false, curveClosed: false });
    for (const delta of [-1n, 0n]) {
      expect(plan(world(gate, 100n, gate.openAt + 1_209_600n + delta), emptyMemory(), options()).candidates.some(c => c.fn === 'failClosed')).toBe(delta === 0n);
      const open = box({ graduated: false, curveClosed: false });
      expect(plan(world(open, 100n, open.deadline + delta), emptyMemory(), options()).candidates.some(c => c.fn === 'fail')).toBe(delta === 0n);
    }
  });

  it('buy-back and deepen alternate across blocks and never consume two steps in one pool/block', () => {
    const w = world(); let mem = emptyMemory(); const choices: string[] = [];
    for (let n = 100n; n < 106n; ++n) {
      const current = { ...w, block: { ...w.block, number: n } };
      const steps = plan(current, mem, options()).candidates.filter(c => c.fn === 'buyBack' || c.fn === 'deepen');
      expect(steps).toHaveLength(1); const step = steps[0]; if (!step) throw new Error('missing step');
      choices.push(step.fn); mem = afterRun(mem, step, true, current);
      expect(plan(current, mem, options()).candidates.some(c => c.fn === 'buyBack' || c.fn === 'deepen')).toBe(false);
    }
    expect(choices).toEqual(['buyBack', 'deepen', 'buyBack', 'deepen', 'buyBack', 'deepen']);
  });

  it('permanent claims and independent seed recovery do not enumerate or spend wallet credit', async () => {
    const f = m3Fixture(); Object.assign(f.s, { failed: true, graduated: false, pile: true });
    f.s.now = f.s.failedAt + YEAR - 1n;
    expect((await f.candidates()).some(c => c.fn === 'sweepAfterLastClaim')).toBe(false);
    f.s.now++;
    const jobs = await f.candidates();
    expect(jobs).toContainEqual(expect.objectContaining({ fn: 'returnSeed', to: parts.vault, args: [] }));
    expect(jobs.some(c => c.fn === 'sweepAfterLastClaim')).toBe(false);
    expect(jobs.some(c => c.fn === 'claim' || c.fn === 'claimFor' || c.fn === 'redeem')).toBe(false);
    expect(f.s.reads.some(r => r.fn === 'ownerOf' || r.fn === 'claimable')).toBe(false);
    f.s.broken.add('itemFundingCount');
    expect((await f.candidates()).some(c => c.fn === 'returnSeed')).toBe(true);
  });

  it('gas liability is durable before a failed broadcast, remains charged on restart, and never spends over budget', async () => {
    const w = world(box({ failed: true, graduated: false, v2: { ...v2, pot: 0n, m2: [
      { job: 'shopBurn', to: parts.vault, fn: 'burnFailedT', args: [], key: 'final-burn' },
    ] } }));
    let saved: KeeperState = {}; let broadcasts = 0;
    const port: ChainPort = {
      read: async () => w,
      simulate: async c => ({ ok: c.fn === 'burnFailedT', estimate: 30_000n, tipWei: 0n }),
      send: async (_c, gas) => {
        expect(gas).toBe(5_000_000n);
        expect(saved.budget?.totalWei).toBe(15_000_000n);
        broadcasts++; throw new Error('broadcast outcome unknown');
      },
    };
    const cfg = { ...options(), dryRun: false, priorityFeeWei: 1n,
      limits: { ...options().limits, totalWeiPerDay: 15_000_000n, oursWeiPerDay: 15_000_000n, reserveWeiPerDay: 0n },
      checkpoint: async (state: KeeperState) => { saved = decodeState(encodeState(state, 'final'), 'final'); },
    };
    const first = await runTick(port, {}, cfg, quiet);
    expect(broadcasts).toBe(1); expect(first.state.budget?.totalWei).toBe(15_000_000n);
    await runTick(port, saved, cfg, quiet); expect(broadcasts).toBe(1);
    broadcasts = 0;
    await runTick(port, {}, { ...cfg, limits: { ...cfg.limits, totalWeiPerDay: 14_999_999n } }, quiet);
    expect(broadcasts).toBe(0);
  });

  it('the Solidity reproduction is tied to the current keeper floor, not an invented gas number', () => {
    const source = readFileSync(new URL('./Agreement.t.sol', import.meta.url), 'utf8');
    const value = source.match(/KEEPER_RETURN_FLOOR = ([\d_]+);/)?.[1];
    if (!value) throw new Error('missing caller envelope');
    expect(BigInt(value.replaceAll('_', ''))).toBe(transactionGas('shopReturn', 30_000n));
  });
});

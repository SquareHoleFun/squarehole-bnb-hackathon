import { describe, expect, it } from 'vitest';
import { interpret } from '../../src/chain';
import { afterRun, emptyMemory, plan } from '../../src/plan';
import { runTick, type KeeperState } from '../../src/run';
import type { Candidate } from '../../src/types';
import { box, options, quiet, v2, world } from '../support/v2';

const owed = (1n << 200n) + 7n;
const safes = ['receiverPayFit', 'receiverPayPlatform'] as const;

describe('FINAL2-OC03: F130 keeps fixed-Safe maintenance permissionless', () => {
  it.each(['live', 'graduated', 'failed'] as const)('schedules both backed Safe debts for a %s v2 box', phase => {
    const b = box({ graduated: phase === 'graduated', failed: phase === 'failed',
      curveClosed: false, fitOwed: owed, platformOwed: owed, v2 });
    const cs = plan(world(b), emptyMemory(), options()).candidates;
    for (const job of safes) {
      expect(cs.find(c => c.job === job), 'burn-bot policy schedules immutable-Safe payouts independently of phase and box-0 graduation')
        .toMatchObject({ job, version: 2, to: b.receiver, fn: job === 'receiverPayFit' ? 'payFit' : 'payPlatform', args: [] });
    }
    expect(cs.some(c => ['claim', 'claimFor', 'claimCreator', 'redeem'].includes(c.fn))).toBe(false);
  });

  it.each(safes)('accepts a successful %s simulation without inventing a caller tip', job => {
    const b = box();
    const c: Candidate = { job, version: 2, boxId: b.id, to: b.receiver, key: `${job}:round2`,
      fn: job === 'receiverPayFit' ? 'payFit' : 'payPlatform', args: [] };
    expect(interpret(c, owed, null)).toMatchObject({ ok: true, tipWei: null });
    expect(interpret(c, 0n, null).ok).toBe(false);
  });

  it('does not schedule empty Safe debts or third-party user claims, and keeps box-0 payouts', () => {
    const empty = plan(world(box({ fitOwed: 0n, platformOwed: 0n })), emptyMemory(), options()).candidates;
    expect(empty.some(c => safes.some(job => job === c.job))).toBe(false);
    expect(empty.some(c => ['claim', 'claimFor', 'claimCreator', 'redeem'].includes(c.fn))).toBe(false);
    const legacy = plan(world(box({ version: 1, fitOwed: owed, platformOwed: owed })), emptyMemory(), options()).candidates;
    expect(legacy.map(c => c.job)).toEqual(expect.arrayContaining([...safes]));
  });

  it('schedules one raw P without metadata or a payout minimum and retries each Safe independently', () => {
    const b = box({ graduated: false, curveClosed: false, fitOwed: 1n, platformOwed: owed,
      v2: { ...v2, qDecimals: null } });
    const cfg = { ...options(), payoutMinWei: owed + 1n };
    const w = world(b);
    const cs = plan(w, emptyMemory(), cfg).candidates.filter(c => safes.some(job => job === c.job));
    expect(cs).toHaveLength(2);
    const fit = cs.find(c => c.job === 'receiverPayFit');
    if (!fit) throw new Error('FIT candidate missing');
    expect(fit.key).toBe(`receiverPayFit:2:${b.hook.toLowerCase()}`);
    const mem = afterRun(emptyMemory(), fit, false, w);
    expect(plan(world(b, 101n), mem, cfg).candidates.filter(c => safes.some(job => job === c.job)).map(c => c.job))
      .toEqual(['receiverPayPlatform']);
    expect(plan(world(b, 102n), mem, cfg).candidates.filter(c => safes.some(job => job === c.job))).toHaveLength(2);
  });

  it('zero progress on FIT does not delay platform; both payouts use untipped durable budgets', async () => {
    const cfg = options();
    const w = world(box({ failed: true, fitOwed: 1n, platformOwed: owed }));
    const saved: KeeperState[] = [];
    const sent: string[] = [];
    const out = await runTick({ read: async () => w,
      simulate: async c => ({ ...interpret(c, c.job === 'receiverPayPlatform' ? owed : 0n, null),
        ok: c.job === 'receiverPayPlatform', estimate: 12_000_000n }),
      send: async (c, gas) => {
        const budget = saved.at(-1)?.budget;
        expect(budget?.totalWei).toBe(gas * 3n);
        expect(budget?.oursWei).toBe(budget?.totalWei);
        sent.push(c.job);
        return 'local';
      },
    }, {}, { ...cfg, dryRun: false, priorityFeeWei: 1n,
      checkpoint: async state => { saved.push(state); } }, quiet);
    expect(sent).toEqual(['receiverPayPlatform']);
    expect(out.report.skipped).toContainEqual(expect.objectContaining({ job: 'receiverPayFit', why: 'nothing to do' }));
    expect(out.state.budget.oursWei).toBe(43_200_000n);
  });
});

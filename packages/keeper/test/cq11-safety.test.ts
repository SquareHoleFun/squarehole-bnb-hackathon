import { describe, expect, it } from 'vitest';
import { afterRun, emptyMemory, plan } from '../src/plan';
import { runTick, type ChainPort, type KeeperState } from '../src/run';
import { interpret } from '../src/chain';
import { feesFor, gasLimitFrom } from '../src/gas';
import { decide, openBudget } from '../src/decide';
import type { Candidate } from '../src/types';
import { box, world, v2, options, quiet } from './support/v2';

describe('CQ11-E budget, no-work and restart safety', () => {
  it('decodes v2 results without assigning an ETH price to ERC-20 P', () => {
    const c: Candidate = { job: 'deepen', key: 'x', to: box().hook, fn: 'deepen', args: [], version: 2 };
    expect(interpret(c, [0, 10n, 5n, 1n], null)).toMatchObject({ ok: true, tipWei: null });
    expect(interpret(c, [0, 10n, 5n, 1n], 10n ** 18n)).toMatchObject({ ok: true, tipWei: 1n });
    for (const result of [[1, 0n, 0n, 0n], [0, 0n, 0n, 0n]]) expect(interpret(c, result, null).ok).toBe(false);
    expect(interpret({ ...c, job: 'buyBack' }, [0, 0n, 0n, 0n], null).ok).toBe(false);
    expect(interpret({ ...c, job: 'collect' }, { buyersP: 0n, sellersP: 0n, qToReserve: 0n, tip: 0n }, null).ok).toBe(false);
  });
  it('settles refused graduation escrow even when collect reports no new fee batch', () => {
    const w = world(box({ v2: { ...v2, graduationSettled: false, buyBackP: 0n, depthBudget: 0n } }));
    const collect = plan(w, emptyMemory(), options()).candidates.find((c) => c.job === 'collect');
    if (!collect) throw new Error('collect missing');
    expect(interpret(collect, { buyersP: 0n, sellersP: 0n, qToReserve: 0n, tip: 0n }, null).ok).toBe(true);
  });
  it('charges the full signed gas limit at the fee cap, including headroom, before broadcasting', async () => {
    const w = world(box({ version: 1, fitOwed: 10n ** 22n }));
    const cfg = { ...options(), dryRun: false };
    const checkpoints: KeeperState[] = [];
    let reserved = 0n;
    const port: ChainPort = { read: async () => w,
      simulate: async (c) => ({ ok: c.job === 'receiverPayFit', tipWei: null, estimate: 100000n }),
      send: async () => { reserved = checkpoints.at(-1)?.budget?.totalWei ?? 0n; throw new Error('ambiguous timeout'); },
    };
    const out = await runTick(port, {}, { ...cfg, checkpoint: async (s: KeeperState) => { checkpoints.push(s); } }, quiet);
    const cap = gasLimitFrom(100000n) * feesFor(w.block.baseFeePerGas, cfg.priorityFeeWei).maxFeePerGas;
    expect(reserved).toBe(cap);
    expect(out.state.budget.totalWei).toBe(cap);
    expect(out.report.sent).toEqual([]);
  });
  it('does not replenish a daily budget when block time moves backwards', () => {
    const spent = { ...openBudget(undefined, 10n, 172800n), totalWei: 50n };
    expect(openBudget(spent, 9n, 172799n).totalWei).toBe(50n);
    const cfg = options();
    const fees = feesFor(100n, 1n);
    expect(decide('fail', { ok: true, tipWei: null, estimate: 100000n }, {
      fees, budget: openBudget(undefined, 1n, 0n), limits: { ...cfg.limits, maxFeePerGas: 200n }, privateEndpoint: false,
    })).toEqual({ send: false, why: 'fee ceiling reached' });
  });
  it('keeps backlog age across retries and clears it only when the canonical balance empties', () => {
    const o = options();
    const first = plan(world(), emptyMemory(), o);
    const waiting = plan(world(box(), 104n), first.mem, o);
    expect(waiting.alerts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'buyBackWaiting', sinceBlock: 100n })]));
    const cleared = plan(world(box({ v2: { ...v2, buyBackP: 0n } }), 105n), waiting.mem, o);
    expect(cleared.alerts).toEqual([]);
    const again = plan(world(box(), 106n), cleared.mem, o);
    expect(again.alerts).toEqual([]);
  });
  it('backs off a no-work step, tries the other side, and never resets the hatch clock', () => {
    const w = world();
    const first = plan(w, emptyMemory(), options());
    const c = first.candidates.find((j) => j.job === 'buyBack');
    if (!c) throw new Error('buyBack missing');
    expect(c).toBeDefined();
    const mem = afterRun(first.mem, c, false, w);
    expect(plan(world(box(), 101n), mem, options()).candidates.map((j) => j.job)).toContain('deepen');
    expect(plan(w, mem, options()).candidates.map((j) => j.job)).not.toContain('buyBack');
  });
});

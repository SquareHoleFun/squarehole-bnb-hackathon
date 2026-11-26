/**
 * SH-V21-07-08 merge: the sellers core shop step (ShopT 11, SF-K) and a directory module side (choice 10, AL22) share
 * the receiver entry executeModule(bool) but stay two ordinary keeper jobs: their own keys, gas floors and retry rules,
 * the same F111 income caps, and only the shop step takes the pool's protocol-step slot.
 */
import { expect, it } from 'vitest';
import { incomeCapped } from '../src/income';
import { jobSpec } from '../src/jobs';
import { afterRun, emptyMemory, plan } from '../src/plan';
import { box, options, v2, world } from './support/v2';

const both = () => box({ v2: { ...v2, buyBackP: 0n, depthBudget: 0n, shopPendingP: 1000n, modulePendingP: [7n, null] as const } });
const calls = (w = world(both()), memory = emptyMemory()) => plan(w, memory, options()).candidates.filter(c => c.fn === 'executeModule');

it('schedules a buyers module side and the sellers shop step as separate ordinary jobs under the same F111 caps', () => {
  const cs = calls();
  expect(cs.map(c => [c.job, c.args])).toEqual([['executeModule', [false]], ['shopFees', [true]]]);
  expect(new Set(cs.map(c => c.key)).size).toBe(2);
  for (const c of cs) expect(incomeCapped(c), c.job).toBe(true);
  expect([jobSpec('executeModule').gasPerRun, jobSpec('shopFees').gasPerRun]).toEqual([3_500_000n, 3_500_000n]);
  expect([jobSpec('executeModule').reserved, jobSpec('shopFees').reserved]).toEqual([false, false]);
  const [module, shop] = cs;
  if (!module || !shop) throw new Error('missing candidate');
  // A sent shop step takes this block's pool step; the module side does not use that slot and stays due.
  const bought = afterRun(emptyMemory(), shop, true, world(both()));
  expect(bought.steps).toEqual({ [both().hook.toLowerCase()]: { job: 'shopFees', block: 100n, sent: true } });
  expect(calls(world(both()), bought).map(c => c.job)).toEqual(['executeModule']);
  // A sent module call retries next block; the shop step still has the pool step.
  const moved = afterRun(emptyMemory(), module, true, world(both()));
  expect(moved.steps).toEqual({});
  expect(calls(world(both()), moved).map(c => c.job)).toEqual(['shopFees']);
  expect(calls(world(both(), 101n), moved).map(c => c.job)).toEqual(['executeModule', 'shopFees']);
});

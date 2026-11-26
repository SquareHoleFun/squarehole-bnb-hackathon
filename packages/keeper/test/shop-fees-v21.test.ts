import { expect, it } from 'vitest';
import { afterRun, emptyMemory, plan } from '../src/plan';
import { incomeCapped } from '../src/income';
import { box, options, v2, world } from './support/v2';
it('SF-K schedules sellers shop fees as ordinary work sharing the pool step', () => {
  const w = world(box({ v2: { ...v2, buyBackP: 0n, depthBudget: 0n, shopPendingP: 1000n } }));
  const candidates = plan(w, emptyMemory(), options()).candidates;
  const step = candidates.find(c => c.fn === 'executeModule');
  expect(step).toMatchObject({ job: 'shopFees', args: [true], version: 2 });
  if (!step) throw new Error('shop step missing');
  expect(incomeCapped(step)).toBe(true);
  expect(plan(w, afterRun(emptyMemory(), step, true, w), options()).candidates.some(c => c.fn === 'executeModule')).toBe(false);
  expect(plan(world(box({ failed: true, v2: { ...v2, shopPendingP: 1000n } })), emptyMemory(), options()).candidates.some(c => c.fn === 'executeModule')).toBe(false);
});

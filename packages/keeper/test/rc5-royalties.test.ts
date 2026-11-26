import { expect, it } from 'vitest';
import { JOBS } from '../src/jobs';
it('RC5 maintains each royalty router without a conversion-Safe job', () => {
  expect(JOBS.some(j => (j.name as string) === 'forwardRoyalty')).toBe(false);
  expect(JOBS.some(j => (j.name as string) === 'royaltyFlush')).toBe(true);
  expect(JOBS.some(j => (j.name as string) === 'royaltySweep')).toBe(true);
});

import { plan, emptyMemory } from '../src/plan';
import { box, v2, world, options, addr } from './support/v2';
it.each(['bonding', 'graduated'] as const)('maintains royalties in %s without claiming payee money', phase => {
  const w = world(box({ graduated: phase === 'graduated',
    v2: { ...v2, q: addr(9), royalty: { address: addr(8), eth: 1n, wrapped: 0n, price: 2n } } }));
  const candidates = plan(w, emptyMemory(), options()).candidates.filter(c => c.job.startsWith('royalty'));
  expect(candidates.map(c => [c.to, c.fn, c.args])).toEqual([[addr(8), 'flush', []], [addr(8), 'sweep', [addr(9)]]]);
  const mem = { ...emptyMemory(), attempts: Object.fromEntries(candidates.map(c => [c.key, { block: w.block.number, next: w.block.number + 1n }])) };
  expect(plan(w, mem, options()).candidates.filter(c => c.job.startsWith('royalty'))).toEqual([]);
});
// R53-E: failure and every claim sweep the inbox's P themselves; flush and sweep stay public calls.
it.each(['failed', 'lastClaim'] as const)('plans no inbox upkeep for a failed box (%s)', phase => {
  const w = world(box({ graduated: false, failed: true,
    v2: { ...v2, q: addr(9), tLeft: phase === 'lastClaim' ? 0n : 1n,
      royalty: { address: addr(8), eth: 1n, wrapped: 0n, price: 2n } } }));
  expect(plan(w, emptyMemory(), options()).candidates.filter(c => c.job.startsWith('royalty'))).toEqual([]);
});
it('does not manufacture royalty jobs for empty or unreadable custody', () => {
  for (const royalty of [undefined, { address: addr(8), eth: 0n, wrapped: 0n, price: 0n }]) {
    expect(plan(world(box({ v2: { ...v2, royalty } })), emptyMemory(), options()).candidates.filter(c => c.job.startsWith('royalty'))).toEqual([]);
  }
});

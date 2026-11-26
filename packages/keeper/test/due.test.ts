import { describe, expect, it } from 'vitest';
import { afterRun, emptyMemory, plan, type PlanOptions } from '../src/plan';
import { seededRng } from '../src/rng';
import type { BoxState, World } from '../src/world';

const KEEPER = '0x000000000000000000000000000000000000beef';
const T0 = 1_791_302_400n; // 30 s into an hour slot
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as const;
const opts: PlanOptions = { keeper: KEEPER, payoutMinWei: 10n ** 15n, rng: seededRng(3) };

const box = (over: Partial<BoxState> = {}): BoxState => ({
  id: 0n, version: 1, coordinator: addr(1), hook: addr(2), receiver: addr(3), priceSource: addr(5),
  graduated: true, failed: false, curveClosed: true, gateOpen: true, openAt: T0 - 86_400n, deadline: T0 + 86_400n,
  spotTick: 1_000, sampleTick: 1_000, checkpointTime: T0 - 10n, fitOwed: 0n, platformOwed: 0n,
  qPerEthX18: 10n ** 18n, ...over,
});

const world = (over: Partial<World> = {}): World => ({
  block: { number: 100n, timestamp: T0, baseFeePerGas: 10n ** 9n }, fitGraduated: true, boxes: [], ...over,
});

/**
 * Box 0 jobs after its deepen and collect already ran in the current slot.
 */
function jobs(w: World) {
  let mem = emptyMemory();
  const before = { ...w, block: { ...w.block, number: w.block.number - 1n } };
  for (const b of w.boxes) {
    mem = afterRun(mem, { job: 'deepen', key: `deepen:${b.id}`, to: b.hook, fn: 'deepen', args: [], boxId: b.id }, true, before);
    mem = afterRun(mem, { job: 'collect', key: `collect:${b.id}`, to: b.receiver, fn: 'collect', args: [], boxId: b.id }, true, before);
  }
  return plan(w, mem, opts).candidates.map((c) => `${c.job}@${c.to}`);
}

describe('Box 0 job due-check (tickets § 2, M1-51)', () => {


  it('graduate() once the curve closed, and nothing a graduated box does before it', () => {
    expect(jobs(world({ boxes: [box({ graduated: false })] }))).toEqual([`graduate@${addr(1)}`]);
  });

  it('payFit() and payPlatform() on a receiver that owes; FIT\'s only once FIT graduated', () => {
    const owed = box({ fitOwed: 10n ** 16n, platformOwed: 10n ** 16n });
    expect(jobs(world({ boxes: [owed] }))).toEqual(expect.arrayContaining([`receiverPayFit@${addr(3)}`, `receiverPayPlatform@${addr(3)}`]));
    expect(jobs(world({ boxes: [owed], fitGraduated: false }))).toContain(`receiverPayFit@${addr(3)}`);
    expect(jobs(world({ boxes: [box({ fitOwed: 10n ** 14n })] }))).not.toContain(`receiverPayFit@${addr(3)}`);
  });

  it('a poke while spot is 1% off its sample, else a top-up once the sample is old', () => {
    expect(jobs(world({ boxes: [box({ spotTick: 1_101 })] }))).toContain(`poke@${addr(5)}`);
    // Review round 1, L4: timed from the newest checkpoint, which only a poke 515 s after it moves.
    expect(jobs(world({ boxes: [box({ checkpointTime: T0 - 515n })] }))).toContain(`executorTopUp@${addr(5)}`);
    expect(jobs(world({ boxes: [box()] }))).toEqual([]);
    expect(jobs(world({ boxes: [box({ graduated: false, curveClosed: false, spotTick: 5_000 })] }))).toEqual([]);
  });

});

describe('CQ11-E replacement v2 scheduling', () => {
  it('uses fail at exactly seven days from closedAt, before the original deadline', () => {
    const b = v2Box({ graduated: false, v2: { ...v2, closedAt: time - 604800n } });
    const jobsAt = (t: bigint) => plan(v2World(b, 100n, t), emptyMemory(), options()).candidates.map((c) => c.job);
    expect(jobsAt(time - 1n)).toContain('graduate');
    expect(jobsAt(time - 1n)).not.toContain('fail');
    expect(jobsAt(time)).toContain('fail');
    expect(jobsAt(time)).not.toContain('graduate');
  });
  it('distinguishes the deadline, unopened 14-day gate, graduation and failure', () => {
    const jobsFor = (b: BoxState) => plan(v2World(b), emptyMemory(), options()).candidates.map((c) => c.job);
    expect(jobsFor(v2Box({ graduated: false, curveClosed: false, deadline: time }))).toContain('fail');
    expect(jobsFor(v2Box({ graduated: false, curveClosed: false, deadline: time + 1n }))).not.toContain('fail');
    expect(jobsFor(v2Box({ graduated: false, curveClosed: false, gateOpen: false, openAt: time - 1209600n }))).toContain('failClosed');
    expect(jobsFor(v2Box({ graduated: false, curveClosed: false, gateOpen: false, openAt: time - 1209599n }))).not.toContain('failClosed');
    for (const b of [v2Box(), v2Box({ graduated: false, failed: true })]) {
      expect(jobsFor(b).filter((j) => ['fail', 'failClosed', 'graduate'].includes(j))).toEqual([]);
    }
  });
  it('keeps fixed-Safe payments, router sweep and pending burns after failure without collect or income-inbox upkeep', () => {
    const b = v2Box({ graduated: false, failed: true, fitOwed: 1n, platformOwed: 1n,
      v2: { ...v2, pot: 100n, tLeft: 0n, tBurnPending: 9n, royalty: { address: addr(8), eth: 4n, wrapped: 0n, price: 0n } } });
    const cs = plan(v2World(b), emptyMemory(), options()).candidates;
    expect(cs.map((c) => c.fn)).toEqual(['payFit', 'payPlatform', 'burnPending', 'sweep']);
    expect(cs.some((c) => ['close', 'claim', 'claimFor', 'claimCreator', 'enterFailure'].includes(c.fn))).toBe(false);
    const before = plan(v2World({ ...b, failed: false, curveClosed: false }), emptyMemory(), options()).candidates;
    expect(before.map((c) => c.fn)).toEqual(expect.arrayContaining(['collect', 'flush']));
    const live = plan(v2World({ ...b, failed: false, graduated: true }), emptyMemory(), options()).candidates;
    expect(live.find((c) => c.fn === 'collect')?.args).toEqual([options().keeper]);
    expect(live.find((c) => c.fn === 'flush')?.args).toEqual([]);
  });
  it('alternates available steps each block and respects the shared on-chain mark', () => {
    const o = options();
    const w = v2World();
    const steps = (cs: ReturnType<typeof plan>['candidates']) => cs.filter((c) => ['buyBack', 'deepen'].includes(c.job));
    const first = steps(plan(w, emptyMemory(), o).candidates);
    expect(first).toHaveLength(1);
    expect(first[0]?.job).toBe('buyBack');
    const candidate = first[0];
    if (!candidate) throw new Error('protocol step missing');
    const mem = afterRun(emptyMemory(), candidate, true, w);
    expect(steps(plan(w, mem, o).candidates)).toEqual([]);
    expect(steps(plan(v2World(v2Box(), 101n), mem, o).candidates)[0]?.job).toBe('deepen');
    expect(steps(plan(v2World(v2Box({ v2: { ...v2, lastProtocolBlock: 100n } })), emptyMemory(), o).candidates)).toEqual([]);
    expect(steps(plan(v2World(v2Box({ v2: { ...v2, buyBackP: 0n } })), emptyMemory(), o).candidates)[0]?.job).toBe('deepen');
  });
});

import { box as v2Box, world as v2World, v2, time, options } from './support/v2';

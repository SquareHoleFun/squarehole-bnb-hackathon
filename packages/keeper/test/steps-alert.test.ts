import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { emptyMemory, plan, type Memory } from '../src/plan';
import { readPayInTV21 } from '../src/pay-in-t-v21';
import { decodeState, encodeState } from '../src/state';
import type { BoxState, V2State } from '../src/world';
import { addr, box, options, v2, world } from './support/v2';

// SH-KEEPER-V2-STEPS, STEPS-B: the buy-back backlog alert names only a budget one buyBack call can buy from. The receiver
// buys from one bucket per call (the buy-back P or one of three reward kinds) and returns BelowMinimum when every bucket
// is under the hook's STEP_MIN_Q (BoxReceiverV2.sol buyBack). Sepolia read at block 12,032,111: box 0 (tNVDA) and box 2
// (tUSDC) hold buy-back P under their minimum, so the old alert fired on every tick for ever.
const LIVE = {
  box0: { stepMinQ: 118_850_099_096_677_802n, buyBackP: 95_322_646_963_321_138n },
  box2: { stepMinQ: 118_851n, buyBackP: 104_086n },
};
const state = (over: Partial<V2State>): V2State => ({ ...v2, ...over });
const run = (blocks: readonly bigint[], at: (block: bigint) => V2State, mem: Memory = emptyMemory(), o = options(),
  over: (block: bigint) => Partial<BoxState> = () => ({})) => {
  const out: { block: bigint; alerts: ReturnType<typeof plan>['alerts']; mem: Memory }[] = [];
  for (const block of blocks) {
    const p = plan(world(box({ v2: at(block), ...over(block) }), block), mem, o);
    mem = p.mem;
    out.push({ block, alerts: p.alerts, mem });
  }
  return out;
};
const range = (from: bigint, to: bigint) => Array.from({ length: Number(to - from + 1n) }, (_, i) => from + BigInt(i));
const hook = box().hook.toLowerCase();

describe('STEPS-B1: below-minimum leftovers are not a backlog', () => {
  it.each(Object.entries(LIVE))('%s: the live leftover never raises buyBackWaiting and sets no waiting mark', (_name, live) => {
    const ticks = run(range(100n, 1_000n), () => state(live), emptyMemory(), { ...options(), buyBackAlertBlocks: 300n });
    expect(ticks.flatMap(t => t.alerts)).toEqual([]);
    expect(ticks.at(-1)?.mem.buyBackSince).toEqual({});
  });

  it('raises the alert at exactly the step minimum, as before, with its age from the first buyable block', () => {
    const ticks = run(range(100n, 104n), () => state({ stepMinQ: 10n, buyBackP: 10n }));
    expect(ticks.slice(0, 4).flatMap(t => t.alerts)).toEqual([]);
    expect(ticks[4]?.alerts).toEqual([{ kind: 'buyBackWaiting', boxId: 0n, sinceBlock: 100n }]);
  });

  it('keeps the old positive-balance rule when the hook minimum is unknown (code not a recognized clone)', () => {
    const ticks = run(range(100n, 104n), () => state({ buyBackP: 1n }));
    expect(ticks[4]?.alerts).toEqual([{ kind: 'buyBackWaiting', boxId: 0n, sinceBlock: 100n }]);
  });
});

describe('STEPS-B2: each reward kind is compared with the step minimum on its own', () => {
  it.each([
    ['two kinds, each under the minimum, together above it', 0n, [6n, 6n, 0n], false],
    ['buy-back P and one kind, each under it', 9n, [9n, 0n, 0n], false],
    ['one kind at the minimum', 0n, [0n, 10n, 0n], true],
    ['the buy-back bucket at the minimum, kinds empty', 10n, [0n, 0n, 0n], true],
  ] as const)('%s', (_why, buyBackP, kinds, alerts) => {
    const v = state({ stepMinQ: 10n, buyBackP, rewardsPendingP: kinds[0] + kinds[1] + kinds[2], rewardsPendingByKind: kinds });
    const ticks = run(range(100n, 104n), () => v);
    expect(ticks[4]?.alerts.length).toBe(alerts ? 1 : 0);
  });

  it('falls back to the reward total when the per-kind view was not read', () => {
    const ticks = run(range(100n, 104n), () => state({ stepMinQ: 10n, buyBackP: 0n, rewardsPendingP: 10n }));
    expect(ticks[4]?.alerts).toEqual([{ kind: 'buyBackWaiting', boxId: 0n, sinceBlock: 100n }]);
  });
});

describe('STEPS-B3: the waiting mark restarts on a buy and clears below the minimum', () => {
  it('restarts the age when the budget falls, a buy having happened', () => {
    const ticks = run(range(100n, 109n), block => state({ stepMinQ: 10n, buyBackP: block < 105n ? 100n : 90n }));
    expect(ticks.map(t => t.alerts.map(a => a.sinceBlock))).toEqual([[], [], [], [], [100n], [], [], [], [], [105n]]);
    expect(ticks.at(-1)?.mem.buyBackSince).toEqual({ [hook]: 105n });
  });

  it('does not restart on inflow: a rising budget keeps its age', () => {
    const ticks = run(range(100n, 104n), block => state({ stepMinQ: 10n, buyBackP: 100n + block }));
    expect(ticks[4]?.alerts).toEqual([{ kind: 'buyBackWaiting', boxId: 0n, sinceBlock: 100n }]);
  });

  it('clears the mark below the minimum and starts a new one when the budget is buyable again', () => {
    const budget = (block: bigint) => block < 105n ? 100n : block === 105n ? 5n : 50n;
    const ticks = run(range(100n, 110n), block => state({ stepMinQ: 10n, buyBackP: budget(block) }));
    expect(ticks.map(t => t.alerts.map(a => a.sinceBlock))).toEqual([[], [], [], [], [100n], [], [], [], [], [], [106n]]);
    expect(ticks[5]?.mem.buyBackSince).toEqual({});
  });

  it('a reward buy restarts the age too', () => {
    const kinds = (block: bigint) => [block < 103n ? 30n : 20n, 0n, 0n] as const;
    const ticks = run(range(100n, 107n), block => state({ stepMinQ: 10n, buyBackP: 0n, rewardsPendingP: kinds(block)[0],
      rewardsPendingByKind: kinds(block) }));
    expect(ticks.map(t => t.alerts.map(a => a.sinceBlock))).toEqual([[], [], [], [], [], [], [], [103n]]);
  });
});

describe('STEPS-B6 (af1): no backlog before graduation', () => {
  it('an ungraduated box with a buyable budget never alerts; the age starts at graduation', async () => {
    // buyBack needs graduation (the plan proposes it only after; the receiver reverts NotGraduated before).
    const graduatedFrom = 110n;
    const ticks = run(range(100n, 116n), () => state({ stepMinQ: 10n, buyBackP: 50n }), emptyMemory(), options(),
      block => ({ graduated: block >= graduatedFrom }));
    expect(ticks.filter(t => t.block < graduatedFrom).flatMap(t => t.alerts)).toEqual([]);
    expect(ticks.find(t => t.block === graduatedFrom - 1n)?.mem.buyBackSince).toEqual({});
    expect(ticks.find(t => t.block === graduatedFrom)?.mem.buyBackSince).toEqual({ [hook]: graduatedFrom });
    expect(ticks.find(t => t.block === graduatedFrom + 4n)?.alerts).toEqual([{ kind: 'buyBackWaiting', boxId: 0n, sinceBlock: graduatedFrom }]);
  });
});

describe('STEPS-B4: the journal keeps the last budget; older journals still load', () => {
  it('round-trips the waiting mark and the last seen budget as exact decimals', () => {
    const [, second] = run([100n, 101n], () => state({ stepMinQ: 10n, buyBackP: 2n ** 70n }));
    if (!second) throw new Error('missing tick');
    const restored = decodeState(encodeState({ mem: second.mem }, 'id'), 'id');
    expect(restored.mem).toEqual(second.mem);
    expect(restored.mem?.buyBackBudget).toEqual({ [hook]: 2n ** 70n });
    // A fall seen across the restart restarts the age.
    const [after] = run([102n], () => state({ stepMinQ: 10n, buyBackP: 2n ** 70n - 1n }), restored.mem);
    expect(after?.mem.buyBackSince).toEqual({ [hook]: 102n });
  });

  it('loads a journal written before the last budget was kept, without restarting its age', () => {
    const old = JSON.stringify({ version: 1, identity: 'id', state: { mem: { cadence: {}, pokes: {}, attempts: {}, steps: {},
      buyBackSince: { [hook]: '100' } } } });
    const mem = decodeState(old, 'id').mem;
    if (!mem) throw new Error('missing memory');
    const ticks = run([104n], () => state({ stepMinQ: 10n, buyBackP: 50n }), mem);
    expect(ticks[0]?.alerts).toEqual([{ kind: 'buyBackWaiting', boxId: 0n, sinceBlock: 100n }]);
  });
});

describe('STEPS-B5: the per-kind reward view is read only while reward P waits', () => {
  const reader = (pending: bigint, kinds: readonly [bigint, bigint, bigint] | Error) => {
    const calls: string[] = [];
    const call = async <T>(_to: Address, _abi: readonly unknown[], fn: string): Promise<T> => {
      calls.push(fn);
      if (fn === 'rewardsPendingP') return pending as T;
      if (fn === 'rewardBurnPendingT') return 0n as T;
      if (fn === 'rewardsPendingByKind') { if (kinds instanceof Error) throw kinds; return kinds as T; }
      throw new Error(`unexpected read ${fn}`);
    };
    const guard = async <T>(_source: string, read: () => Promise<T>, fallback: () => T) => { try { return await read(); } catch { return fallback(); } };
    return { calls, read: () => readPayInTV21(addr(3), call, guard) };
  };

  it('adds no read for a receiver with no reward P waiting', async () => {
    const r = reader(0n, [0n, 0n, 0n]);
    expect(await r.read()).toEqual({ rewardsPendingP: 0n, rewardBurnPendingT: 0n });
    expect(r.calls.sort()).toEqual(['rewardBurnPendingT', 'rewardsPendingP']);
  });

  it('reads the three kinds when reward P waits, and keeps the total when that view fails', async () => {
    expect(await reader(12n, [6n, 6n, 0n]).read()).toEqual({ rewardsPendingP: 12n, rewardBurnPendingT: 0n, rewardsPendingByKind: [6n, 6n, 0n] });
    expect(await reader(12n, new Error('node error')).read()).toEqual({ rewardsPendingP: 12n, rewardBurnPendingT: 0n });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { afterRun, emptyMemory, plan } from '../src/plan';
import { interpret } from '../src/chain';
import { runTick, type ChainPort, type KeeperState } from '../src/run';
import { decodeState, encodeState } from '../src/state';
import { openBudget } from '../src/decide';
import { loadConfig } from '../src/config';
import type { InboxCoin } from '../src/world';
import { addr, box, fundedIncome, options, quiet, time, v2, world } from './support/v2';

const coin = (over = {}): InboxCoin => ({ coin: addr(20), lot: 100n, balance: 99n,
  allowance: 0n, approved: 0n, oldestUnsoldAt: 0n, registered: false, ...over });
const withCoins = (coins: readonly InboxCoin[]) => box({ v2: { ...v2, buyBackP: 0n, depthBudget: 0n,
  q: addr(9), royalty: { address: addr(8), eth: 0n, wrapped: 99n, price: 0n, coins } } });
const observe = (w = world(withCoins([coin()])), mem = emptyMemory()) =>
  plan(w, mem, options()).candidates.filter(c => c.job === 'royaltyObserve');

describe('COW-2 below-lot observation', () => {
  it('observes a silent deposit, including WETH without ETH, and an unobserved sale', () => {
    const cs = observe(world(withCoins([coin(), coin({ coin: addr(21), oldestUnsoldAt: time - 10n, approved: 100n, allowance: 0n })])));
    expect(cs.map(c => [c.to, c.fn, c.args])).toEqual([[addr(8), 'observe', [addr(20)]], [addr(8), 'observe', [addr(21)]]]);
    expect(new Set(cs.map(c => c.key)).size).toBe(2);
    const first = cs[0]; if (!first) throw new Error('observe missing');
    expect(interpret(first, undefined, null)).toMatchObject({ ok: true, tipWei: null });
  });
  it('leaves zero, full lots, ineligible coins, observed dust and failed boxes alone', () => {
    for (const row of [coin({ balance: 0n }), coin({ balance: 100n }), coin({ lot: 0n }),
      coin({ oldestUnsoldAt: time, allowance: 100n, approved: 100n }), coin({ oldestUnsoldAt: time, allowance: 101n, approved: 100n })]) {
      expect(observe(world(withCoins([row])))).toEqual([]);
    }
    expect(observe(world({ ...withCoins([coin()]), failed: true }))).toEqual([]);
  });
  it('backs off attempted observations for an actual hour and preserves the guard across restart', () => {
    const w = world(withCoins([coin()])); const c = observe(w)[0];
    if (!c) throw new Error('observe missing');
    for (const sent of [false, true]) {
      const state = decodeState(encodeState({ mem: afterRun(emptyMemory(), c, sent, w) }, 'test'), 'test');
      expect(observe(world(w.boxes[0], 1000n, time + 3599n), state.mem)).toEqual([]);
      expect(observe(world(w.boxes[0], 1000n, time + 3600n), state.mem)).toHaveLength(1);
    }
  });
});

describe('LIM-4 bounded unblocking work', () => {
  function fixture(pOut = 0n) {
    let w = world(withCoins([coin({ balance: 200n })]));
    const send = vi.fn(async () => '0x01');
    const port: ChainPort = { read: async () => w, send,
      simulate: async c => c.job === 'royaltyRefresh' ? { ok: true, tipWei: null, estimate: 100_000n }
        : c.job === 'sellFees' ? { ...interpret(c, [0, 36n, pOut, 0n], null), estimate: 100_000n }
          : { ok: false, tipWei: null, estimate: 0n } };
    // One refresh at its 5M floor plus one zero-P press at its 3.5M floor (RC6RR2-KEEPER-1).
    const cfg = { ...options(), dryRun: false, priorityFeeWei: 1n,
      limits: { ...options().limits, unblockingGasPerBoxPerDay: 8_500_000n } };
    return { port, cfg, send, advance: (block: bigint, at = time, b = w.boxes[0] ?? withCoins([])) => { w = world(b, block, at); } };
  }
  it('defaults to 24 refreshes, observes, presses and collects at their published signed floors', () => {
    expect(options().limits.unblockingGasPerBoxPerDay).toBe(24n * (5_000_000n + 5_000_000n + 16_000_000n + 8_000_000n));
  });
  it('validates decimal gas configuration without narrowing large values', () => {
    const env = { SH_KEEPER_RPC_URL: 'http://fake.invalid', SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216' };
    for (const value of ['0', (2n ** 200n).toString()]) {
      expect(loadConfig({ ...env, SH_KEEPER_UNBLOCKING_GAS_PER_BOX_PER_DAY: value }).limits.unblockingGasPerBoxPerDay).toBe(BigInt(value));
    }
    for (const value of ['-1', '1.5', '1e8']) expect(() => loadConfig({ ...env, SH_KEEPER_UNBLOCKING_GAS_PER_BOX_PER_DAY: value })).toThrow();
  });
  it('admits 24 refreshes and 24 zero-P presses in one day at the default allowance', async () => {
    const f = fixture(); const midnight = time / 86400n * 86400n;
    for (const allowance of [options().limits.unblockingGasPerBoxPerDay, 24n * 8_500_000n]) {
      let state: KeeperState = {};
      const cfg = { ...f.cfg, limits: { ...f.cfg.limits, unblockingGasPerBoxPerDay: allowance } };
      for (let hour = 0n; hour < 24n; hour++) {
        f.advance(100n + hour * 300n, midnight + hour * 3600n);
        const out = await runTick(f.port, state, cfg, quiet);
        expect(out.report.sent.map(c => c.job)).toEqual(['royaltyRefresh', 'sellFees']);
        state = out.state;
      }
      // 24 refreshes at 5M and 24 zero-P presses at their own 3.5M floor (RC6RR2-KEEPER-1).
      expect(state.budget?.unblockingGas?.[addr(3)]).toBe(24n * 8_500_000n);
      f.advance(7001n, midnight + 23n * 3600n + 12n);
      if (allowance === 24n * 8_500_000n) expect((await runTick(f.port, state, cfg, quiet)).report.sent).toEqual([]);
    }
  });
  it('reserves padded estimates, not only floors, and no-work attempts consume no allowance', async () => {
    const f = fixture();
    f.port.simulate = async c => ({ ok: c.job === 'royaltyRefresh', estimate: 6_000_000n, tipWei: null });
    const out = await runTick(f.port, {}, f.cfg, quiet);
    expect(out.report.sent.map(c => c.job)).toEqual(['royaltyRefresh']);
    expect(out.state.budget.unblockingGas?.[addr(3)]).toBe(7_200_000n);
    const tight = await runTick(f.port, {}, { ...f.cfg, limits: { ...f.cfg.limits, unblockingGasPerBoxPerDay: 7_199_999n } }, quiet);
    expect(tight.report.sent).toEqual([]);
    expect(tight.state.budget.unblockingGas).toBeUndefined();
  });
  it('admits both jobs without income, charges full gas before signing, and persists exhaustion', async () => {
    const f = fixture(); const saved: KeeperState[] = [];
    f.send.mockImplementation(async () => {
      expect(saved.at(-1)?.budget?.unblockingGas?.[addr(3)]).toBeGreaterThan(0n);
      return '0x01';
    });
    const first = await runTick(f.port, {}, { ...f.cfg, checkpoint: async s => { saved.push(s); } }, quiet);
    expect(first.report.sent.map(c => c.job)).toEqual(['royaltyRefresh', 'sellFees']);
    expect(first.state.budget.unblockingGas).toEqual({ [addr(3)]: 8_500_000n });
    expect(first.state.incomeSpend).toEqual([]);
    expect(first.state.budget.totalWei).toBe(25_500_000n);
    f.advance(401n, time + 3600n);
    const restored = decodeState(encodeState(first.state, 'test'), 'test');
    const next = await runTick(f.port, restored, f.cfg, quiet);
    expect(next.report.sent).toEqual([]);
    expect(next.report.skipped.filter(c => c.why === 'box unblocking gas allowance spent')).toHaveLength(2);
    // A different box cannot spend this box's allowance, and tomorrow opens a fresh daily allowance.
    f.advance(402n, time + 3601n, { ...withCoins([coin({ balance: 200n })]), id: 1n, receiver: addr(33), hook: addr(32) });
    expect((await runTick(f.port, restored, f.cfg, quiet)).report.sent).toHaveLength(2);
    f.advance(8000n, time + 86400n, withCoins([coin({ balance: 200n })]));
    expect((await runTick(f.port, restored, f.cfg, quiet)).report.sent).toHaveLength(2);
  });
  it('charges ambiguous sends, cannot replenish by a backward clock, and can be disabled', async () => {
    const f = fixture(); f.send.mockRejectedValue(new Error('ambiguous'));
    const out = await runTick(f.port, {}, f.cfg, quiet);
    expect(out.state.budget.unblockingGas?.[addr(3)]).toBe(8_500_000n);
    expect(openBudget(out.state.budget, 99n, time - 1n).unblockingGas).toEqual(out.state.budget.unblockingGas);
    expect((await runTick(f.port, {}, { ...f.cfg, limits: { ...f.cfg.limits, unblockingGasPerBoxPerDay: 0n } }, quiet)).report.sent).toEqual([]);
  });
  it('keeps positive-P sales under F111 and all unblocking sends outside the recovery reserve', async () => {
    const f = fixture(1n);
    expect((await runTick(f.port, {}, f.cfg, quiet)).report.skipped).toContainEqual(expect.objectContaining({ job: 'sellFees', why: 'income unavailable' }));
    for (const overrides of [{ totalWeiPerDay: f.cfg.limits.reserveWeiPerDay }, { oursWeiPerDay: f.cfg.limits.reserveWeiPerDay }]) {
      const out = await runTick(f.port, {}, { ...f.cfg, limits: { ...f.cfg.limits, ...overrides } }, quiet);
      expect(out.report.sent).toEqual([]);
    }
  });
});

it('LIM-1(b): positive-P pages drain on subsequent rotation turns, one protocol step per block', async () => {
  let w = world(); let state: KeeperState = {}; const sends: [bigint, string][] = [];
  const port: ChainPort = { read: async () => w, readIncome: async () => fundedIncome(w),
    simulate: async c => ['sellFees', 'buyBack', 'deepen'].includes(c.job)
      ? { ...interpret(c, [0, 100n, 50n, 0n], null), estimate: 100_000n } : { ok: false, tipWei: null, estimate: 0n },
    send: async c => { sends.push([w.block.number, c.job]); return '0x01'; } };
  for (let block = 100n; block < 109n; block++) {
    w = world(box(), block, time + (block - 100n) * 12n);
    state = (await runTick(port, state, { ...options(), dryRun: false, priorityFeeWei: 1n }, quiet)).state;
    state = (await runTick(port, state, { ...options(), dryRun: false, priorityFeeWei: 1n }, quiet)).state;
  }
  expect(sends).toEqual(Array.from({ length: 9 }, (_, i) => [100n + BigInt(i), ['buyBack', 'deepen', 'sellFees'][i % 3]]));
});

it('LIM-1(b): an ambiguous sale send reserves the block slot before another step can send', async () => {
  const w = world();
  const send = vi.fn(async () => { throw new Error('accepted then timed out'); });
  const port: ChainPort = { read: async () => w, readIncome: async () => fundedIncome(w), send,
    simulate: async c => ['sellFees', 'buyBack'].includes(c.job)
      ? { ...interpret(c, [0, 100n, 50n, 0n], null), estimate: 100_000n } : { ok: false, tipWei: null, estimate: 0n } };
  const state = { mem: { ...emptyMemory(), steps: { [addr(2)]: { job: 'deepen' as const, block: 99n, sent: true } } } };
  const out = await runTick(port, state, { ...options(), dryRun: false, priorityFeeWei: 1n }, quiet);
  expect(send).toHaveBeenCalledTimes(1);
  expect(out.report.skipped).toContainEqual(expect.objectContaining({ job: 'buyBack', why: 'slot taken' }));
});

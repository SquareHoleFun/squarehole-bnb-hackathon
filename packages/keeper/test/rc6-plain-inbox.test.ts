import { describe, expect, it } from 'vitest';
import { interpret } from '../src/chain';
import { JOBS } from '../src/jobs';
import { afterRun, emptyMemory, INBOX_REFRESH_BLOCKS, plan, SELL_FEES_FALLBACK_BLOCKS } from '../src/plan';
import { runTick, type ChainPort, type KeeperState } from '../src/run';
import type { Candidate } from '../src/types';
import type { InboxCoin } from '../src/world';
import { addr, box, fundedIncome, options, quiet, time, v2, world } from './support/v2';

/** SH-V21-RC6-INT part 2: the plain hook's sellFees fallback (F137) and the income inbox's CoW order refresh. */
const steps = (cs: readonly Candidate[]) => cs.filter(c => ['buyBack', 'deepen', 'shopFees', 'sellFees'].includes(c.job));
const noBudget = { ...v2, buyBackP: 0n, depthBudget: 0n };

describe('F137 sellFees fallback', () => {
  it('presses the hook with no arguments after graduation, in the shared pool step', () => {
    const cs = plan(world(box({ v2: noBudget })), emptyMemory(), options()).candidates;
    expect(steps(cs).map(c => [c.job, c.to, c.fn, c.args, c.retryAfterBlocks])).toEqual([['sellFees', addr(2), 'sellFees', [], SELL_FEES_FALLBACK_BLOCKS]]);
    expect(JOBS.find(j => j.name === 'sellFees')).toMatchObject({ tip: 'sellFees', reserved: false, privately: false });
  });
  it('never presses before graduation, after failure or when the hook took this block', () => {
    for (const b of [box({ graduated: false, curveClosed: false, v2: noBudget }), box({ graduated: false, failed: true, v2: noBudget }),
      box({ v2: { ...noBudget, lastProtocolBlock: 100n } })]) {
      expect(plan(world(b), emptyMemory(), options()).candidates.some(c => c.job === 'sellFees')).toBe(false);
    }
  });
  it('waits an hour after idle attempts and takes turns with the other steps', () => {
    const w = world(box({ v2: noBudget }));
    const [first] = steps(plan(w, emptyMemory(), options()).candidates);
    if (!first) throw new Error('sellFees missing');
    {
      const mem = afterRun(emptyMemory(), first, false, w);
      expect(mem.attempts[first.key]?.next).toBe(100n + SELL_FEES_FALLBACK_BLOCKS);
      expect(steps(plan(world(box({ v2: noBudget }), 101n), mem, options()).candidates)).toEqual([]);
      expect(steps(plan(world(box({ v2: noBudget }), 100n + SELL_FEES_FALLBACK_BLOCKS), mem, options()).candidates).map(c => c.job)).toEqual(['sellFees']);
    }
    // With budgets, in rotation: buyBack, deepen, then the due fallback with buyBack behind it for the same slot.
    let mem = emptyMemory(); const seen: string[][] = [];
    for (let block = 100n; block < 104n; block++) {
      const ws = world(box(), block);
      const picked = steps(plan(ws, mem, options()).candidates);
      seen.push(picked.map(c => c.job));
      // The first proposal is attempted; a fallback that sold nothing leaves the next one to send.
      for (const c of picked) mem = afterRun(mem, c, c.job !== 'sellFees', ws);
    }
    expect(seen).toEqual([['buyBack'], ['deepen'], ['sellFees', 'buyBack'], ['deepen']]);
  });
  it('counts every press that consumes waiting T, a zero-P dust page included; the tip is valued for native P only', () => {
    const [c] = steps(plan(world(box({ v2: noBudget })), emptyMemory(), options()).candidates);
    if (!c) throw new Error('sellFees missing');
    expect(interpret(c, [0, 10n, 5n, 1n], 10n ** 18n)).toEqual({ ok: true, tipWei: 1n, paidTipRaw: 1n, estimate: 0n });
    expect(interpret(c, [0, 10n, 5n, 1n], null)).toEqual({ ok: true, tipWei: null, paidTipRaw: 1n, estimate: 0n });
    // Release review (RC6-MONEY-1, RR-HOOKPOOL-1, LIM-1): the hook's own result for a four-source page of raw-wei seller
    // sources (DustHead.t.sol: skip None, tIn 36, pOut 0, tip 0) is work. It pays no tip, so no outside presser sends it.
    expect(interpret(c, [0, 36n, 0n, 0n], 10n ** 18n)).toEqual({ ok: true, tipWei: 0n, paidTipRaw: 0n, estimate: 0n, zeroOutput: true });
    expect(interpret(c, [0, 10n, 0n, 0n], null)).toEqual({ ok: true, tipWei: null, paidTipRaw: 0n, estimate: 0n, zeroOutput: true });
    for (const result of [[1, 0n, 0n, 0n], [2, 0n, 0n, 0n], [0, 0n, 0n, 0n]]) expect(interpret(c, result, 10n ** 18n).ok).toBe(false);
  });
  it('is due again after any sent conversion; a press that found nothing waits its hour', () => {
    const w = world(box({ v2: noBudget }));
    const [c] = steps(plan(w, emptyMemory(), options()).candidates);
    if (!c) throw new Error('sellFees missing');
    const drained = afterRun(emptyMemory(), c, true, w);
    expect(drained.attempts[c.key]?.next).toBe(101n);
    expect(steps(plan(world(box({ v2: noBudget }), 101n), drained, options()).candidates).map(x => x.job)).toEqual(['sellFees']);
    // A no-work or refused attempt never shortens the wait.
    expect(afterRun(emptyMemory(), c, false, w).attempts[c.key]?.next).toBe(100n + SELL_FEES_FALLBACK_BLOCKS);
  });
});

/**
 * Release review (RC6-MONEY-1, RR-HOOKPOOL-1, LIM-1): a griefer's raw-wei sales, each closed by a public collect, put
 * seller sources at the FIFO head. Since RC6-RR-FEEPATH a press walks at most 32 sources (`BoxHookV2._saleInput`) and
 * stops once the page's T is worth the step minimum (SH-RC7-HOOK-PAGE removes the four-valued-source stop).
 * A page of 32 raw-wei sources can still sell for zero P with no tip. The keeper must
 * still press such pages, on consecutive turns, or every later conversion waits. The chain here is a model of the hook's
 * FIFO at a spot of 1,000 T per P; the contract side is pinned in `test/box-v2/rc6/DustHeadKeeper.t.sol`.
 */
describe('a dust page at the head of the sale-fee FIFO', () => {
  interface Source { readonly t: bigint; readonly dust: boolean }
  /** The model's `STEP_MIN_Q`, in P at the model's spot. */
  const STEP_MIN = 10n ** 15n;
  function fifo(sources: readonly Source[]) {
    let queue = [...sources];
    const page = (): readonly Source[] => {
      const out: Source[] = []; let queued = 0n;
      for (const s of queue.slice(0, 32)) {
        out.push(s); queued += s.t;
        if (queued / 1_000n >= STEP_MIN) break;
      }
      return out;
    };
    const result = (): readonly [number, bigint, bigint, bigint] => {
      if (queue.length === 0) return [2, 0n, 0n, 0n];
      const tIn = page().reduce((sum, s) => sum + s.t, 0n);
      const pOut = page().filter(s => !s.dust).reduce((sum, s) => sum + s.t / 1_000n, 0n);
      return [0, tIn, pOut, pOut / 20n];
    };
    return { result, press: () => { queue = queue.slice(page().length); }, left: () => queue.length };
  }
  async function run(sources: readonly Source[], blocks: bigint, v = noBudget) {
    const model = fifo(sources);
    let w = world(box({ v2: v }));
    const sent: { block: bigint; pOut: bigint }[] = [];
    const port: ChainPort = {
      read: async () => w,
      readIncome: async () => fundedIncome(w),
      simulate: async c => c.job === 'sellFees' ? { ...interpret(c, model.result(), 10n ** 18n), estimate: 400_000n }
        : { ok: false, tipWei: null, estimate: 0n },
      send: async c => {
        if (c.job === 'sellFees') { sent.push({ block: w.block.number, pOut: model.result()[2] }); model.press(); }
        return `0x${'ab'.repeat(32)}`;
      },
    };
    let state: KeeperState = {};
    for (let block = 100n; block < 100n + blocks; block++) {
      w = world(box({ v2: v }), block, time + (block - 100n) * 12n);
      state = (await runTick(port, state, { ...options(), dryRun: false, priorityFeeWei: 1n }, quiet)).state;
    }
    return { sent, left: model.left() };
  }
  const dust = (n: number): Source[] => Array.from({ length: n }, () => ({ t: 4n, dust: true }));
  it('sells sixteen sources worth a few raw P and the real source behind them in one press', async () => {
    const small = Array.from({ length: 16 }, () => ({ t: 8_000n, dust: false }));
    const r = await run([...small, { t: 10n ** 21n, dust: false }], 1n);
    expect(r.sent).toEqual([{ block: 100n, pOut: 10n ** 18n + 128n }]);
    expect(r.left).toBe(0);
  });
  it('sells nine dust sources and the real source behind them in one ordinary press', async () => {
    const r = await run([...dust(9), { t: 10n ** 21n, dust: false }], 400n);
    expect(r.sent).toEqual([{ block: 100n, pOut: 10n ** 18n }]);
    expect(r.left).toBe(0);
  });
  it('clears seventy dust sources 32 a press on consecutive turns, then sells the real source and backs off only after finding no work', async () => {
    const r = await run([...dust(70), { t: 10n ** 21n, dust: false }], 420n);
    expect(r.sent).toEqual([{ block: 100n, pOut: 0n }, { block: 101n, pOut: 0n }, { block: 102n, pOut: 10n ** 18n }]);
    expect(r.left).toBe(0);
  });
  it('takes turns with buyBack and deepen for the pool step while it drains', async () => {
    const r = await run([...dust(70), { t: 10n ** 21n, dust: false }], 20n, v2);
    expect(r.sent.map(s => s.block)).toEqual([102n, 105n, 108n]);
    expect(r.sent.map(s => s.pOut)).toEqual([0n, 0n, 10n ** 18n]);
  });
});

describe('RC6 income inbox refresh', () => {
  const coin = (over: Partial<InboxCoin> = {}): InboxCoin => ({ coin: addr(0xa0), lot: 100n, balance: 250n, allowance: 0n, approved: 0n, oldestUnsoldAt: 0n, registered: false, ...over });
  const withCoins = (coins: readonly InboxCoin[], over = {}) => box({ v2: { ...v2, q: addr(9), royalty: { address: addr(8), eth: 0n, wrapped: 0n, price: 0n, coins } }, ...over });
  const refreshes = (b = withCoins([coin()]), mem = emptyMemory()) => plan(world(b), mem, options()).candidates.filter(c => c.job === 'royaltyRefresh');
  it('registers or raises the approval of a coin with whole lots waiting, one call per coin', () => {
    expect(refreshes().map(c => [c.to, c.fn, c.args, c.retryAfterBlocks])).toEqual([[addr(8), 'refreshOrder', [addr(0xa0)], INBOX_REFRESH_BLOCKS]]);
    expect(refreshes(withCoins([coin({ registered: true, allowance: 100n })]))).toHaveLength(1);
    const two = refreshes(withCoins([coin(), coin({ coin: addr(0xa1) })]));
    expect(two.map(c => c.args[0])).toEqual([addr(0xa0), addr(0xa1)]);
    expect(new Set(two.map(c => c.key)).size).toBe(2);
  });
  it('leaves dust, an approval already covering its whole lots and the hourly cap alone', () => {
    for (const c of [coin({ balance: 99n }), coin({ registered: true, allowance: 200n }), coin({ lot: 0n }),
      coin({ registered: true, balance: 100n * 25n, allowance: 100n * 20n })]) expect(refreshes(withCoins([c]))).toEqual([]);
  });
  it('plans nothing for a failed box (R53-E) and waits for the next clock hour after any attempt', () => {
    expect(refreshes(withCoins([coin()], { graduated: false, failed: true }))).toEqual([]);
    const [first] = refreshes();
    if (!first) throw new Error('refresh missing');
    const mem = afterRun(emptyMemory(), first, false, world(withCoins([coin()])));
    // RC6RR2-COW-1 (b): the inbox's cap resets on the clock hour, not INBOX_REFRESH_BLOCKS after the last attempt.
    expect(mem.attempts[first.key]).toMatchObject({ next: 101n, nextAt: (time / 3600n + 1n) * 3600n });
    expect(INBOX_REFRESH_BLOCKS).toBe(300n);
    expect(refreshes(withCoins([coin()]), mem)).toEqual([]);
    expect(interpret(first, undefined, null)).toMatchObject({ ok: true });
  });
  it('flushes only what flush can deliver: ETH to wrap, or WETH for a native price coin', () => {
    const flushFor = (q: `0x${string}`, eth: bigint, wrapped: bigint) => plan(world(box({ v2: { ...v2, q, royalty: { address: addr(8), eth, wrapped, price: 0n } } })),
      emptyMemory(), options()).candidates.filter(c => c.job === 'royaltyFlush').length;
    expect([flushFor(addr(9), 0n, 5n), flushFor(addr(9), 1n, 0n), flushFor(addr(0), 0n, 5n), flushFor(addr(0), 1n, 0n)]).toEqual([0, 1, 1, 1]);
  });
});

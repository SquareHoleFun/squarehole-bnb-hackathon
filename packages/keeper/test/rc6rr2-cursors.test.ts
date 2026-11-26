import { describe, expect, it } from 'vitest';
import { toHex, type Address, type Hex, type PublicClient } from 'viem';
import { ViemChain, interpret } from '../src/chain';
import { afterRun, emptyMemory, plan } from '../src/plan';
import { runTick, type ChainPort } from '../src/run';
import type { Candidate } from '../src/types';
import type { BoxState, World } from '../src/world';
import { addr, box, options, quiet, time, v2, world } from './support/v2';

// Second release review: RC6RR2-MONEY-1 (empty or small sources at the receiver's cursor freeze our keeper's collect
// window) and RC6RR2-HP-1 (presses outpace our collects, so closed sources pile up behind the cursor).
const sourced = (sources: { buyerLag: bigint; sellerRun: bigint }, over: Partial<NonNullable<BoxState['v2']>> = {}) =>
  box({ v2: { ...v2, buyBackP: 0n, depthBudget: 0n, sources, ...over } });
const candidate = (w: World, job: string) => plan(w, emptyMemory(), options()).candidates.find(c => c.job === job);
const collectOf = (sources: { buyerLag: bigint; sellerRun: bigint }) => {
  const c = candidate(world(sourced(sources)), 'collect'); if (!c) throw new Error('collect missing'); return c;
};
const window = (buyersP: bigint, sellersP = 0n) => ({ buyersP, sellersP, qToReserve: 0n, tip: 0n });

describe('RC6RR2-MONEY-1 and RC6RR2-HP-1: our keeper collects while closed sources wait behind the receiver\'s cursors', () => {
  it('marks a collect whose window cannot reach the newest closed sources', () => {
    expect(collectOf({ buyerLag: 2n, sellerRun: 0n }).cursorLag).toBe(true);
    expect(collectOf({ buyerLag: 0n, sellerRun: 3n }).cursorLag).toBe(true);
    for (const s of [{ buyerLag: 1n, sellerRun: 2n }, { buyerLag: 0n, sellerRun: 0n }]) expect(collectOf(s).cursorLag).toBeUndefined();
    expect(candidate(world(box()), 'collect')?.cursorLag).toBeUndefined();
  });
  it('sends such a collect below the batching floor as unblocking work: windows 0 and 3.2e15 at a 1e16 floor', () => {
    const lagging = { ...collectOf({ buyerLag: 2n, sellerRun: 0n }), minAmountRaw: 10n ** 16n } as Candidate;
    for (const w of [window(0n), window(19_999_999_999_998n, 3_194_983_119_048_293n)]) {
      expect(interpret(lagging, w, null)).toMatchObject({ ok: true, unblocking: true });
      expect(interpret({ ...lagging, cursorLag: undefined }, w, null).ok).toBe(false);
    }
    // A window at the floor is ordinary income work, whatever the cursors.
    expect(interpret(lagging, window(10n ** 16n), null)).toEqual({ ok: true, tipWei: null, paidTipRaw: 0n, estimate: 0n });
  });
  it('makes the next collect due on the next block after a lag collect, and after any press of a sourced box', () => {
    const w = world(sourced({ buyerLag: 3n, sellerRun: 0n }));
    const c = collectOf({ buyerLag: 3n, sellerRun: 0n });
    expect(afterRun(emptyMemory(), c, true, w).attempts[c.key]?.next).toBe(w.block.number + 1n);
    expect(afterRun(emptyMemory(), { ...c, cursorLag: undefined }, true, w).attempts[c.key]?.next).toBe(w.block.number + 2n);
    const press = candidate(w, 'sellFees'); if (!press) throw new Error('press missing');
    expect(press.sourced).toBe(true);
    const waiting = afterRun(emptyMemory(), { ...c, cursorLag: undefined }, false, w);
    expect(waiting.attempts[c.key]?.next).toBe(w.block.number + 2n);
    expect(afterRun(waiting, press, true, w).attempts[c.key]?.next).toBe(w.block.number + 1n);
    expect(afterRun(waiting, press, false, w).attempts[c.key]?.next).toBe(w.block.number + 2n);
    const plain = candidate(world(box()), 'sellFees');
    expect(plain?.sourced).toBeUndefined();
  });
  it('catches outside presses: a lag collect is planned within the retry wait of an earlier attempt, once a block', () => {
    const idle = world(sourced({ buyerLag: 0n, sellerRun: 0n }));
    const c = collectOf({ buyerLag: 0n, sellerRun: 0n });
    const mem = afterRun(emptyMemory(), c, false, idle);
    expect(mem.attempts[c.key]?.next).toBe(idle.block.number + 2n);
    // Two outside presses later, in the next block, the lag is there: the earlier attempt's wait does not hold it back.
    const next = world(sourced({ buyerLag: 2n, sellerRun: 0n }), idle.block.number + 1n);
    expect(plan(next, mem, options()).candidates.filter(x => x.job === 'collect')).toHaveLength(1);
    // Not twice in one block, and an attempted lag collect is tried again on the next block.
    const lagging = collectOf({ buyerLag: 2n, sellerRun: 0n });
    const tried = afterRun(emptyMemory(), lagging, false, next);
    expect(plan(next, tried, options()).candidates.filter(x => x.job === 'collect')).toHaveLength(0);
    expect(tried.attempts[lagging.key]?.next).toBe(next.block.number + 1n);
    expect(candidate(world(sourced({ buyerLag: 1n, sellerRun: 0n }), idle.block.number + 1n), 'collect')).toBeDefined();
    expect(plan(world(sourced({ buyerLag: 1n, sellerRun: 0n }), idle.block.number + 1n), mem, options()).candidates.filter(x => x.job === 'collect')).toHaveLength(0);
  });
  it('admits a lag collect in a box with no income under the unblocking allowance', async () => {
    const w = world(sourced({ buyerLag: 2n, sellerRun: 0n }));
    const port: ChainPort = { read: async () => w, send: async () => `0x${'12'.repeat(32)}`,
      readIncome: async () => ({ at: w.block.timestamp, platformWei: 10n ** 30n, boxes: {}, mined: {} }),
      simulate: async c => c.job === 'collect' ? { ...interpret({ ...c, minAmountRaw: 10n ** 16n }, window(0n), null), estimate: 600_000n }
        : { ok: false, tipWei: null, estimate: 0n } };
    const out = await runTick(port, {}, { ...options(), dryRun: false, priorityFeeWei: 1n }, quiet);
    expect(out.report.sent.map(s => s.job)).toEqual(['collect']);
    expect(out.state.budget.unblockingWeiByBox?.[addr(3)]).toBe(5_000_000n * 3n);
    expect(out.state.incomeSpend).toEqual([]);
  });
});

describe('the sources reads: cursors from the receiver view, closed seller sources from the hook', () => {
  // The additive rc7 view is read once at the same snapshot as the seller sources.
  const registry = addr(10), coordinator = addr(1), hook = addr(2), receiver = addr(3);
  const code = (stepMinQ: bigint) => (`0x363d3d373d3d3d363d73${'ab'.repeat(20)}5af43d82803e903d91602b57fd5bf3`
    + '00'.repeat(195) + toHex(stepMinQ, { size: 16 }).slice(2)) as Hex;
  function chainWith(over: { current?: bigint; openSeller?: bigint; lastBuyer?: bigint; lastSeller?: bigint; viewError?: Error; failed?: boolean; closed?: (id: bigint) => boolean; hookCode?: Hex } = {}) {
    let cursorReads = 0;
    const client = {
      getChainId: async () => 11155111,
      request: async () => ({ number: '0x64', timestamp: toHex(time), baseFeePerGas: '0x1' }),
      getBlock: async () => ({ number: 100n, timestamp: time, baseFeePerGas: 1n }),
      getBalance: async () => 0n,
      getBytecode: async ({ address }: { address: Address }) => address === hook ? over.hookCode ?? code(5n * 10n ** 15n) : undefined,
      getStorageAt: async () => { throw new Error('cursor storage reads are forbidden'); },
      readContract: async ({ address, functionName: fn, args = [], blockNumber }: { address: Address; functionName: string; args?: unknown[]; blockNumber: bigint }) => {
        expect(blockNumber).toBe(99n);
        if (address === registry) {
          if (fn === 'boxCount') return 1n;
          if (fn === 'roleOf') return ({ 0: coordinator, 2: hook, 5: receiver, 6: addr(6) })[String(args[1]) as '0'] ?? addr(0);
        }
        if (fn === 'allocationCursors') {
          expect(++cursorReads).toBe(1);
          expect(address).toBe(receiver); expect(args).toEqual([]);
          if (over.viewError) throw over.viewError;
          const current = over.current ?? 9n;
          return [over.lastBuyer ?? 3n, over.lastSeller ?? 4n, current, over.openSeller ?? (current === 0n ? 0n : current + 1n)];
        }
        if (address === hook && fn === 'currentTradeBatch') throw new Error('use the receiver view');
        if (address === hook && fn === 'tradeBatch') return { tradeUnits: 0n, protocolUnits: 0n, netP: 0n, closed: (over.closed ?? (() => false))(args[0] as bigint) };
        if (fn === 'q') return addr(0);
        if (fn === 'poolId') return toHex(0n, { size: 32 });
        if (fn === 'poolManager') return addr(7);
        if (fn === 'graduated' || fn === 'gateOpen' || fn === 'closed' || fn === 'graduationSettled') return true;
        if (fn === 'failed') return over.failed ?? false;
        if (fn === 'roleAddress') return addr(0);
        if (fn === 'buyersChoice' || fn === 'sellersChoice') return 4;
        return 0n;
      },
    } as unknown as PublicClient;
    return new ViemChain({ ...options(), boxRegistry: registry }, client, addr(99), { public: null, private: null }, null, quiet);
  }
  const v2Of = async (c: ViemChain) => (await c.read()).boxes[0]?.v2;
  it('reads the buyer lag from the cursor and the closed seller run up to three', async () => {
    // Buyer cursor 3: sources 5 and 7 are closed and unallocated, 9 is open. Seller cursor 4: source 6 waits for T.
    expect((await v2Of(chainWith()))?.sources).toEqual({ buyerLag: 2n, sellerRun: 0n });
    // Open pair 13/14; sellers 6 to 12 converted: the walk counts three in a row and stops there.
    expect((await v2Of(chainWith({ current: 13n, closed: id => id % 2n === 0n })))?.sources).toEqual({ buyerLag: 4n, sellerRun: 3n });
    // Never past the open seller source, whatever a node answers for it.
    expect((await v2Of(chainWith({ current: 9n, closed: id => id % 2n === 0n })))?.sources).toEqual({ buyerLag: 2n, sellerRun: 2n });
    // A receiver that allocated nothing yet: its next buyer source is 1.
    expect((await v2Of(chainWith({ current: 5n, lastBuyer: 0n, lastSeller: 0n })))?.sources)
      .toEqual({ buyerLag: 2n, sellerRun: 0n });
  });
  it('leaves sources out for an unsourced box and for an unreadable or inconsistent cursor', async () => {
    expect((await v2Of(chainWith({ current: 0n })))?.sources).toBeUndefined();
    expect((await v2Of(chainWith({ failed: true, viewError: new Error('must not read failed cursors') })))?.sources).toBeUndefined();
    expect((await v2Of(chainWith({ closed: () => { throw new Error('seller read failed'); } })))?.sources).toBeUndefined();
    for (const over of [{ current: 8n }, { lastBuyer: 2n }, { lastSeller: 3n }, { lastSeller: 12n }, { openSeller: 12n }]) {
      expect((await v2Of(chainWith(over)))?.sources).toBeUndefined();
    }
    expect((await v2Of(chainWith({ viewError: new Error('rc6 has no view') })))?.sources).toBeUndefined();
    expect((await v2Of(chainWith({ lastBuyer: 11n })))?.sources).toBeUndefined();
  });
});

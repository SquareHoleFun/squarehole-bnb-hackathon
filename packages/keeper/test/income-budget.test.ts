import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, keccak256, type Hex } from 'viem';
import { shLimit } from '../../../vitest.timeouts.mjs';
import { hookV2Abi, receiverV2Abi } from '../src/abi';
import { INCOME_BOX_READS, INCOME_CACHE_LOGS, INCOME_CACHE_PAGES, INCOME_DISCOVERY_LOGS, IncomeCache, type IncomeReads } from '../src/income-cache';
import { readIncome } from '../src/income-read';
import { TETH, TETH_CODE, hash, incomeChain, pm, safe, type FloodKind } from './support/income-chain';
import { keeper } from './support/v2';

/** SH-247 (finding N4): the stated per-box budget of the income reading, and catch-up over rounds. */
const parity = vi.hoisted(() => ({ entries: undefined as Record<string, unknown> | undefined }));
vi.mock('../src/income-parity-manifest', async importOriginal => {
  const real = await importOriginal<typeof import('../src/income-parity-manifest')>();
  return { ...real, get ethParityManifest() { return parity.entries ?? real.ethParityManifest; } };
});
beforeEach(() => {
  parity.entries = { [`11155111:${TETH.toLowerCase()}`]: { chainId: '11155111', token: TETH, decimals: '18',
    codeHash: keccak256(TETH_CODE), weiPerCoin: '1000000000000000000' } };
});
afterEach(() => { parity.entries = undefined; });

/** Every box within its stated limits, and the tick within its shared bounds. */
function withinLimits(reads: IncomeReads | null, boxes: number) {
  if (!reads) throw new Error('no committed read');
  expect(reads.queries).toBeLessThanOrEqual(INCOME_CACHE_PAGES);
  expect(reads.rows).toBeLessThanOrEqual(INCOME_CACHE_LOGS);
  for (const r of Object.values(reads.boxes)) {
    // Max-min over the boxes with rows (review F2): the stated limit is the tick's discovery rows, never 10,000 / boxes.
    expect(r.rowsLimit).toBe(INCOME_DISCOVERY_LOGS);
    expect(boxes).toBeGreaterThan(0);
    expect(r.rows).toBeLessThanOrEqual(r.rowsLimit);
    expect(r.readsLimit).toBeLessThanOrEqual(INCOME_BOX_READS);
    expect(r.reads).toBeLessThanOrEqual(r.readsLimit);
    expect(r.receiptRows).toBeLessThanOrEqual(r.receiptRowsLimit);
  }
}
const counts = (reads: IncomeReads | null) => Object.fromEntries(Object.entries(reads?.boxes ?? {})
  .map(([box, r]) => [box, { rows: r.rows, reads: r.reads, receiptRows: r.receiptRows }]));

describe('P1: per-box queries, rows and receipt reads, with and without a flood', () => {
  it.each(['safe deposits', 'empty collections', 'zero transfers', 'zero claim burns'] as const satisfies readonly FloodKind[])(
    '%s: the same per-box counts as without it, all within the stated limits', async kind => {
      const quiet = incomeChain(), cache = new IncomeCache();
      await quiet.read(cache);
      withinLimits(cache.reads, quiet.boxes.length);
      const expected = counts(cache.reads);
      // Each paying box: its own nonzero events, one read per paying transaction, and only what proves them.
      expect(expected).toEqual({
        [quiet.a.receiver]: { rows: 2, reads: 1, receiptRows: 2 }, [quiet.b.receiver]: { rows: 1, reads: 1, receiptRows: 2 },
        [quiet.c.receiver]: { rows: 2, reads: 2, receiptRows: 6 }, [quiet.d.receiver]: { rows: 1, reads: 1, receiptRows: 3 },
        [quiet.failing.receiver]: { rows: 0, reads: 0, receiptRows: 0 }, [quiet.graduating.receiver]: { rows: 0, reads: 0, receiptRows: 0 },
      });
      expect(cache.reads?.discoveryQueries).toBe(3);
      const busy = incomeChain(), flooded = new IncomeCache();
      busy.flood(kind);
      await busy.read(flooded);
      withinLimits(flooded.reads, busy.boxes.length);
      expect(counts(flooded.reads)).toEqual(expected);
      expect(flooded.reads?.discoveryQueries).toBe(3);
      expect(flooded.reads?.rows).toBe(cache.reads?.rows);
      // The next round reads nothing new for any box.
      await busy.read(flooded);
      for (const r of Object.values(flooded.reads?.boxes ?? {})) expect([r.rows, r.reads, r.receiptRows]).toEqual([0, 0, 0]);
    }, shLimit(120_000));

  it('transaction reads behind tipped events share the box allowance and are read once', async () => {
    const f = incomeChain();
    // 100 positive buy-back tips this box paid to other callers: each needs its call read to know whose it is.
    for (let i = 0; i < 100; i++) f.logs.push({ address: f.a.receiver, eventName: 'BoughtBack', blockNumber: 70n, blockHash: hash(70n),
      transactionHash: hash(800_000n + BigInt(i)), logIndex: 0, removed: false, args: { pSpent: 10n, tBought: 1n, tBurned: 1n, tip: 1n } });
    // One of them is a direct buyBack(keeper) call: its tip counts once its call is read.
    // Answers name the transaction asked for (review F6), so they are kept.
    f.pub.getTransaction.mockImplementation(async ({ hash: h }: { hash: Hex }) => ({ hash: h, blockHash: hash(70n), blockNumber: 70n, ...(h === hash(800_099n)
      ? { to: f.a.receiver, input: encodeFunctionData({ abi: receiverV2Abi, functionName: 'buyBack', args: [keeper] }) }
      : { to: f.a.receiver, input: encodeFunctionData({ abi: hookV2Abi, functionName: 'deepen', args: [keeper] }) }) }) as never);
    const cache = new IncomeCache(), seen: bigint[] = [];
    for (let round = 0; round < 3; round++) {
      const income = await f.read(cache);
      withinLimits(cache.reads, f.boxes.length);
      seen.push(income.boxes[f.a.receiver]?.tipsWei ?? -1n);
      if (round === 0) expect(cache.reads?.boxes[f.a.receiver]?.reads).toBe(INCOME_BOX_READS);
    }
    // Round one reads 64 (its PlatformPaid receipt, 63 calls); round two the other 37 calls and finds ours.
    expect(seen).toEqual([7n * 10n ** 12n, 7n * 10n ** 12n + 1n, 7n * 10n ** 12n + 1n]);
    const asked = f.pub.getTransaction.mock.calls.map(([c]) => c.hash);
    expect(asked).toHaveLength(100);
    expect(new Set(asked).size).toBe(100);
    expect(cache.reads?.boxes[f.a.receiver]?.reads).toBe(0);
  }, shLimit(60_000));
});

describe('P1/P2: an answer refused for its size is read in pieces, never failing every box', () => {
  it('empty collections past a node\'s answer limit: every box as without them, pieces kept for the next round', async () => {
    const quiet = incomeChain(), quietCache = new IncomeCache(), expected = await quiet.read(quietCache);
    const f = incomeChain();
    f.flood('empty collections');
    f.state.cap = 4_000;
    const cache = new IncomeCache();
    // SH-247 fifth round (halving last): the two flooded boxes wait for their halving, which runs after every box's own
    // reads, and count INCOME_CAPACITY in this round; every other box counts as without the flood.
    const first = await f.read(cache);
    expect(first.valuationFailures).toEqual([f.a, f.c].map(x => ({ boxId: x.id, code: 'INCOME_CAPACITY' })));
    for (const x of f.boxes) if (x !== f.a && x !== f.c) expect(first.boxes[x.receiver]).toEqual(expected.boxes[x.receiver]);
    withinLimits(cache.reads, f.boxes.length);
    // The empty collections cost no box a row: each box is charged its own nonzero rows only, as on the quiet node.
    const rows = (reads: IncomeReads | null) => Object.fromEntries(Object.entries(reads?.boxes ?? {}).map(([box, r]) => [box, r.rows]));
    expect(rows(cache.reads)).toEqual(rows(quietCache.reads));
    // The receivers' page is asked in halves until each answer fits: more queries, no box's rows.
    const pieces = cache.reads?.discoveryQueries ?? 0;
    expect(pieces).toBeGreaterThan(quietCache.reads?.discoveryQueries ?? 0);
    expect(pieces).toBeLessThan(INCOME_CACHE_PAGES);
    // The next round at the same head reads every box from the kept pieces.
    expect(await f.read(cache)).toEqual(expected);
    // The pieces merged into one kept page per family: the next round asks only for the new head.
    f.pub.getLogs.mockClear();
    f.state.final += 1n;
    expect((await f.read(cache)).boxes).toEqual(expected.boxes);
    expect(f.pub.getLogs.mock.calls.length).toBe(3);
    expect(f.pub.getLogs.mock.calls.every(([c]) => c.fromBlock === 101n)).toBe(true);
  }, shLimit(120_000));
});

describe('P4: a head that advances on every read; catch-up is bounded per box per round', () => {
  it('a cold ETH box with 520 payments completes in nine rounds, each receipt read once, others unchanged', async () => {
    const f = incomeChain({ final: 2_000n });
    for (let i = 0; i < 520; i++) f.nativePaid(f.b, 1n, 600_000n + BigInt(i), 1_000n + BigInt(i));
    const cache = new IncomeCache();
    const first = await f.read(cache);
    const credit = (n: number) => 2n * 10n ** 15n + BigInt(Math.min(520, n));
    const heads: bigint[] = [], shares: bigint[] = [];
    for (let round = 1; round <= 10; round++) {
      const income = round === 1 ? first : await f.read(cache);
      heads.push(f.state.final);
      shares.push(income.boxes[f.b.receiver]?.shareWei ?? 0n);
      for (const x of [f.a, f.c, f.d]) expect(income.boxes[x.receiver]).toEqual(first.boxes[x.receiver]);
      withinLimits(cache.reads, f.boxes.length);
      expect(cache.reads?.boxes[f.b.receiver]?.reads).toBe(round === 1 ? 64 : round < 9 ? 64 : round === 9 ? 521 - 512 : 0);
      // Every round sees a new finalized head (30-second polls on a 12-second chain).
      f.state.final += 3n;
    }
    // The first round also reads the box's original payment, so 63 + 64 * 7 + 9 = 520 batch payments.
    expect(shares).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 9].map(n => credit(Math.min(520, n * 64 - 1))));
    expect(new Set(heads).size).toBe(heads.length);
    const read = f.pub.getTransactionReceipt.mock.calls.map(([c]) => c.hash);
    expect(read.length).toBe(new Set(read).size);
    expect(read.filter(h => BigInt(h) >= 600_000n)).toHaveLength(520);
  }, shLimit(120_000));
});

describe('P3: a box that waits never hands its proof to another box', () => {
  it('two ETH payments in one transaction keep the line\'s proof order when the first box waits', async () => {
    const f = incomeChain({ final: 2_000n });
    f.logs.splice(0);
    // Box b comes first in the line's order. In transaction T: Safe receipt, a's payment, Safe receipt, b's payment.
    const T = 777n, x = 10n ** 15n, base = { blockNumber: 1_500n, blockHash: hash(1_500n), transactionHash: hash(T), removed: false };
    const shared = () => f.logs.push({ ...base, address: safe, eventName: 'SafeReceived', logIndex: 0, args: { sender: pm, value: x } },
      { ...base, address: f.a.receiver, eventName: 'PlatformPaid', logIndex: 1, args: { safe, amount: x } },
      { ...base, address: safe, eventName: 'SafeReceived', logIndex: 2, args: { sender: pm, value: x } },
      { ...base, address: f.b.receiver, eventName: 'PlatformPaid', logIndex: 3, args: { safe, amount: x } });
    shared();
    const order = [f.b, f.a, f.c, f.d];
    const full = await readIncome(f.client, order, keeper, f.now(), 0n, []);
    // The line gives b the first Safe receipt; a's payment then has none before it.
    expect(full.boxes[f.b.receiver]?.shareWei).toBe(x);
    expect(full.boxes[f.a.receiver]?.shareWei).toBe(0n);
    // Now b has 64 earlier payments of its own (earlier blocks, so listed first): its allowance is spent before T,
    // so b waits on T this round.
    f.logs.splice(0);
    for (let i = 0; i < 64; i++) f.nativePaid(f.b, 1n, 610_000n + BigInt(i), 1_000n + BigInt(i));
    shared();
    const cache = new IncomeCache();
    const waiting = await readIncome(f.client, order, keeper, f.now(), 0n, [], cache);
    expect(cache.reads?.boxes[f.b.receiver]?.reads).toBe(INCOME_BOX_READS);
    expect(waiting.boxes[f.b.receiver]?.shareWei).toBe(64n);
    // a reads T itself, and still gets exactly what the line gives it.
    expect(waiting.boxes[f.a.receiver]?.shareWei).toBe(0n);
    const next = await readIncome(f.client, order, keeper, f.now(), 0n, [], cache);
    expect(next.boxes[f.b.receiver]?.shareWei).toBe(64n + x);
    expect(next.boxes[f.a.receiver]?.shareWei).toBe(0n);
  });
});

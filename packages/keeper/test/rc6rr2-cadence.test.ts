import { describe, expect, it } from 'vitest';
import { afterRun, emptyMemory, plan, type Memory } from '../src/plan';
import { runTick, type ChainPort } from '../src/run';
import { DEFAULT_UNBLOCKING_GAS_PER_BOX_PER_DAY } from '../src/income';
import { V2_GAS_FLOORS } from '../src/gas';
import type { InboxCoin } from '../src/world';
import { addr, box, options, quiet, time, v2, world } from './support/v2';

// Second release review, RC6RR2-COW-1: the inbox charges an unrecorded sale to the hour it is observed in, and our keeper
// recorded a sale only at its next refresh, 300 blocks after the last, in the next clock hour: 20 lots every other hour.
// RR2-LIM-3: the observe job ran under F111, so a royalty-only box with no recent platform income never got one.
const LOT = 50_000_000_000_000_000n;
const CAP = 20n * LOT;
const row = (over: Partial<InboxCoin> = {}): InboxCoin => ({ coin: addr(20), lot: LOT, balance: 2000n * LOT,
  allowance: 20n * LOT, approved: 20n * LOT, oldestUnsoldAt: time, registered: true, ...over });
const inboxBox = (coins: readonly InboxCoin[]) => box({ v2: { ...v2, buyBackP: 0n, depthBudget: 0n, q: addr(9),
  royalty: { address: addr(8), eth: 0n, wrapped: 0n, price: 0n, coins } } });
const jobs = (coins: readonly InboxCoin[], block: bigint, ts: bigint, mem = emptyMemory()) =>
  plan(world(inboxBox(coins), block, ts), mem, options()).candidates.filter(c => c.job.startsWith('royalty') && c.job !== 'royaltyFlush').map(c => c.job);
const hour = (time / 3600n + 1n) * 3600n;

describe('RC6RR2-COW-1 (a), (b): the sale is recorded in its hour and the refresh comes at the next hour\'s start', () => {
  it('observes an unrecorded sale of a coin above one lot, unless a refresh for it is planned in the same block', () => {
    const sold = [row({ balance: 1980n * LOT, allowance: 0n, approved: 20n * LOT })];
    const refreshed = afterRun(emptyMemory(), { job: 'royaltyRefresh', key: `royaltyRefresh:2:${addr(2)}:${addr(20)}`, to: addr(8), fn: 'refreshOrder',
      args: [addr(20)], version: 2, boxId: 0n, retryAfterBlocks: 300n }, true, world(inboxBox(sold), 1000n, hour + 120n));
    expect(jobs(sold, 1020n, hour + 360n, refreshed)).toEqual(['royaltyObserve']);
    // Without a refresh guard both would be due: the refresh observes first, so the observe is left out.
    expect(jobs(sold, 1020n, hour + 360n)).toEqual(['royaltyRefresh']);
    // A recorded approval with no sale, or dust, plans nothing new.
    expect(jobs([row()], 1020n, hour + 360n, refreshed)).toEqual([]);
  });
  it('times a sent or attempted refresh and observe by the clock hour, the period of the inbox\'s 20-lot cap', () => {
    for (const job of ['royaltyRefresh', 'royaltyObserve'] as const) {
      const c = { job, key: `${job}:2:${addr(2)}:${addr(20)}`, to: addr(8), fn: job === 'royaltyRefresh' ? 'refreshOrder' : 'observe',
        args: [addr(20)], version: 2 as const, boxId: 0n, retryAfterBlocks: 300n };
      for (const sent of [true, false]) {
        const mem = afterRun(emptyMemory(), c, sent, world(inboxBox([row()]), 1000n, hour + 120n));
        expect(mem.attempts[c.key]).toEqual({ block: 1000n, next: 1001n, nextAt: hour + 3600n });
      }
    }
  });
});

// The verifier's day-long model: the real plan()/afterRun() every 12 s block, a TS copy of the inbox's _observe /
// refreshOrder / cowOrder arithmetic (BoxRoyaltyRouterV2.sol:95-131, 168-186), and the poster (every 600 s; one post
// per UID; a check that finds no order is repeated once on the next cycle before the target waits for the epoch:
// packages/cow-poster/src/poster.ts, RC6RR2-COW-1 (c)).
interface Inbox { hour: bigint; spent: bigint; approved: bigint; allowance: bigint; balance: bigint; registered: boolean }
const observeInbox = (s: Inbox, ts: bigint) => {
  const sold = s.approved > s.allowance ? s.approved - s.allowance : 0n;
  if (s.hour !== ts / 3600n) { s.hour = ts / 3600n; s.spent = 0n; }
  s.spent += sold; s.approved = s.allowance;
};
const refreshInbox = (s: Inbox, ts: bigint) => {
  observeInbox(s, ts);
  const left = s.spent >= CAP ? 0n : CAP - s.spent;
  const amount = (s.balance < left ? s.balance : left) / LOT * LOT;
  if (!s.registered) { if (amount === 0n) throw new Error('NoOrder'); s.registered = true; }
  s.allowance = amount; s.approved = amount;
};
const cowOrder = (s: Inbox, ts: bigint) => {
  const amount = (s.balance < s.allowance ? s.balance : s.allowance) / LOT * LOT;
  return amount === 0n || !s.registered ? null : { amount, validTo: (ts / 3600n + 1n) * 3600n };
};
function day(keeperStartBlock: bigint, posterOffset: bigint, saleDelay: bigint, posterFirst: boolean) {
  const s: Inbox = { hour: 0n, spent: 0n, approved: 0n, allowance: 0n, balance: 2000n * LOT, registered: false };
  let mem: Memory = emptyMemory();
  let wait: { epoch: bigint; retried: boolean } | undefined;
  const posted = new Set<string>();
  let pending = null as { at: bigint; amount: bigint; validTo: bigint } | null;
  const sold = new Map<bigint, bigint>();
  const poster = (ts: bigint) => {
    if ((ts - posterOffset) % 600n !== 0n || (wait && ts < wait.epoch)) return;
    const o = cowOrder(s, ts);
    if (!o) { wait = wait?.retried !== true ? { epoch: ts + 1n, retried: true } : { epoch: (ts / 3600n + 1n) * 3600n, retried: false }; return; }
    wait = undefined;
    const uid = `${o.amount}:${o.validTo}`;
    if (!posted.has(uid)) { posted.add(uid); pending = { at: ts + saleDelay, amount: o.amount, validTo: o.validTo }; }
  };
  for (let b = keeperStartBlock; b < keeperStartBlock + 25n * 300n; b++) {
    const ts = time + b * 12n;
    if (pending && ts >= pending.at) {
      if (ts < pending.validTo && s.allowance >= pending.amount && s.balance >= pending.amount) {
        s.allowance -= pending.amount; s.balance -= pending.amount;
        sold.set(ts / 3600n, (sold.get(ts / 3600n) ?? 0n) + pending.amount / LOT);
      }
      pending = null;
    }
    if (posterFirst) poster(ts);
    const coin: InboxCoin = { coin: addr(20), lot: LOT, balance: s.balance, allowance: s.allowance, approved: s.approved,
      oldestUnsoldAt: time, registered: s.registered };
    const w = world(inboxBox([coin]), b, ts);
    const out = plan(w, mem, options());
    mem = out.mem;
    for (const c of out.candidates) {
      if (c.job === 'royaltyRefresh') refreshInbox(s, ts);
      else if (c.job === 'royaltyObserve') observeInbox(s, ts);
      else continue;
      mem = afterRun(mem, c, true, w);
    }
    if (!posterFirst) poster(ts);
  }
  const first = (time + keeperStartBlock * 12n) / 3600n + 1n;
  return Array.from({ length: 23 }, (_, i) => sold.get(first + BigInt(i)) ?? 0n);
}

describe('RC6RR2-COW-1: a 2,000-lot backlog sells 20 lots in every hour of a day', () => {
  it.each([
    [10n, 0n, 120n], [10n, 300n, 60n], [150n, 120n, 240n], [250n, 0n, 60n], [280n, 540n, 300n], [5n, 36n, 36n],
  ])('keeper from block %i, poster at offset %is, each order sold %is after its post', (k, p, d) => {
    for (const posterFirst of [false, true]) expect(day(k, p, d, posterFirst), `poster first: ${posterFirst}`).toEqual(Array(23).fill(20n));
  });
});

describe('RR2-LIM-3: observe is unblocking work, like the refresh', () => {
  it('a royalty-only box with no platform income in 24 hours gets its observe', async () => {
    const below: InboxCoin = { coin: addr(20), lot: 100n, balance: 99n, allowance: 0n, approved: 0n, oldestUnsoldAt: 0n, registered: false };
    const w = world(box({ v2: { ...v2, buyBackP: 0n, depthBudget: 0n, q: addr(9),
      royalty: { address: addr(8), eth: 0n, wrapped: 0n, price: 0n, coins: [below] } } }));
    const port: ChainPort = { read: async () => w, send: async () => `0x${'56'.repeat(32)}`,
      readIncome: async () => ({ at: w.block.timestamp, platformWei: 10n ** 18n, boxes: {}, mined: {} }),
      simulate: async c => c.job === 'royaltyObserve' ? { ok: true, tipWei: null, estimate: 100_000n } : { ok: false, tipWei: null, estimate: 0n } };
    const out = await runTick(port, {}, { ...options(), dryRun: false, priorityFeeWei: 1n }, quiet);
    expect(out.report.sent.map(s => s.job)).toEqual(['royaltyObserve']);
    expect(out.state.budget.unblockingGas?.[addr(3)]).toBe(V2_GAS_FLOORS.royaltyObserve);
  });
  it('the default daily gas allowance covers 24 of each unblocking job at its published floor', () => {
    expect(DEFAULT_UNBLOCKING_GAS_PER_BOX_PER_DAY).toBe(24n * (V2_GAS_FLOORS.royaltyRefresh + V2_GAS_FLOORS.royaltyObserve
      + V2_GAS_FLOORS.sellFees + V2_GAS_FLOORS.collect));
    expect(DEFAULT_UNBLOCKING_GAS_PER_BOX_PER_DAY).toBe(816_000_000n);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { keccak256, toHex, zeroHash, type Address, type Hex } from 'viem';
import { CowHttp } from '../src/api';
import { Poster, nextCycleDelay } from '../src/poster';
import { orderUid, APP_DATA } from '../src/order';
import type { ChainReader, Clock, CowApi, ReservationStore, Tradeable, Target, Order } from '../src/types';

// Second release review: RC6RR2-COW-1 (c) the hour lost after PollTryAtEpoch, RC6RR2-COW-2 the first poster of a UID
// chooses the signature bytes CoW stores, RC6RR2-COW-3 one poster's capacity per CoW API base.
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const HOUR = 3_600_000;
const targetOf = (n: number): Target => ({ inbox: addr(1000 + n), coin: addr(2), composableCow: addr(3), settlement: addr(4),
  params: { handler: addr(5), salt: zeroHash, staticInput: `0x${'0'.repeat(24)}${addr(2).slice(2)}` } });
const domainSeparator = keccak256(toHex('domain'));
const orderOf = (t: Target, nowMs: number): Order => ({ sellToken: t.coin, buyToken: addr(6), receiver: t.inbox, sellAmount: 10n ** 18n,
  buyAmount: 1n, feeAmount: 0n, validTo: (Math.floor(nowMs / HOUR) + 1) * 3600, appData: keccak256(toHex(APP_DATA)),
  kind: keccak256(toHex('sell')), partiallyFillable: false, sellTokenBalance: keccak256(toHex('erc20')), buyTokenBalance: keccak256(toHex('erc20')) });
const signature = '0x1234' as Hex;

function setup(targets: Target[], over: { cycleMs?: number } = {}) {
  let now = 10 * HOUR;
  const log = vi.fn();
  const seen = new Set<string>();
  const store: ReservationStore = { has: async u => seen.has(u), reserve: async u => { if (seen.has(u)) return false; seen.add(u); return true; } };
  const calls: string[] = [];
  const tradeable = vi.fn(async (t: Target): Promise<Tradeable> => ({ type: 'order', order: orderOf(t, now), signature, domainSeparator }));
  const chain: ChainReader = { chainId: async () => 31337, blockNumber: async () => BigInt(Math.floor(now / 12_000)),
    discover: async () => ({ targets, errors: 0 }), tradeable };
  const api: CowApi = {
    quote: vi.fn(async (_o: Order, from: Address) => { calls.push(`quote:${from}`); return { feeAmount: 0n }; }),
    post: vi.fn(async (o: Order, from: Address) => { calls.push(`post:${from}`); return orderUid(o, from, domainSeparator); }),
    status: vi.fn(async (uid: string) => { calls.push(`status:${uid.slice(-48, -8)}`); return 'open'; }),
    stored: vi.fn(async () => ({ status: 'open', signature })),
  };
  const poster = new Poster({ chain, api, store, chainId: 31337, feeBps: 500n, mode: 'live', now: () => now, log, health: () => {}, ...over });
  return { poster, api, chain, tradeable, log, calls, now: () => now, tick: (ms: number) => { now += ms; } };
}

describe('RC6RR2-COW-1 (c): an order refreshed minutes into the hour is still posted in that hour', () => {
  it('checks once more on the next cycle when a check finds no order, so the first two cycles past each epoch look', async () => {
    const t = targetOf(1); const f = setup([t]);
    let due = 11 * HOUR + 30_000; // our keeper's refresh lands 30 s into the hour, after the poster's first check
    f.tradeable.mockImplementation(async (x: Target) => f.now() < due
      ? { type: 'PollTryAtEpoch', epoch: BigInt((Math.floor(f.now() / HOUR) + 1) * 3600) }
      : { type: 'order', order: orderOf(x, f.now()), signature, domainSeparator });
    await f.poster.cycle(); f.tick(600_000); await f.poster.cycle(); // 10:00 and 10:10: no order, then wait for 11:00
    f.tick(600_000); await f.poster.cycle(); // 10:20: waiting
    expect(f.tradeable).toHaveBeenCalledTimes(2);
    f.tick(2_400_000); await f.poster.cycle(); // 11:00:00, the first cycle past the epoch: still none
    expect(f.api.post).not.toHaveBeenCalled();
    f.tick(600_000); await f.poster.cycle(); // 11:10, the second: the order is there and is posted in its hour
    expect(f.api.post).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.api.post).mock.calls[0]?.[0].validTo).toBe(12 * 3600);
    expect(f.log).toHaveBeenCalledWith('PollTryAtEpoch', expect.objectContaining({ epoch: String(12 * 3600), recheck: 'next_cycle' }));
    // A coin that stays empty is read on two cycles an hour, then waits for the next epoch.
    due = Infinity;
    for (let i = 0; i < 3; i++) { f.tick(600_000); await f.poster.cycle(); } // 11:20 (none: recheck), 11:30 (none: wait), 11:40
    expect(f.tradeable).toHaveBeenCalledTimes(6);
  });
});

describe('RC6RR2-COW-2: after a refused POST the poster compares the signature CoW stores with its own', () => {
  it.each([
    ['0x', true], ['0x1234', false], [`0x${addr(1001).slice(2)}1234`, false], [null, false],
  ] as const)('stored signature %s: foreign_signature %s', async (stored, foreign) => {
    const t = targetOf(1); const f = setup([t]);
    vi.mocked(f.api.post).mockResolvedValue(null);
    vi.mocked(f.api.stored).mockResolvedValue(stored === null ? null : { status: 'open', signature: stored });
    await f.poster.cycle();
    const uid = orderUid(orderOf(t, f.now()), t.inbox, domainSeparator);
    expect(f.api.stored).toHaveBeenCalledWith(uid);
    expect(f.log).toHaveBeenCalledWith('post_unknown', expect.objectContaining({ uid }));
    if (foreign) expect(f.log).toHaveBeenCalledWith('foreign_signature', { inbox: t.inbox, coin: t.coin, uid });
    else expect(f.log).not.toHaveBeenCalledWith('foreign_signature', expect.anything());
  });
  it('CowHttp reads the stored order\'s status and signature, and nothing that is not hex', async () => {
    let now = 0;
    const clock: Clock = { now: () => now, sleep: async ms => { now += ms; }, random: () => 0 };
    const answers = [Response.json({ status: 'open', signature: '0xAB12', signingScheme: 'eip1271' }), Response.json({ status: 'open', signature: 'nope' }),
      Response.json({ status: 'weird' }), new Response('', { status: 404 })];
    const http = new CowHttp('https://api.cow.fi/sepolia', clock, () => {}, async () => answers.shift() ?? new Response('', { status: 500 }));
    const uid = `0x${'11'.repeat(56)}`;
    expect(await http.stored(uid)).toEqual({ status: 'open', signature: '0xab12' });
    expect(await http.stored(uid)).toEqual({ status: 'open', signature: null });
    expect(await http.stored(uid)).toEqual({ status: null, signature: null });
    expect(await http.stored(uid)).toBeNull();
  });
});

describe('RC6RR2-COW-3: one poster per CoW API base posts new hourly orders first', () => {
  it('reads no status right after a POST; an earlier cycle\'s UIDs get their status after every new post of the cycle', async () => {
    const [a, b, c] = [targetOf(1), targetOf(2), targetOf(3)];
    const targets = [a, b]; const f = setup(targets);
    await f.poster.cycle();
    expect(f.calls).toEqual([`quote:${a.inbox}`, `post:${a.inbox}`, `quote:${b.inbox}`, `post:${b.inbox}`]);
    f.calls.length = 0; targets.push(c); f.tick(600_000);
    await f.poster.cycle();
    expect(f.calls.map(x => x.split(':')[0])).toEqual(['quote', 'post', 'status', 'status']);
    expect(f.calls[0]).toBe(`quote:${c.inbox}`);
  });
  it('orders targets least recently posted first, so overflow rotates', async () => {
    const ts = [targetOf(1), targetOf(2), targetOf(3)]; const f = setup(ts);
    // The third inbox's order is not posted this hour (here CoW gives it no quote).
    vi.mocked(f.api.quote).mockImplementation(async (_o: Order, from: Address) => { f.calls.push(`quote:${from}`);
      return from === ts[2]?.inbox ? null : { feeAmount: 0n }; });
    await f.poster.cycle();
    expect(f.calls.filter(x => x.startsWith('post'))).toEqual([`post:${ts[0]?.inbox}`, `post:${ts[1]?.inbox}`]);
    f.calls.length = 0;
    f.tick(HOUR); await f.poster.cycle();
    expect(f.calls.filter(x => x.startsWith('quote'))).toEqual([ts[2], ts[0], ts[1]].map(t => `quote:${t?.inbox}`));
  });
  it('a coin CoW will not quote waits more than one cycle before its next quote', async () => {
    const t = targetOf(1); const f = setup([t], { cycleMs: 600_000 });
    vi.mocked(f.api.quote).mockResolvedValue(null);
    await f.poster.cycle(); f.tick(600_000); await f.poster.cycle(); f.tick(600_000); await f.poster.cycle();
    expect(f.api.quote).toHaveBeenCalledTimes(2);
  });
  it('status reads stop at the end of the cycle period, and before the time the next hour\'s posts need', async () => {
    const ts = Array.from({ length: 5 }, (_, i) => targetOf(i + 1)); const f = setup(ts, { cycleMs: 600_000 });
    await f.poster.cycle();
    vi.mocked(f.api.status).mockImplementation(async () => { f.tick(250_000); return 'open'; });
    f.tick(600_000); await f.poster.cycle();
    expect(f.api.status).toHaveBeenCalledTimes(3);
    expect(f.log).toHaveBeenCalledWith('status_deferred', { count: 2 });
    // 59:50 into the hour, five orders' quotes and posts (40 s at the 4 s spacing) need the time left: no status read.
    vi.mocked(f.api.status).mockClear(); f.tick(HOUR - (f.now() % HOUR) - 10_000);
    await f.poster.cycle();
    expect(f.api.status).not.toHaveBeenCalled();
    expect(f.log).toHaveBeenLastCalledWith('cycle_complete', expect.anything());
  });
  it('the next cycle starts at the hour\'s turn plus a minute when that comes first', () => {
    expect(nextCycleDelay(600_000, 100_000, 10 * HOUR)).toBe(60_000);
    expect(nextCycleDelay(600_000, 100_000, 10 * HOUR + 30_000)).toBe(30_000);
    expect(nextCycleDelay(600_000, 100_000, 10 * HOUR + 60_000)).toBe(500_000);
    expect(nextCycleDelay(600_000, 3_200_000, 10 * HOUR + 3_200_000)).toBe(0);
    expect(nextCycleDelay(600_000, 0, 10 * HOUR + 3_200_000)).toBe(460_000);
  });

  it('400 inboxes with an order each hour: every one is posted in every hour (the reviewer\'s capacity model)', async () => {
    const n = 400;
    const targets = Array.from({ length: n }, (_, i) => targetOf(i));
    const f = setup(targets, { cycleMs: 600_000 });
    const spend = async () => { f.tick(4000); };
    const posted = new Map<number, Set<number>>();
    vi.mocked(f.api.quote).mockImplementation(async () => { await spend(); return { feeAmount: 0n }; });
    vi.mocked(f.api.post).mockImplementation(async (o: Order, from: Address) => {
      await spend();
      const hour = Math.floor(f.now() / HOUR);
      if (o.validTo * 1000 > f.now()) { const m = posted.get(hour) ?? new Set(); m.add(Number(BigInt(from)) - 1000); posted.set(hour, m); }
      return orderUid(o, from, domainSeparator);
    });
    vi.mocked(f.api.status).mockImplementation(async () => { await spend(); return 'open'; });
    const end = f.now() + 4 * HOUR;
    while (f.now() < end) {
      const start = f.now();
      await f.poster.cycle();
      f.tick(nextCycleDelay(600_000, f.now() - start, f.now()));
    }
    const hours = [...posted.keys()].sort().slice(0, 4);
    expect(hours.map(h => posted.get(h)?.size)).toEqual([n, n, n, n]);
  });
});

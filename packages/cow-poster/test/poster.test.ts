import { describe, expect, it, vi } from 'vitest';
import { keccak256, toHex, zeroHash, type Address } from 'viem';
import { CowHttp } from '../src/api';
import { Poster } from '../src/poster';
import { orderFields, orderUid, APP_DATA } from '../src/order';
import type { ChainReader, Clock, CowApi, ReservationStore, Tradeable, Target, Order } from '../src/types';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const target: Target = { inbox: addr(1), coin: addr(2), composableCow: addr(3), settlement: addr(4),
  params: { handler: addr(5), salt: zeroHash, staticInput: `0x${'0'.repeat(24)}${addr(2).slice(2)}` } };
const order: Order = { sellToken: target.coin, buyToken: addr(6), receiver: target.inbox,
  sellAmount: 10n ** 22n, buyAmount: 1n, feeAmount: 0n, validTo: 7200,
  appData: keccak256(toHex(APP_DATA)), kind: keccak256(toHex('sell')), partiallyFillable: false,
  sellTokenBalance: keccak256(toHex('erc20')), buyTokenBalance: keccak256(toHex('erc20')) };
const trade = { type: 'order', order, signature: '0x1234', domainSeparator: keccak256(toHex('domain')) } satisfies Tradeable;

function setup() {
  let now = 3600_000;
  let block = 100n;
  const log = vi.fn();
  const health = vi.fn();
  const seen = new Set<string>();
  const store: ReservationStore = {
    has: async uid => seen.has(uid),
    reserve: async uid => { if (seen.has(uid)) return false; seen.add(uid); return true; },
  };
  const chain: ChainReader = { chainId: async () => 31337, blockNumber: async () => block,
    discover: vi.fn(async () => ({ targets: [target], errors: 0 })), tradeable: vi.fn(async () => trade) };
  const api: CowApi = { quote: vi.fn(async () => ({ feeAmount: order.sellAmount / 100n })),
    post: vi.fn(async () => orderUid(order, target.inbox, trade.domainSeparator)),
    status: vi.fn(async () => 'open'), stored: vi.fn(async () => ({ status: 'open', signature: '0x1234' as const })) };
  const make = (mode: 'dry-run' | 'live' = 'live') => new Poster({ chain, api, store, chainId: 31337, feeBps: 500n, mode, now: () => now, log, health });
  return { chain, api, store, log, health, make, tick: (ms: number) => { now += ms; }, block: (n: bigint) => { block = n; } };
}

describe('keyless posting cycle', () => {
  it('quotes the same sale, preserves every signed field, then reads status on a later cycle (RC6RR2-COW-3)', async () => {
    const f = setup();
    const p = f.make(); await p.cycle();
    expect(f.api.quote).toHaveBeenCalledWith(order, target.inbox);
    expect(f.api.post).toHaveBeenCalledWith(order, target.inbox, '0x1234');
    expect(f.api.status).not.toHaveBeenCalled();
    expect(f.api.quote).toHaveBeenCalledBefore(vi.mocked(f.api.post));
    expect(f.health).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'idle', posted: 1 }));
    await p.cycle();
    expect(f.api.status).toHaveBeenCalledWith(orderUid(order, target.inbox, trade.domainSeparator));
    expect(f.api.post).toHaveBeenCalledTimes(1);
  });
  it('does not post without a quote', async () => {
    const f = setup(); vi.mocked(f.api.quote).mockResolvedValue(null);
    await f.make().cycle(); expect(f.api.post).not.toHaveBeenCalled();
  });
  it.each([500n, 501n])('compares the fee exactly at %s bps, including large raw amounts', async bps => {
    const f = setup(); vi.mocked(f.api.quote).mockResolvedValue({ feeAmount: order.sellAmount * bps / 10_000n });
    await f.make().cycle(); expect(f.api.post).toHaveBeenCalledTimes(bps === 500n ? 1 : 0);
  });
  it('skips a high-fee order until its hour expires', async () => {
    const f = setup(); vi.mocked(f.api.quote).mockResolvedValue({ feeAmount: order.sellAmount });
    const poster = f.make(); await poster.cycle(); await poster.cycle();
    expect(f.api.quote).toHaveBeenCalledTimes(1);
  });
  it('never repeats a UID, even after a restart and ambiguous POST response', async () => {
    const f = setup(); vi.mocked(f.api.post).mockResolvedValue(null);
    const first = f.make(); await first.cycle(); await first.cycle(); await f.make().cycle();
    expect(f.api.post).toHaveBeenCalledTimes(1);
    // The refused POST's stored order is read at once (RC6RR2-COW-2), then its status on each later cycle.
    expect(f.api.stored).toHaveBeenCalledTimes(1);
    expect(f.api.status).toHaveBeenCalledTimes(2);
  });
  it('persists the reservation before HTTP, and refuses to post on storage failure', async () => {
    const f = setup(); f.store.reserve = vi.fn(async () => { throw new Error('disk full'); });
    await expect(f.make().cycle()).rejects.toThrow('disk full');
    expect(f.api.post).not.toHaveBeenCalled();
  });
  it.each(['fulfilled', 'cancelled', 'expired'] as const)('does not repost %s orders', async status => {
    const f = setup(); vi.mocked(f.api.status).mockResolvedValue(status);
    const p = f.make(); await p.cycle(); await p.cycle(); expect(f.api.post).toHaveBeenCalledTimes(1);
  });
  it('obeys PollTryAtEpoch without quoting, after one re-check on the next cycle (RC6RR2-COW-1 (c))', async () => {
    const f = setup(); vi.mocked(f.chain.tradeable).mockResolvedValue({ type: 'PollTryAtEpoch', epoch: 7200n });
    const p = f.make(); await p.cycle(); f.tick(600_000); await p.cycle(); f.tick(600_000); await p.cycle();
    expect(f.chain.tradeable).toHaveBeenCalledTimes(2); expect(f.api.quote).not.toHaveBeenCalled();
    f.tick(2400_000); await p.cycle(); expect(f.chain.tradeable).toHaveBeenCalledTimes(3);
    expect(f.log).toHaveBeenCalledWith('PollTryAtEpoch', expect.objectContaining({ epoch: '7200' }));
  });
  it('obeys PollTryNextBlock even when the chain stalls', async () => {
    const f = setup(); vi.mocked(f.chain.tradeable).mockResolvedValue({ type: 'PollTryNextBlock', block: 102n });
    const p = f.make(); await p.cycle(); await p.cycle(); expect(f.chain.tradeable).toHaveBeenCalledTimes(1);
    f.block(102n); await p.cycle(); expect(f.chain.tradeable).toHaveBeenCalledTimes(2);
  });
  it('records OrderNotValid and waits for the next cycle', async () => {
    const f = setup(); vi.mocked(f.chain.tradeable).mockResolvedValue({ type: 'OrderNotValid' });
    const p = f.make(); await p.cycle(); expect(f.api.quote).not.toHaveBeenCalled();
    expect(f.log).toHaveBeenCalledWith('OrderNotValid', expect.any(Object));
    await p.cycle(); expect(f.chain.tradeable).toHaveBeenCalledTimes(2);
  });
  it('isolates missing chain data from another inbox', async () => {
    const f = setup(); vi.mocked(f.chain.discover).mockResolvedValue({ targets: [target, { ...target, coin: addr(7) }], errors: 1 });
    vi.mocked(f.chain.tradeable).mockResolvedValueOnce({ type: 'no_data' })
      .mockResolvedValueOnce({ ...trade, order: { ...order, sellToken: addr(7) } });
    vi.mocked(f.api.post).mockResolvedValue(orderUid({ ...order, sellToken: addr(7) }, target.inbox, trade.domainSeparator));
    await f.make().cycle(); expect(f.api.post).toHaveBeenCalledTimes(1);
    expect(f.health).toHaveBeenLastCalledWith(expect.objectContaining({ errors: 2 }));
  });
  it('refuses a mismatched RPC chain before discovery or API access', async () => {
    const f = setup(); f.chain.chainId = async () => 1;
    await expect(f.make().cycle()).rejects.toThrow('chain mismatch');
    expect(f.chain.discover).not.toHaveBeenCalled(); expect(f.api.quote).not.toHaveBeenCalled();
  });
  it('skips expired orders', async () => {
    const f = setup(); f.tick(3600_000); await f.make().cycle(); expect(f.api.quote).not.toHaveBeenCalled();
  });
  it('in a dry run quotes and logs the order it would post, but never reserves, posts or repeats it within the hour', async () => {
    const f = setup(); const uid = orderUid(order, target.inbox, trade.domainSeparator);
    const p = f.make('dry-run'); await p.cycle();
    expect(f.api.quote).toHaveBeenCalledTimes(1);
    expect(f.log).toHaveBeenCalledWith('dry_run_order', { inbox: target.inbox, coin: target.coin, uid,
      sellAmount: order.sellAmount.toString(), feeAmount: (order.sellAmount / 100n).toString() });
    expect(f.health).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'idle', mode: 'dry-run', posted: 0, skipped: 1 }));
    await p.cycle(); expect(f.chain.tradeable).toHaveBeenCalledTimes(1);
    f.tick(3600_000); await p.cycle(); expect(f.chain.tradeable).toHaveBeenCalledTimes(2);
    expect(f.api.post).not.toHaveBeenCalled(); expect(f.api.status).not.toHaveBeenCalled();
    expect(await f.store.has(uid)).toBe(false);
  });
  it('in a dry run still only reads the status of a UID an earlier live run attempted', async () => {
    const f = setup(); await f.make('live').cycle(); await f.make('dry-run').cycle();
    expect(f.api.post).toHaveBeenCalledTimes(1); expect(f.api.status).toHaveBeenCalledTimes(1);
    expect(f.health).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'dry-run', posted: 0 }));
  });
  it.each([{ sellToken: addr(9) }, { receiver: addr(9) }])('refuses an order unrelated to its discovered target %j', async overrides => {
    const f = setup(); vi.mocked(f.chain.tradeable).mockResolvedValue({ ...trade, order: { ...order, ...overrides } });
    await f.make().cycle(); expect(f.api.post).not.toHaveBeenCalled(); expect(f.api.quote).not.toHaveBeenCalled();
  });
});

describe('an RPC read that fails ends the cycle, not the process', () => {
  const down = async (): Promise<never> => { throw new Error('secret rpc detail'); };
  it('keeps CoW’s back-off: after a 429 with Retry-After and a failed RPC read, the next quote waits for the deadline', async () => {
    let now = 3600_000;
    const clock: Clock = { now: () => now, sleep: async ms => { now += ms; }, random: () => 0 };
    const uid = orderUid(order, target.inbox, trade.domainSeparator);
    const fee = order.sellAmount / 100n;
    const live = { from: target.inbox, expiration: new Date(7_200_000).toISOString(), id: 2, verified: true,
      quote: { ...orderFields(order), sellAmount: (order.sellAmount - fee).toString(), feeAmount: fee.toString(), buyAmount: '5' } };
    const answers = [new Response('', { status: 429, headers: { 'Retry-After': '1800' } }), Response.json(live),
      Response.json(uid), Response.json({ status: 'open' })];
    const starts: number[] = [];
    const fetcher = vi.fn(async () => {
      starts.push(now); const next = answers.shift();
      if (!next) throw new Error('unexpected CoW request'); return next;
    });
    const log = vi.fn();
    const health = vi.fn();
    const api = new CowHttp('https://api.cow.fi/sepolia', clock, log, fetcher);
    const blockNumber = vi.fn<() => Promise<bigint>>().mockResolvedValueOnce(100n).mockImplementationOnce(down).mockResolvedValue(100n);
    const chain: ChainReader = { chainId: async () => 31337, blockNumber,
      discover: async () => ({ targets: [target], errors: 0 }), tradeable: async () => trade };
    const seen = new Set<string>();
    const store: ReservationStore = { has: async u => seen.has(u), reserve: async u => { seen.add(u); return true; } };
    const poster = new Poster({ chain, api, store, chainId: 31337, feeBps: 500n, mode: 'live', now: clock.now, log, health });
    await poster.cycle();
    expect(log).toHaveBeenCalledWith('api_backoff', { status: 429, retryAt: 5_400_000 });
    expect(log).toHaveBeenCalledWith('no_quote', { inbox: target.inbox, coin: target.coin });
    now += 600_000; await poster.cycle();
    expect(log).toHaveBeenLastCalledWith('cycle_failed', { stage: 'block_number', failedCycles: 1 });
    expect(health).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'idle', targets: 1, errors: 1 }));
    expect(starts).toEqual([3_600_000]);
    now += 600_000; await poster.cycle();
    // The earlier Retry-After still holds: the quote starts at its deadline, not at the cycle's start (4,800,000).
    // No status read follows the POST in its own cycle (RC6RR2-COW-3).
    expect(starts).toEqual([3_600_000, 5_400_000, 5_404_000]);
    expect(log).toHaveBeenCalledWith('posted', { inbox: target.inbox, coin: target.coin, uid });
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret rpc detail');
  });
  it.each(['chain_id', 'discover', 'block_number'] as const)('a failed %s read logs cycle_failed, reports idle with the error and asks CoW nothing', async stage => {
    const f = setup();
    if (stage === 'chain_id') f.chain.chainId = down; else if (stage === 'discover') f.chain.discover = down; else f.chain.blockNumber = down;
    await expect(f.make().cycle()).resolves.toBeUndefined();
    expect(f.log).toHaveBeenLastCalledWith('cycle_failed', { stage, failedCycles: 1 });
    expect(f.health).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'idle', mode: 'live', errors: 1 }));
    expect(f.health.mock.lastCall?.[0]).not.toHaveProperty('completedAt');
    expect(f.api.quote).not.toHaveBeenCalled(); expect(f.api.status).not.toHaveBeenCalled();
    expect(f.chain.tradeable).not.toHaveBeenCalled();
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('secret rpc detail');
  });
  it('is fatal on the third failed cycle in a row, as every failure was before; a completed cycle starts the count again', async () => {
    const f = setup(); const poster = f.make();
    let rpcDown = true;
    f.chain.blockNumber = async () => { if (rpcDown) throw new Error('rpc down'); return 100n; };
    await poster.cycle(); await poster.cycle();
    rpcDown = false; await poster.cycle();
    expect(f.health).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'idle', posted: 1, errors: 0 }));
    rpcDown = true; await poster.cycle(); await poster.cycle();
    await expect(poster.cycle()).rejects.toThrow('rpc down');
    expect(f.log.mock.calls.filter(([event]) => event === 'cycle_failed').map(([, fields]) => fields)).toEqual([
      { stage: 'block_number', failedCycles: 1 }, { stage: 'block_number', failedCycles: 2 },
      { stage: 'block_number', failedCycles: 1 }, { stage: 'block_number', failedCycles: 2 }]);
  });
  it('stays fatal at once on a chain mismatch, a storage failure or a health-file failure', async () => {
    const mismatch = setup(); mismatch.chain.chainId = async () => 1;
    await expect(mismatch.make().cycle()).rejects.toThrow('RPC chain mismatch');
    const storage = setup(); storage.store.has = async () => { throw new Error('disk gone'); };
    await expect(storage.make().cycle()).rejects.toThrow('disk gone');
    for (const f of [mismatch, storage]) expect(f.log).not.toHaveBeenCalledWith('cycle_failed', expect.anything());
    // The failed cycle's own health write is storage too.
    const healthFile = setup(); healthFile.chain.discover = down;
    healthFile.health.mockImplementation(async (h: { phase: string }) => { if (h.phase === 'idle') throw new Error('health write'); });
    await expect(healthFile.make().cycle()).rejects.toThrow('health write');
  });
  it('stops instead of reporting a failed cycle once the stop signal has fired', async () => {
    const f = setup(); const stop = new AbortController();
    f.chain.discover = async () => { stop.abort(); throw new Error('rpc down'); };
    const poster = new Poster({ chain: f.chain, api: f.api, store: f.store, chainId: 31337, feeBps: 500n, mode: 'live',
      now: () => 0, log: f.log, health: f.health, signal: stop.signal });
    await expect(poster.cycle()).rejects.toThrow('aborted');
    expect(f.log).not.toHaveBeenCalledWith('cycle_failed', expect.anything());
  });
});

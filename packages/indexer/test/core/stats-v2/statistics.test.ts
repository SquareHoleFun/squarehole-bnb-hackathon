import { describe, expect, it } from 'vitest';
import { type Address } from 'viem';
import { CoreChainIndexer } from '../../../src/core/chain-indexer';
import { jsonV2 } from '../../../src/core/core-row';
import { rowsFromV2Logs } from '../../../src/core/v2/discovery-v2';
import { decodeV2Logs, routeV2 } from '../../../src/core/v2/events-v2';
import { applyV2Block, liveViewV2, type LiveStateV2 } from '../../../src/core/v2/views-v2';
import { World } from '../core-synth';
import { boxLogsV2, eventV2, listingAddedLog, requiredV2, serviceBoxV2, serviceChainV2, serviceListingV2, synthManifestV2, V2 } from '../scripted-core-chain';

const manifest = synthManifestV2();
const release = requiredV2(manifest.releases[0]);
const box = serviceBoxV2();
const token = requiredV2(box.record.contracts[1]);
const hook = requiredV2(box.record.contracts[2]);
const alice = box.record.creator;
const bob = '0x0000000000000000000000000000000000001234' as Address;
const zero = '0x0000000000000000000000000000000000000000' as Address;
const unit = 10n ** 18n;
const q96 = 1n << 96n;
const transfer = (from: Address, to: Address, amount: bigint) => eventV2('token', 'Transfer', token, { from, to, amount });
const swap = (amount0: bigint, sqrtPriceX96: bigint, sender = alice) => eventV2('poolManager', 'Swap', V2.poolManager, {
  id: box.record.poolId, sender, amount0, amount1: amount0 < 0n ? 10n * unit : -10n * unit,
  sqrtPriceX96, liquidity: 1000n, tick: 0, fee: 10000,
});
function fixture() {
  const world = new World('ta28');
  world.block(10n);
  world.block(100n, [listingAddedLog(serviceListingV2()), boxLogsV2(box), [
    transfer(zero, alice, 1000n * unit),
    eventV2('poolManager', 'Initialize', V2.poolManager, { id: box.record.poolId, currency0: box.record.q, currency1: token, fee: 10000, tickSpacing: 60, hooks: hook, sqrtPriceX96: q96 * 2n, tick: 13863 }),
    eventV2('hook', 'PoolLaunched', hook, { poolId: box.record.poolId, tickLower: 0, tickUpper: 13860, liquidity: 1000n * unit, sqrtPriceX96: q96 * 2n, tokenDeposited: 1000n * unit }),
  ]]);
  const row = requiredV2(rowsFromV2Logs(world.logs, release, V2.chainId)[0]);
  const route = routeV2(release, manifest, [], [box.record]);
  function fold(previous?: LiveStateV2) {
    const header = requiredV2(world.headers.at(-1));
    return applyV2Block(previous, header, decodeV2Logs(world.logs.filter(l => l.blockNumber === header.number), route), row);
  }
  return { world, row, fold };
}
const stats = (state: LiveStateV2, now = 0n) => jsonV2(liveViewV2(state, now)).statistics;

describe('TA28 log-derived statistics', () => {
  it('publishes exact price, cap, curve, supply and holders before any trade', () => {
    const f = fixture(); const state = f.fold().state;
    expect(stats(state)).toMatchObject({ pricePPerTX18: '250000000000000000000000000000000000', marketCapP: '250000000000000000000',
      totalSupplyT: '1000000000000000000000', burnedT: '0', holderCount: '1', tradeCount: '0', volume24hP: '0',
      raiseProgress: { raisedP: '0', raiseP: box.spec.raise.toString(), progressBps: '0' }, hourlyCandles: [] });
  });
  it('counts balances, actual burns and trades once; candles use P/T extrema, not square-root extrema', () => {
    const f = fixture(); const before = f.fold().state;
    f.world.block(101n, [[transfer(alice, bob, 20n * unit), transfer(bob, bob, unit), transfer(bob, zero, 3n * unit),
      transfer(bob, alice, 17n * unit), transfer(alice, zero, 0n), swap(-900719925474099312345n, q96), swap(7n, q96 * 2n), swap(-9n, q96 / 2n), swap(-999n, q96, hook)]]);
    const header = requiredV2(f.world.headers.at(-1)); const got = f.fold(before);
    expect(stats(got.state, header.timestamp)).toMatchObject({ totalSupplyT: '997000000000000000000', burnedT: '3000000000000000000', holderCount: '1',
      tradeCount: '3', volume24hP: '900719925474099312361', pricePPerTX18: '1000000000000000000000000000000000000', marketCapP: '997000000000000000000',
      hourlyCandles: [{ open: '1000000000000000000000000000000000000', high: '4000000000000000000000000000000000000',
        low: '250000000000000000000000000000000000', close: '1000000000000000000000000000000000000', volumeP: '900719925474099312361', tradeCount: '3' }] });
    expect(f.fold(got.state).state).toBe(got.state);
    expect(stats(before)).toMatchObject({ totalSupplyT: '1000000000000000000000', burnedT: '0', tradeCount: '0', hourlyCandles: [] });
  });
  it('expires exact 24-hour boundaries on empty heads and bounds hourly history', () => {
    const f = fixture(); const initial = f.fold().state;
    f.world.block(101n, [[swap(-13n, q96)]]); const traded = f.fold(initial).state;
    const time = requiredV2(f.world.headers.at(-1)).timestamp;
    expect(stats(traded, time + 86399n)).toMatchObject({ volume24hP: '13', tradeCount: '1' });
    expect(stats(traded, time + 86400n)).toMatchObject({ volume24hP: '0', tradeCount: '1' });
    expect(stats(traded, time + 168n * 3600n)).toMatchObject({ hourlyCandles: [] });
  });
  it('retains more than the recent 500 trades, aggregates hours, and ignores duplicate/foreign logs', () => {
    const f = fixture(); const initial = f.fold().state;
    f.world.block(101n, [[...Array.from({ length: 601 }, () => swap(-3n, q96))]]);
    const header = requiredV2(f.world.headers.at(-1));
    const events = decodeV2Logs(f.world.logs.filter(l => l.blockNumber === 101n), routeV2(release, manifest, [], [box.record]));
    const other = { ...requiredV2(events[0]), boxId: 99n, ref: { ...requiredV2(events[0]).ref, logIndex: 999 } };
    const state = applyV2Block(initial, header, [...events].reverse().concat(events, [other]), f.row).state;
    expect(stats(state, header.timestamp)).toMatchObject({ tradeCount: '601', volume24hP: '1803', hourlyCandles: [{ volumeP: '1803', tradeCount: '601' }] });
    f.world.block(401n, [[swap(-11n, q96 * 2n)]]);
    const next = f.fold(state).state;
    expect(stats(next, requiredV2(f.world.headers.at(-1)).timestamp)).toMatchObject({ tradeCount: '602', volume24hP: '1814', hourlyCandles: [{ volumeP: '1803' }, { volumeP: '11' }] });
  });
  it('reports unavailable pool figures honestly before initialization and after failure', () => {
    const f = fixture(); const initial = f.fold().state;
    expect(stats({ ...initial, pool: null })).toMatchObject({ pricePPerTX18: null, marketCapP: null, raiseProgress: null });
    const failed = { ...initial, view: { ...initial.view, failed: { cause: 'deadline', caller: alice, at: 1n } } };
    expect(stats(failed)).toMatchObject({ pricePPerTX18: null, marketCapP: null, raiseProgress: null });
  });
  it('stops curve progress at migration and keeps pool trading and burning', () => {
    const f = fixture(); const initial = f.fold().state;
    f.world.block(101n, [[swap(-13n, q96), eventV2('hook', 'CurveClosed', hook, { poolId: box.record.poolId, blockNumber: 101n, sqrtPriceX96: q96 })]]);
    const filled = f.fold(initial).state;
    expect(stats(filled)).toMatchObject({ raiseProgress: { raisedP: box.spec.raise.toString(), progressBps: '10000' } });
    f.world.block(102n, [[eventV2('hook', 'MigratedV2', hook, { poolId: box.record.poolId, liquidity: 500n, qLeft: 3n, tBurned: 2n }), transfer(alice, zero, 2n), swap(-17n, q96 / 2n)]]);
    expect(stats(f.fold(filled).state, requiredV2(f.world.headers.at(-1)).timestamp)).toMatchObject({ raiseProgress: null, burnedT: '2', tradeCount: '2', volume24hP: '30' });
  });
  it('serves identical additive stats in the box and feed and rewinds them on a reorg', async () => {
    const f = fixture(); f.world.block(101n, [[swap(-13n, q96), transfer(alice, zero, 7n)]]); f.world.to(105n);
    const chain = serviceChainV2(f.world, [box]);
    const indexer = new CoreChainIndexer({ reader: chain, manifest, auditEvery: 10000 });
    await indexer.start(); await indexer.idle();
    expect(indexer.v2FeedView().schema).toBe('sh.core-feed.v2');
    expect(indexer.v2FeedView().cards[0]?.statistics).toEqual(indexer.v2BoxView(token)?.statistics);
    expect(indexer.v2BoxView(token)?.statistics).toMatchObject({ tradeCount: '1', burnedT: '7', volume24hP: '13' });
    const canonical = f.world.fork(100n, 'ta28-canonical'); canonical.block(101n, [[swap(-19n, q96 * 2n)]]); canonical.to(106n);
    chain.setBranch(canonical.headers.filter(h => h.number > 100n), canonical.logs.filter(l => l.blockNumber > 100n));
    await indexer.enqueue(chain.header(106n)); await indexer.idle();
    expect(indexer.v2BoxView(token)?.statistics).toMatchObject({ tradeCount: '1', burnedT: '0', volume24hP: '19' });
    const rebuilt = new CoreChainIndexer({ reader: serviceChainV2(canonical, [box]), manifest, auditEvery: 10000 });
    await rebuilt.start(); await rebuilt.idle();
    expect(indexer.v2FeedView()).toEqual(rebuilt.v2FeedView());
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getAddress, type Address } from 'viem';
import { CoreChainIndexer } from '../../src/core/chain-indexer';
import { coreGatewaySource } from '../../src/core/core-service';
import { rowsFromV2Logs } from '../../src/core/v2/discovery-v2';
import { decodeV2Logs, routeV2 } from '../../src/core/v2/events-v2';
import { applyV2Block } from '../../src/core/v2/views-v2';
import { MemoryHistory } from '../../src/history/memory-history';
import { parseActivityPageV2 } from '../../../../apps/web/src/features/core/v2/life-activity';
import { HistoryWriter } from '../../src/history/writer';
import { World } from './core-synth';
import { boxLogsV2, eventV2, listingAddedLog, requiredV2, serviceBoxV2, serviceChainV2, serviceListingV2, synthManifestV2, V2 } from './scripted-core-chain';

const manifest = synthManifestV2();
const release = requiredV2(manifest.releases[0]);
const box = serviceBoxV2();
const token = requiredV2(box.record.contracts[1]);
const alice = getAddress('0xabcdef0000000000000000000000000000000001');
const bob = getAddress('0xabcdef0000000000000000000000000000000002');
const router = getAddress('0xabcdef0000000000000000000000000000000003');
const zero = '0x0000000000000000000000000000000000000000' as Address;
const huge = 10n ** 30n;
const transfer = (from: Address, to: Address, amount: bigint) => eventV2('token', 'Transfer', token, { from, to, amount });
const swap = (buy = true, sender = router) => eventV2('poolManager', 'Swap', V2.poolManager, {
  id: box.record.poolId, sender, amount0: buy ? -100n : 100n, amount1: buy ? huge : -huge,
  sqrtPriceX96: 1n << 96n, liquidity: 1000n, tick: 0, fee: 10000,
});
function fixture(transactions: Parameters<World['block']>[1]) {
  const world = new World('activity-v2');
  world.block(10n); world.block(99n, [listingAddedLog(serviceListingV2())]);
  world.block(100n, [boxLogsV2(box)]); world.block(101n, transactions);
  const row = requiredV2(rowsFromV2Logs(world.logs, release, V2.chainId)[0]);
  const header = requiredV2(world.headers.at(-1));
  const events = decodeV2Logs(world.logs.filter(log => log.blockNumber === 101n), routeV2(release, manifest, [], [box.record]));
  return { world, row, header, events, result: applyV2Block(undefined, header, events, row) };
}

describe('ACT-1: v2 transaction net T attribution', () => {
  it.each([true, false])('follows a router hand-off for buy=%s, retaining all trade fields', buy => {
    const logs = buy
      ? [swap(), transfer(V2.poolManager, router, huge), transfer(router, alice, huge)]
      : [transfer(alice, router, huge), swap(false), transfer(router, V2.poolManager, huge)];
    const { result } = fixture([logs]);
    expect(result.trades[0]).toMatchObject({ trader: alice.toLowerCase(), side: buy ? 'buy' : 'sell', route: 'other',
      qRaw: 100n, tRaw: huge, taxQ: 0n, feeQ: buy ? 1n : 0n, feeT: buy ? 0n : huge / 100n,
      sqrtPriceX96After: 1n << 96n, tickAfter: 0, block: 101n });
  });

  it('uses the greatest exact signed net change across all trades in one transaction, without crossing transactions', () => {
    const { result } = fixture([
      [swap(), transfer(V2.poolManager, alice, huge), swap(), transfer(V2.poolManager, bob, huge + 1n)],
      [swap(false), transfer(alice, V2.poolManager, huge + 1n), swap(false), transfer(bob, V2.poolManager, huge)],
      [swap(), transfer(V2.poolManager, alice, 1n)],
      [swap(), swap(false), transfer(alice, bob, huge)],
    ]);
    expect(result.trades.map(t => t.trader)).toEqual([bob, bob, alice, alice, alice, bob, alice].map(a => a.toLowerCase()));
  });

  it('nets round trips, excludes every box contract, pool and zero; null when no external T moves', () => {
    const known = [...new Set([...box.record.contracts, V2.poolManager, zero])];
    const { result } = fixture([
      [swap(), ...known.map(to => transfer(V2.poolManager, to, huge)), transfer(V2.poolManager, alice, 3n), transfer(alice, V2.poolManager, 2n)],
      [swap(), ...known.map(to => transfer(V2.poolManager, to, huge))],
      [swap(false), ...known.map(from => transfer(from, V2.poolManager, huge))],
      [swap(), transfer(alice, alice, huge)],
      [swap()],
    ]);
    expect(result.trades.map(t => t.trader)).toEqual([alice.toLowerCase(), null, null, null, null]);
  });

  it('ignores other boxes and non-T transfers even when they share the transaction', () => {
    const f = fixture([[swap(), transfer(V2.poolManager, alice, 1n), transfer(V2.poolManager, bob, huge)]]);
    const events = f.events.map(e => e.args.to === bob ? { ...e, boxId: box.record.boxId + 1n } : e);
    expect(applyV2Block(undefined, f.header, events, f.row).trades[0]?.trader).toBe(alice.toLowerCase());
    const nft = f.events.map(e => e.args.to === bob ? { ...e, source: 'collection' as const, args: { from: V2.poolManager, to: bob, tokenId: 1n } } : e);
    expect(applyV2Block(undefined, f.header, nft, f.row).trades[0]?.trader).toBe(alice.toLowerCase());
  });

  it('keeps the taxed launch buyer ahead of a different T recipient, normalized to lowercase', () => {
    const launchRouter = requiredV2(box.record.contracts[6]);
    const { result } = fixture([[swap(true, launchRouter), transfer(V2.poolManager, bob, huge),
      eventV2('launchRouter', 'TaxedBuy', launchRouter, { buyer: alice, recipient: bob, step: 1n, qIn: 100n, tax: 7n, tokensOut: huge, refund: 0n }),
    ]]);
    expect(result.trades[0]).toMatchObject({ trader: alice.toLowerCase(), route: 'launch_router', taxQ: 7n });
  });

  it.each([false, true])('serves recent and persisted activity, including old stored trades (legacy=%s)', async legacy => {
    const { world } = fixture([[swap(), transfer(V2.poolManager, router, huge), transfer(router, alice, huge)]]);
    world.to(105n);
    const reader = serviceChainV2(world, [box]);
    const store = new MemoryHistory(); const writer = new HistoryWriter(store);
    const indexer = new CoreChainIndexer({ reader, manifest, auditEvery: 10000, onHistory: message => writer.accept(
      legacy && message.type === 'block' ? { ...message, result: { ...message.result, boxes: message.result.boxes.map(b => ({ ...b, trades: b.trades.map(t => ({ ...t, trader: null })) })) } } : message,
    ) });
    try {
      await indexer.start(); await writer.flush();
      for (const history of [null, store]) {
        const { source } = coreGatewaySource(indexer, reader, history, 60000);
        const page = await source.activity(token, { kind: 'trade', before: null, limit: 1 });
        expect(page?.items).toHaveLength(1);
        expect(page?.items[0]).toMatchObject({ kind: 'trade', trader: alice.toLowerCase() });
      }
    } finally { indexer.stop(); writer.stop(); }
  });
});

// SH-259: an event argument named like one of the row's own labels (the receiver's ItemFunded has `source`) once replaced
// the label, and the page refused the whole activity answer ("Trades unavailable" on Rent Free, chain 97).
describe('activity labels: the row\'s source, event and emitter win over an argument of the same name', () => {
  const receiver = requiredV2(box.record.contracts[5]);
  const itemFunded = (d: Record<string, unknown>) => {
    const { result } = fixture([[eventV2('receiver', 'ItemFunded', receiver, { receiptId: BigInt(d.receiptId as string), batchId: BigInt(d.batchId as string),
      side: Number(d.side), source: Number(d.source), choiceP: BigInt(d.choiceP as string), ledgerP: BigInt(d.ledgerP as string) })]]);
    const item = result.activity.find(a => a.data.event === 'ItemFunded');
    if (!item) throw new Error('no ItemFunded activity');
    return item.data;
  };

  it('keeps source, event and emitter, and the argument as arg_source', () => {
    expect(itemFunded({ receiptId: '2', batchId: '9', side: 1, source: 1, choiceP: '6666680', ledgerP: '13513' })).toEqual({
      source: 'receiver', event: 'ItemFunded', emitter: receiver.toLowerCase(),
      receiptId: '2', batchId: '9', side: 1, arg_source: 1, choiceP: '6666680', ledgerP: '13513' });
  });

  it('keeps them against arguments named event and emitter too (arg_event, arg_emitter)', () => {
    const f = fixture([[transfer(alice, bob, 1n)]]);
    const events = f.events.map(e => e.name === 'Transfer' ? { ...e, args: { ...e.args, event: 'Fake', emitter: '0x0000000000000000000000000000000000000001' } } : e);
    const item = applyV2Block(undefined, f.header, events, f.row).activity.find(a => a.data.arg_event === 'Fake');
    expect(item?.data).toMatchObject({ source: 'token', event: 'Transfer', emitter: token.toLowerCase(), arg_event: 'Fake',
      arg_emitter: '0x0000000000000000000000000000000000000001' });
  });

  it('the live Rent Free answer (recorded 25 November): refused by the page as stored, accepted as the index writes it now', () => {
    const recorded = JSON.parse(readFileSync(new URL('../fixtures/activity-rent-free-97.json', import.meta.url), 'utf8')) as
      { items: { kind: string; data: Record<string, unknown> }[] };
    const faulty = recorded.items.filter(i => i.kind === 'v2_event' && typeof i.data.source !== 'string');
    expect(faulty.map(i => i.data.event)).toEqual(['ItemFunded', 'ItemFunded']);
    expect(() => parseActivityPageV2(recorded)).toThrow('Invalid activity event');
    const now = { ...recorded, items: recorded.items.map(i => faulty.includes(i) ? { ...i, data: { ...itemFunded(i.data), emitter: i.data.emitter } } : i) };
    const page = parseActivityPageV2(now);
    expect(page.items).toHaveLength(50);
    expect(page.items.filter(i => i.kind === 'v2_event' && i.event === 'ItemFunded').map(i => i.kind === 'v2_event' && i.source)).toEqual(['receiver', 'receiver']);
  });
});

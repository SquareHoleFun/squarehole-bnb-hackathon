/**
 * The v2 service on scripted chains: the gateway source, money audit and repair, listing details, history rows and
 * activity pagination. (Until SH-NO-PICTURE-GATE this file also held the late listing of a box waiting for its
 * pictures; no box waits now, so those cases are gone with the code.)
 */
import { describe, expect, it } from 'vitest';
import { CoreChainIndexer } from '../../src/core/chain-indexer';
import { MemoryHistory } from '../../src/history/memory-history';
import { HistoryWriter } from '../../src/history/writer';
import { World } from './core-synth';
import { requiredV2, serviceBoxV2, serviceChainV2, serviceListingV2, synthManifestV2, boxLogsV2, listingAddedLog, receiverEventV2, V2 } from './scripted-core-chain';
function fixture(end: bigint) {
  const box = serviceBoxV2();
  const world = new World('v2-art');
  world.block(10n); world.block(99n, [listingAddedLog(serviceListingV2())]);
  world.block(100n, [boxLogsV2(box), receiverEventV2(box, 'FitPaid')]);
  world.block(101n, [receiverEventV2(box, 'PlatformPaid')]);
  world.block(102n, [receiverEventV2(box, 'CreatorClaimed', { reason: 1 })]);
  world.to(end);
  return { box, world, chain: serviceChainV2(world, [box]), token: requiredV2(box.record.contracts[1]).toLowerCase() };
}
import { coreGatewaySource } from '../../src/core/core-service';
import { synthBoxV2 } from '../../../chain/src/core/v2/test-support/synth-v2';

it('v2 repair rejects a stale shared-prefix endpoint, then recovers with matching anchors', async () => {
  const { chain, world, token, box } = fixture(105n);
  const staleWorld = world.fork(100n, 'stale'); staleWorld.to(105n); const stale = serviceChainV2(staleWorld, [box]);
  const canonical = chain.rangeLogs.bind(chain);
  const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifestV2() });
  await indexer.start(); expect(indexer.allRows()).toHaveLength(1);
  const entry = requiredV2(indexer.boxesV2.get(token)); const states = entry.states;
  chain.rangeLogs = stale.rangeLogs.bind(stale);
  await expect(indexer.repairBox(entry)).rejects.toThrow(/not on block/); expect(entry.states).toBe(states); expect(entry.repairing).toBe(false);
  chain.rangeLogs = canonical; const before = indexer.v2BoxView(token); await indexer.repairBox(entry); expect(indexer.v2BoxView(token)).toEqual(before);
});

it('the running gateway source serves v2 boxes, listings and activity as decimal strings', async () => {
  const { chain, token } = fixture(105n);
  const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifestV2() }); await indexer.start();
  const { source, updated } = coreGatewaySource(indexer, chain, null, 60_000, () => 1_000); updated();
  expect(source.v2Feed?.().cards).toHaveLength(1);
  expect(source.v2Box?.(token)).not.toHaveProperty('ledgers');
  expect(source.v2Listings?.(V2.registry)?.listings).toHaveLength(1);
  expect((await source.activity(token, { kind: null, before: null, limit: 100 }))?.items).toHaveLength(3);
});

import { CORE_EVENTS_V2 } from '../../src/core/v2/chain-v2';

it('CQ11-E: replacement v2 money audit', async () => {
  const { chain, token } = fixture(105n);
  const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifestV2(), auditEvery: 10_000 });
  await indexer.start();
  const entry = requiredV2(indexer.boxesV2.get(token));
  const last = requiredV2(entry.states.at(-1));
  entry.states[entry.states.length - 1] = { ...last, supply: 99n };
  const results = await indexer.audit();
  expect(results.map((r) => r.result.ok)).toEqual([false, true]);
  expect(indexer.metrics.boxRepairs).toBe(1);
  expect(indexer.v2BoxView(token)).toMatchObject({ supply: '0', verified: true });
  expect(indexer.v2FeedView().platform[0]).toMatchObject({ paidByToken: { [serviceListingV2().token.toLowerCase()]: '100' } });
});

it('CQ11-0 removes snapshot events from the listing service filter', () => {
  expect(CORE_EVENTS_V2.listingRegistry).toContain('RaiseUpdated');
  expect(CORE_EVENTS_V2.listingRegistry).not.toContain('V2Snapshot');
});

import { eventV2 } from './scripted-core-chain';
import { ZERO } from '../../../chain/src/core/v2/test-support/synth-v2';

it('v2 history preserves T balances, consecutive item mints, transfers and user-only candle volume', async () => {
  const box = serviceBoxV2(); const token = requiredV2(box.record.contracts[1]);
  const world = new World('v2-history'); world.block(10n); world.block(99n, [listingAddedLog(serviceListingV2())]);
  world.block(100n, [boxLogsV2(box),
    eventV2('token', 'Transfer', token, { from: ZERO, to: box.record.creator, amount: 1_000n }),
    eventV2('collection', 'ConsecutiveTransfer', requiredV2(box.record.contracts[4]), { fromTokenId: 1n, toTokenId: 3n, fromAddress: ZERO, toAddress: box.record.contracts[3] }),
    receiverEventV2(box, 'FitPaid'),
  ]);
  const swap = (sender: string) => eventV2('poolManager', 'Swap', V2.poolManager, { id: box.record.poolId, sender, amount0: -10n, amount1: 20n, sqrtPriceX96: 2n ** 96n, liquidity: 1_000n, tick: 0, fee: 10_000 });
  world.block(101n, [eventV2('token', 'Transfer', token, { from: box.record.creator, to: V2.weth, amount: 100n }), eventV2('collection', 'Transfer', requiredV2(box.record.contracts[4]), { from: box.record.contracts[3], to: box.record.creator, tokenId: 3n }), swap(requiredV2(box.record.contracts[2])), swap(box.record.creator)]);
  world.to(200n);
  {
    const store = new MemoryHistory(); const writer = new HistoryWriter(store);
    const indexer = new CoreChainIndexer({ reader: serviceChainV2(world, [box]), manifest: synthManifestV2(), auditEvery: 10_000, onHistory: writer.accept });
    await indexer.start(); await writer.flush();
    const dump = await store.dump(V2.chainId);
    expect(dump.transfers).toHaveLength(6);
    expect(dump.items).toHaveLength(3);
    expect(dump.transfers.map((r) => JSON.parse(r) as { asset: string; amount: string }).filter((r) => r.asset === 'item').every((r) => r.amount === '1')).toBe(true);
    expect(indexer.recent(token)?.trades.map((t) => t.route)).toEqual(['hook', 'other']);
    const candles = await store.candles(V2.chainId, token.toLowerCase(), '1h');
    expect(candles[0]?.trades).toBe(1);
    expect(indexer.v2BoxView(token)?.supply).toBe('1000');
  }
});

it('failed range validation does not leave a v2 row behind; the next head lists the box', async () => {
  const { chain } = fixture(200n);
  const byHash = chain.headerByHash.bind(chain);
  chain.headerByHash = async (hash) => hash === chain.header(100n).hash ? null : byHash(hash);
  const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifestV2() });
  await indexer.start(); expect(indexer.allRows()).toEqual([]);
  chain.headerByHash = byHash; await indexer.enqueue(chain.header(200n)); expect(indexer.allRows()).toHaveLength(1);
  expect(indexer.v2FeedView().cards).toHaveLength(1);
  expect(indexer.listingsV2(V2.registry).listings).toHaveLength(1);
});

it('v2 listing details exposed by the gateway use the canonical listing record and its decimals', async () => {
  const { chain } = fixture(105n); const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifestV2(), auditEvery: 10_000 }); await indexer.start();
  expect(indexer.v2ListingsView(V2.registry)?.listings[0]).toMatchObject({ id: 7, detail: { decimals: 6, token: serviceListingV2().token, raise: serviceListingV2().raise.toString() } });
});

it('v2 repair retains a valid empty box and rejects a mismatched header number', async () => {
  const box = synthBoxV2({ boxId: 1n }); const world = new World('v2-empty'); world.block(10n); world.block(100n, [boxLogsV2(box)]); world.to(105n);
  const chain = serviceChainV2(world, [box]); const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifestV2(), auditEvery: 10_000 }); await indexer.start();
  const entry = requiredV2(indexer.boxesV2.get(requiredV2(box.record.contracts[1]).toLowerCase()));
  const before = indexer.v2BoxView(requiredV2(box.record.contracts[1])); expect(before).not.toBeNull();
  await indexer.repairBox(entry); expect(indexer.v2BoxView(requiredV2(box.record.contracts[1]))).toEqual(before);
  const numbered = chain.headerByNumber.bind(chain);
  chain.headerByNumber = async (n) => n === 100n ? { ...chain.header(100n), number: 101n } : numbered(n);
  await expect(indexer.repairBox(entry)).rejects.toThrow(/header|branch/);
  expect(indexer.v2BoxView(requiredV2(box.record.contracts[1]))).toEqual(before);
});

it('v2 history keeps launch-router tax and buyer attribution in trade history', async () => {
  const box = serviceBoxV2(); const token = requiredV2(box.record.contracts[1]);
  const router = requiredV2(box.record.contracts[6]);
  const world = new World('v2-tax'); world.block(10n); world.block(99n, [listingAddedLog(serviceListingV2())]); world.block(100n, [boxLogsV2(box)]);
  world.block(101n, [[
    eventV2('poolManager', 'Swap', V2.poolManager, { id: box.record.poolId, sender: router, amount0: 20n, amount1: -10n, sqrtPriceX96: 2n ** 96n, liquidity: 1_000n, tick: 0, fee: 10_000 }),
    eventV2('launchRouter', 'TaxedBuy', router, { buyer: box.record.creator, recipient: box.record.creator, step: 1n, qIn: 10n, tax: 7n, tokensOut: 20n, refund: 0n }),
  ]]); world.to(105n);
  const store = new MemoryHistory(); const writer = new HistoryWriter(store);
  const indexer = new CoreChainIndexer({ reader: serviceChainV2(world, [box]), manifest: synthManifestV2(), auditEvery: 10_000, onHistory: writer.accept }); await indexer.start();
  await writer.flush();
  expect(indexer.recent(token)?.trades[0]).toMatchObject({ route: 'launch_router', taxQ: 7n, trader: box.record.creator.toLowerCase() });
  expect((await store.dump(V2.chainId)).trades.map((r) => JSON.parse(r) as { taxQ: string }).map((r) => r.taxQ)).toEqual(['7']);
});

describe('v2 mixed activity pagination', () => {
  for (const mixed of [false, true]) {
    it.each([
      { persisted: false }, { persisted: true },
    ])(`${mixed ? 'mixed logs after range backfill' : 'single swap in short tail'}: persisted=$persisted`, async ({ persisted }) => {
      const box = serviceBoxV2();
      const token = requiredV2(box.record.contracts[1]).toLowerCase();
      const swap = (amount0 = 200n, amount1 = -100n) => eventV2('poolManager', 'Swap', V2.poolManager, {
        id: box.record.poolId, sender: box.record.creator, amount0, amount1,
        sqrtPriceX96: 2n ** 96n, liquidity: 1_000n, tick: 0, fee: 10_000,
      });
      const world = new World('v2-pagination');
      world.block(10n); world.block(99n, [listingAddedLog(serviceListingV2())]);
      world.block(100n, [boxLogsV2(box)]);
      world.block(101n, mixed ? [swap(), receiverEventV2(box, 'CreatorClaimed', { reason: 1 }), swap(0n, 0n), swap(-400n, 200n)] : [swap()]);
      if (mixed) world.block(102n, [receiverEventV2(box, 'FitPaid')]);
      world.to(mixed ? 200n : 105n);
      const reader = serviceChainV2(world, [box]);
      const store = new MemoryHistory(); const writer = new HistoryWriter(store);
      const indexer = new CoreChainIndexer({
        reader, manifest: synthManifestV2(), auditEvery: 10_000,
        onHistory: persisted ? writer.accept : undefined,
      });
      try {
        await indexer.start();
        await indexer.idle(); await writer.flush();
        expect(indexer.metrics.errors).toBe(0);
        const { source } = coreGatewaySource(indexer, reader, persisted ? store : null, 60_000);
        for (const kind of [null, 'trade', 'v2_event']) {
          const whole = await source.activity(token, { kind, before: null, limit: 100 });
          if (!whole) throw new Error('admitted v2 box has no activity page');
          for (const limit of [1, 2, 3]) {
            const paged: typeof whole.items[number][] = [];
            const cursors = new Set<string>();
            let before: string | null = null;
            for (let pageNumber = 0; pageNumber <= whole.items.length; pageNumber++) {
              const page = await source.activity(token, { kind, before, limit });
              if (!page) throw new Error('admitted v2 box lost its activity page');
              paged.push(...page.items);
              before = page.next;
              if (before === null) break;
              expect(cursors.has(before)).toBe(false);
              cursors.add(before);
            }
            expect(before).toBeNull();
            expect(paged).toEqual(whole.items);
          }
          const expectedKinds = mixed ? ['v2_event', 'trade', 'v2_event', 'v2_event', 'trade'] : ['trade'];
          expect(whole.items.map((item) => item.kind)).toEqual(expectedKinds.filter((k) => kind === null || k === kind));
          expect(new Set(whole.items.map((item) => item.id)).size).toBe(whole.items.length);
          if (kind === 'trade') expect(whole.items.map((item) => item.kind === 'trade' && [item.qRaw, item.tRaw])).toEqual(mixed ? [[400n, 200n], [200n, 100n]] : [[200n, 100n]]);
          if (kind === 'v2_event' && mixed) expect(whole.items.map((item) => item.kind === 'v2_event' && item.data['event'])).toEqual(['FitPaid', 'Swap', 'CreatorClaimed']);
        }
      } finally {
        indexer.stop(); writer.stop();
      }
    });
  }
});

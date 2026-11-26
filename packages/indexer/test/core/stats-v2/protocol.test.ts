import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import recorded from './recorded.json';
import { CoreChainIndexer, type BoxEntryV2 } from '../../../src/core/chain-indexer';
import { CoreGateway } from '../../../src/core/core-gateway';
import { coreGatewaySource } from '../../../src/core/core-service';
import { jsonV2, type BoxRowV2 } from '../../../src/core/core-row';
import { rowsFromV2Logs } from '../../../src/core/v2/discovery-v2';
import { decodeV2Logs, routeV2 } from '../../../src/core/v2/events-v2';
import { protocolTotalsV2 } from '../../../src/core/v2/protocol-stats-v2';
import { m2Fixture } from '../../../src/core/v2/m2-fixture.test-support';
import { applyV2Block, type FeeChoiceV2, type LiveStateV2 } from '../../../src/core/v2/views-v2';
import { World } from '../core-synth';
import { boxLogsV2, eventV2, listingAddedLog, requiredV2, serviceBoxV2, serviceChainV2, serviceListingV2, synthManifestV2, V2 } from '../scripted-core-chain';

const zero = '0x0000000000000000000000000000000000000000' as Address;
const testCoin = '0x0000000000000000000000000000000000001234' as Address;
const hash = (n: bigint): Hex => keccak256(toHex(n));
const manifest = synthManifestV2();
const release = requiredV2(manifest.releases[0]);
const box = serviceBoxV2();
const part = (i: number) => requiredV2(box.record.contracts[i]);
const alice = box.record.creator;
const swap = (p: bigint, sender = alice) => eventV2('poolManager', 'Swap', V2.poolManager, {
  id: box.record.poolId, sender, amount0: -p, amount1: 10n, sqrtPriceX96: 1n << 96n, liquidity: 1000n, tick: 0, fee: 10000,
});
const collected = (buyersP: bigint, sellersP: bigint) => eventV2('receiver', 'Collected', part(5), {
  caller: alice, tipTo: alice, buyersP, sellersP, qToReserve: 77n, tip: 3n,
});
const transfer = (from: Address, to: Address, amount: bigint) => eventV2('token', 'Transfer', part(1), { from, to, amount });

function fixture() {
  const world = new World('ta60');
  world.block(10n);
  world.block(100n, [listingAddedLog(serviceListingV2()), boxLogsV2(box), [transfer(zero, alice, 10n ** 27n)]]);
  const row = requiredV2(rowsFromV2Logs(world.logs, release, V2.chainId)[0]);
  const route = routeV2(release, manifest, [], [box.record]);
  function fold(previous?: LiveStateV2) {
    const header = requiredV2(world.headers.at(-1));
    const events = decodeV2Logs(world.logs.filter(l => l.blockNumber === header.number), route);
    // Simulate overlapping log queries, and deliberately reverse delivery order.
    return applyV2Block(previous, header, [...events].reverse().concat(events), row).state;
  }
  return { world, row, fold };
}
function entry(row: BoxRowV2, state?: LiveStateV2): BoxEntryV2 {
  return { version: 2, row, route: routeV2(row.release, manifest, [], [row.record]), verdict: { classification: 'shown', reason: null },
    states: state ? [state] : [], verified: true, audit: null, repairing: false, trades: [], activity: [] };
}
const totals = (rows: readonly BoxRowV2[], entries: readonly BoxEntryV2[]) => jsonV2(protocolTotalsV2(rows, entries));

async function request(gateway: CoreGateway, url: string, method = 'GET') {
  const res = { status: 0, headers: {} as Record<string, string>, body: '',
    writeHead(status: number, headers: Record<string, string>) { this.status = status; this.headers = headers; },
    end(body = '') { this.body = body; } };
  await gateway.route({ method, url } as IncomingMessage, res as unknown as ServerResponse);
  return res;
}

describe('TA60 protocol totals', () => {
  it('counts item movements and draw stages once, without counting reservations, summaries or transfers', () => {
    const f = fixture(); const initial = f.fold();
    const accounting = { principal: 11n, fee: 1n, supplyAfter: 1000n, escrowAfter: 12n, insideAfter: 20n };
    f.world.block(101n, [[
      eventV2('vault', 'Withdrawn', part(3), { owner: alice, ids: [1n, 2n, 3n], ...accounting }),
      eventV2('vault', 'Returned', part(3), { owner: alice, ids: [1n, 2n], ...accounting }),
      eventV2('vault', 'TicketsOpened', part(3), { count: 7n, ...accounting, hiddenAfter: 10n, ticketsAfter: 7n }),
      eventV2('vault', 'TicketDelivered', part(3), { id: 4n, to: alice, requestedAt: 9n, ticketsAfter: 6n }),
      eventV2('tickets', 'DrawRequested', part(7), { ticketId: 1n, drawer: alice, principal: 11n, fee: 1n, round: 8n, bounty: 0n }),
      eventV2('tickets', 'DrawRequested', part(7), { ticketId: 2n, drawer: alice, principal: 11n, fee: 1n, round: 8n, bounty: 0n }),
      eventV2('tickets', 'DrawSettled', part(7), { ticketId: 1n, itemId: 4n, word: hash(42n) }),
      eventV2('tickets', 'TicketCancelled', part(7), { ticketId: 2n, drawer: alice, principal: 11n }),
      eventV2('tickets', 'TakenByNumber', part(7), { taker: alice, itemId: 4n, principal: 11n, fee: 1n, revealed: true }),
      eventV2('vault', 'ReleasedToCreator', part(3), { creator: alice, ids: [5n, 6n] }),
      transfer(alice, zero, 900719925474099312345n),
      eventV2('receiver', 'BoughtBack', part(5), { pSpent: 10n, tBought: 99n, tBurned: 99n, tip: 0n }),
      ...Array.from({ length: 601 }, () => swap(3n)), swap(999n, part(2)), collected(150n, 300n),
    ]]);
    const state = f.fold(initial);
    const got = totals([f.row], [entry(f.row, state)]);
    expect(got).toMatchObject({ boxesMade: '1', boxesGraduated: '0', boxesFailed: '0', tokensBurned: '900719925474099312345',
      itemsTakenOut: '4', itemsReturned: '2', drawsRequested: '2', drawsSettled: '1',
      coverage: { boxesIndexed: '1', boxesMissing: '0', complete: true },
      priceCoins: [{ priceCoin: f.row.q.toLowerCase(), volumeP: '1803', collectedFeesP: '450' }] });
    expect(totals([f.row], [entry(f.row, f.fold(state))])).toEqual(got);
    expect(totals([f.row], [entry(f.row, initial)])).toMatchObject({ itemsTakenOut: '0', tokensBurned: '0' });
  });

  it('groups collected fees by frozen choice and price asset, folds T payout variants, and keeps legacy choices explicit', () => {
    const f = fixture(); const initial = f.fold(); f.world.block(101n, [[collected(900719925474099312345n, 7n)]]);
    const base = f.fold(initial);
    const choices: (FeeChoiceV2 | null)[] = ['burn', 'holders', 'holders-t', 'items', 'items-t', 'eat', 'pile', 'shop', 'module', 'keep', 'grow', null];
    const rows = choices.map((_, i) => ({ ...f.row, q: zero, boxId: BigInt(i + 1) }));
    const entries = rows.map((row, i) => entry(row, { ...base, view: { ...base.view,
      choices: { buyers: choices[i] ?? null, sellers: choices[i] ?? null } } }));
    const otherRow = { ...f.row, registry: testCoin, q: testCoin, pDecimals: 6 };
    const other = entry(otherRow, { ...base, view: { ...base.view, graduated: true, choices: { buyers: 'burn', sellers: 'burn' } },
      volumeQ: 17n, p: testCoin, pDecimals: 6 });
    const got = totals([...rows, otherRow], [...entries, other]);
    const amount = '900719925474099312352';
    expect(got.priceCoins).toEqual([
      { priceCoin: zero, decimals: '18', volumeP: '0', collectedFeesP: '10808639105689191748224',
        feesByChoiceP: { burn: amount, holders: '1801439850948198624704', items: '1801439850948198624704', eat: amount,
          pile: amount, shop: amount, module: amount, keep: amount, grow: amount, unclassified: amount } },
      { priceCoin: testCoin, decimals: '6', volumeP: '17', collectedFeesP: amount,
        feesByChoiceP: { burn: amount, holders: '0', items: '0', eat: '0', pile: '0', shop: '0', module: '0', keep: '0', grow: '0', unclassified: '0' } },
    ]);
    expect(got.boxesGraduated).toBe('1');
  });

  it('retains lifetime shop movements beyond 500 details and ignores a foreign emitter', () => {
    const f = m2Fixture(); const world = new World('ta60-shop');
    const pick = eventV2('vault', 'Picked', f.at(3), { collection: testCoin, id: 1n, to: alice, amountT: 2n });
    world.block(101n, [[...Array.from({ length: 601 }, () => pick),
      { ...pick, address: testCoin },
      eventV2('vault', 'Given', f.at(3), { collection: testCoin, id: 1n, giver: alice, amountT: 1n }),
      eventV2('vault', 'StarterLoaded', f.at(3), { index: 0n, collection: testCoin, id: 1n }),
      eventV2('vault', 'StarterReturned', f.at(3), { index: 0n, collection: testCoin, id: 1n }),
    ]]);
    const route = routeV2(f.release, f.manifest, [], [f.record]);
    const state = applyV2Block(undefined, requiredV2(world.headers.at(-1)), decodeV2Logs(world.logs, route), f.row).state;
    expect(totals([f.row], [entry(f.row, state)])).toMatchObject({ itemsTakenOut: '601', itemsReturned: '1' });
  });

  it('reports missing or old snapshots and unverified/repairing boxes instead of implying complete coverage', () => {
    const f = fixture(); const state = f.fold();
    const missing = { ...f.row, boxId: 999n };
    const old = { ...state, protocolActivity: undefined };
    expect(totals([f.row, missing], [entry(f.row, old)])).toMatchObject({ boxesMade: '2',
      coverage: { boxesIndexed: '0', boxesMissing: '2', complete: false } });
    f.world.block(101n, [[collected(1n, 2n)]]);
    expect(totals([f.row], [entry(f.row, f.fold(old))]).coverage.complete).toBe(false);
    expect(totals([f.row], [{ ...entry(f.row, state), verified: false, repairing: true }])).toMatchObject({ verified: false, stale: true });
    expect(totals([f.row], [{ ...entry(f.row, state), verified: null }]).verified).toBeNull();
    expect(totals([], [])).toMatchObject({ boxesMade: '0', priceCoins: [], tokensBurned: '0' });
  });

  it('serves cacheable chain-scoped JSON without listeners, keeps the feed unchanged, and marks stalled data stale', async () => {
    const f = fixture(); f.world.to(102n);
    const chain = serviceChainV2(f.world, [box]);
    const indexer = new CoreChainIndexer({ reader: chain, manifest, auditEvery: 10000 });
    let now = 10;
    const service = coreGatewaySource(indexer, chain, null, 100, () => now);
    const gateway = new CoreGateway({ source: service.source, host: '127.0.0.1', port: 5391 });
    expect(JSON.parse((await request(gateway, '/v2/stats')).body)).toMatchObject({ asOf: null, stale: true, boxesMade: '0', coverage: { complete: false } });
    await indexer.start(); await indexer.idle(); service.updated();
    const before = JSON.stringify(indexer.v2FeedView());
    const calls = chain.calls;
    const res = await request(gateway, `/v2/stats?chain=${V2.chainId}`);
    expect(res.status).toBe(200);
    expect(res.headers).toMatchObject({ 'Cache-Control': 'public, max-age=1', 'Access-Control-Allow-Origin': '*' });
    expect(JSON.parse(res.body)).toMatchObject({ schema: 'sh.core-stats.v2', chainId: V2.chainId, asOf: indexer.asOf(),
      boxesMade: '1', stale: false, coverage: { complete: true } });
    expect(chain.calls).toBe(calls);
    expect(JSON.stringify(indexer.v2FeedView())).toBe(before);
    expect(indexer.v2FeedView().schema).toBe('sh.core-feed.v2');
    now = 111;
    expect(JSON.parse((await request(gateway, '/v2/stats')).body).stale).toBe(true);
    expect((await request(gateway, '/v2/stats?chain=1')).status).toBe(404);
    expect((await request(gateway, '/v2/stats/extra')).status).toBe(404);
    expect((await request(gateway, '/v1/stats')).status).toBe(404);
    expect((await request(gateway, '/v2/stats', 'POST')).status).toBe(405);
    expect((await request(gateway, '/v2/stats', 'OPTIONS')).status).toBe(204);
    const absent = new CoreGateway({ source: { ...service.source, v2Stats: undefined }, host: '127.0.0.1', port: 5391 });
    expect((await request(absent, '/v2/stats')).status).toBe(404);
    await indexer.stop();
  });

  it.each(['cold startup', 'catch-up from 102'] as const)('publishes only creations at or below the head during %s', async (start) => {
    const f = fixture();
    const second = serviceBoxV2(8n, 150n);
    const secondToken = requiredV2(second.record.contracts[1]);
    f.world.block(110n, [[swap(13n), collected(15n, 30n), transfer(alice, zero, 7n)]]);
    f.world.block(150n, [boxLogsV2(second), [
      eventV2('token', 'Transfer', secondToken, { from: zero, to: alice, amount: 100n }),
      eventV2('token', 'Transfer', secondToken, { from: alice, to: zero, amount: 11n }),
      eventV2('receiver', 'Collected', requiredV2(second.record.contracts[5]), {
        caller: alice, tipTo: alice, buyersP: 5n, sellersP: 10n, qToReserve: 0n, tip: 0n,
      }),
      eventV2('coordinator', 'BoxFailed', requiredV2(second.record.contracts[0]), { cause: 3, caller: alice, timestamp: 1800001800n }),
    ]]);
    f.world.to(200n);
    const chain = serviceChainV2(f.world, [box, second]);
    const indexer = new CoreChainIndexer({ reader: chain, manifest, auditEvery: 10000 });
    const service = coreGatewaySource(indexer, chain, null, 100, () => 10);
    const gateway = new CoreGateway({ source: service.source, host: '127.0.0.1', port: 5391 });
    try {
      if (start === 'catch-up from 102') {
        chain.tip = 102n;
        await indexer.start(); await indexer.idle();
        expect(indexer.v2StatsView()).toMatchObject({ asOf: { block: '102' }, boxesMade: '1' });
      }
      const samples = new Map<string, Awaited<ReturnType<typeof request>>>();
      const headerByNumber = chain.headerByNumber.bind(chain);
      chain.headerByNumber = async (number) => {
        const head = indexer.asOf()?.block ?? 'none';
        // Range discovery has inserted both rows; pause on the canonical read before publishing the next block.
        if (indexer.allRows().length === 2 && ['none', '110', '150'].includes(head)) {
          samples.set(head, await request(gateway, '/v2/stats'));
        }
        return headerByNumber(number);
      };
      chain.tip = 200n;
      if (start === 'cold startup') await indexer.start();
      else await indexer.enqueue(chain.header(200n));
      await indexer.idle();

      if (start === 'cold startup') {
        const beforeHead = requiredV2(samples.get('none'));
        expect(beforeHead.status).toBe(200);
        expect(JSON.parse(beforeHead.body)).toMatchObject({ asOf: null, boxesMade: '0', boxesFailed: '0',
          tokensBurned: '0', priceCoins: [], stale: true,
          coverage: { boxesIndexed: '0', boxesMissing: '0', complete: false } });
      }
      const beforeCreation = requiredV2(samples.get('110'));
      expect(beforeCreation.status).toBe(200);
      expect(JSON.parse(beforeCreation.body)).toMatchObject({ asOf: { block: '110' }, boxesMade: '1', boxesFailed: '0',
        tokensBurned: '7', priceCoins: [{ volumeP: '13', collectedFeesP: '45' }],
        coverage: { boxesIndexed: '1', boxesMissing: '0', complete: true } });
      const afterCreation = requiredV2(samples.get('150'));
      expect(afterCreation.status).toBe(200);
      const published = { boxesMade: '2', boxesFailed: '1', tokensBurned: '18',
        priceCoins: [{ volumeP: '13', collectedFeesP: '60' }],
        coverage: { boxesIndexed: '2', boxesMissing: '0', complete: true } };
      expect(JSON.parse(afterCreation.body)).toMatchObject({ asOf: { block: '150' }, ...published });
      expect(indexer.v2StatsView()).toMatchObject({ asOf: { block: '200' }, ...published });
    } finally {
      indexer.stop();
    }
  });

  it('rewinds lifecycle, creation, fees, burns and volume, agrees with rebuild, and advances time on empty heads', async () => {
    const f = fixture();
    const second = serviceBoxV2(8n, 101n);
    f.world.block(101n, [boxLogsV2(second), [swap(13n), collected(15n, 30n), transfer(alice, zero, 7n),
      eventV2('coordinator', 'BoxFailed', part(0), { cause: 3, caller: alice, timestamp: 1800001212n })]]);
    f.world.to(105n);
    const chain = serviceChainV2(f.world, [box, second]);
    const indexer = new CoreChainIndexer({ reader: chain, manifest, auditEvery: 10000 });
    await indexer.start(); await indexer.idle();
    expect(indexer.v2StatsView()).toMatchObject({ boxesMade: '2', boxesFailed: '1', tokensBurned: '7', priceCoins: [{ volumeP: '13', collectedFeesP: '45' }] });
    const canonical = f.world.fork(100n, 'ta60-canonical');
    canonical.block(101n, [[swap(19n), eventV2('hook', 'MigratedV2', part(2), { poolId: box.record.poolId, liquidity: 5n, qLeft: 0n, tBurned: 9n }),
      eventV2('coordinator', 'Graduated', part(0), { caller: alice, blockNumber: 101n, poolShare: 10n, tokenDustBurned: 9n, reward: 0n })]]);
    canonical.to(106n);
    chain.setBranch(canonical.headers.filter(h => h.number > 100n), canonical.logs.filter(l => l.blockNumber > 100n));
    await indexer.enqueue(chain.header(106n)); await indexer.idle();
    expect(indexer.v2StatsView()).toMatchObject({ boxesMade: '1', boxesFailed: '0', boxesGraduated: '1', tokensBurned: '0', priceCoins: [{ volumeP: '19', collectedFeesP: '0' }] });
    const rebuilt = new CoreChainIndexer({ reader: serviceChainV2(canonical, [box]), manifest, auditEvery: 10000 });
    await rebuilt.start(); await rebuilt.idle();
    expect(indexer.v2StatsView()).toEqual(rebuilt.v2StatsView());
    expect(indexer.v2StatsView().asOf?.timestamp).toBe(chain.header(106n).timestamp.toString());
    await indexer.stop(); await rebuilt.stop();
  });
});

for (const [name, life] of Object.entries(recorded)) it(`TA60 replays recorded ${name} receipts, deduplicates logs and preserves exact lifetime amounts`, () => {
  const recordedRelease = { ...release, registry: { address: life.wiring.registry as Address, codeHash: hash(0n) },
    listingRegistry: { address: life.wiring.listingRegistry as Address, codeHash: hash(0n) } };
  const recordedManifest = { ...manifest, releases: [recordedRelease], chain: { ...manifest.chain,
    poolManager: { address: life.wiring.poolManager as Address, codeHash: hash(0n) } } };
  const stages = ['launch', 'buy', 'sell', 'filled', 'graduated', 'poolBuy', 'poolSellBurn'] as const;
  const logs = (stage: typeof stages[number], number: bigint) => life[stage].map((l, logIndex) => ({ address: l.emitter as Address,
    topics: l.topics as Hex[], data: l.data as Hex, blockNumber: number, blockHash: hash(number), transactionHash: hash(number + 1000n), transactionIndex: 0, logIndex }));
  const row = requiredV2(rowsFromV2Logs(logs('launch', 100n), recordedRelease, manifest.chainId)[0]);
  row.pDecimals = name === 'sixDecimals' ? 6 : 18;
  const route = routeV2(recordedRelease, recordedManifest, [], [row.record]);
  let state: LiveStateV2 | undefined;
  let number = 100n;
  for (const stage of stages) {
    const timestamp = BigInt(life[`${stage}State`].timestamp);
    const events = decodeV2Logs(logs(stage, number).concat(logs(stage, number)), route);
    state = applyV2Block(state, { number, hash: hash(number), parentHash: hash(number - 1n), timestamp }, events, row).state;
    const got = totals([row], [entry(row, state)]);
    expect(got).toMatchObject({ boxesMade: '1', boxesGraduated: number >= 104n ? '1' : '0', boxesFailed: '0',
      tokensBurned: life.expected[stage].burnedT, itemsTakenOut: '0', itemsReturned: '0', drawsRequested: '0', drawsSettled: '0',
      priceCoins: [{ priceCoin: row.q.toLowerCase(), volumeP: life.expected[stage].volume24hP, collectedFeesP: '0' }] });
    number += 1n;
  }
});

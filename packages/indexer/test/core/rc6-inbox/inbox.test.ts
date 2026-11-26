import { describe, expect, it, vi } from 'vitest';
import baseline from './service-baseline.json';
import type { LogFilter } from '../../../src/core/core-reader';
import { decodeFunctionData, encodeFunctionResult, zeroAddress, type Abi, type Address, type Hex } from 'viem';
import recorded from './recorded.json';
import { m2Fixture, H } from '../../../src/core/v2/m2-fixture.test-support';
import { routeV2, decodeV2Logs } from '../../../src/core/v2/events-v2';
import { applyV2Block, liveViewV2, boxViewV2, boxViewContextV2 } from '../../../src/core/v2/views-v2';
import { readMoneyV2 } from '../../../src/core/v2/money-v2';
import { coordinatorV2Abi, royaltyRouterV2Abi, receiverV2Abi, hookV2Abi, listingRegistryV2Abi } from '../../../src/core/v2/chain-v2';
import { boxTokenAbi, poolManagerAbi } from '@squarehole/chain/abi';
import { jsonV2 } from '../../../src/core/core-row';
import type { RawLog } from '../../../src/events';
import { CoreChainIndexer, type HistoryMessage } from '../../../src/core/chain-indexer';
import { World } from '../core-synth';
import { boxLogsV2, serviceBoxV2, serviceChainV2, synthManifestV2, listingAddedLog, serviceListingV2 } from '../scripted-core-chain';

const wiring = recorded.wiring as Record<keyof typeof recorded.wiring, Address>;
const lower = (s: string) => s.toLowerCase();
const header = (n: bigint) => ({ number: n, hash: H(Number(n)), parentHash: H(Number(n - 1n)), timestamp: n === 101n ? 1_000_000n : 1_000_100n });
function raw(logs: typeof recorded.refreshLogs, n = 101n): RawLog[] {
  return logs.map((log, logIndex) => ({ address: log.emitter as Address, topics: log.topics as Hex[], data: log.data as Hex,
    blockNumber: n, blockHash: header(n).hash, transactionHash: H(500), transactionIndex: 0, logIndex, removed: false }));
}

export function fixture() {
  const f = m2Fixture(false);
  const contracts = [...f.record.contracts]; contracts[8] = wiring.router;
  const record = { ...f.record, contracts };
  const row = { ...f.row, record, contracts: { ...f.row.contracts, royaltyRouter: wiring.router }, inbox: wiring };
  const ctx = { ...boxViewContextV2(record, f.spec, 6), spec: undefined, choices: { buyers: 'keep', sellers: 'burn' } as const };
  const route = routeV2(f.release, f.manifest, [], [record], [], [{ boxId: row.boxId, ...wiring }]);
  return { ...f, record, row, ctx, route };
}

export function readerFor(f: ReturnType<typeof fixture>, snapshot = recorded.registered) {
  const reads: string[] = [];
  const callAt = async (to: Address, data: Hex, hash: Hex): Promise<Hex> => {
    reads.push(hash);
    const abi: Abi = lower(to) === lower(wiring.router) ? royaltyRouterV2Abi
      : to === f.release.listingRegistry.address ? listingRegistryV2Abi
      : to === f.row.poolManager ? poolManagerAbi
      : to === f.at(0) ? coordinatorV2Abi : to === f.at(1) ? boxTokenAbi
      : to === f.at(2) ? hookV2Abi : receiverV2Abi;
    const { functionName, args } = decodeFunctionData({ abi, data });
    const coin = String(args?.[0]).toLowerCase();
    let result: unknown;
    if (abi === royaltyRouterV2Abi) {
      const values: Record<string, unknown> = { weth: wiring.weth, cowHandler: wiring.handler, settlement: wiring.settlement,
        listingRegistry: f.release.listingRegistry.address, listVersion: 1n, lotSize: coin === lower(wiring.other) ? BigInt(snapshot.lot) : 0n,
        heldBalance: coin === lower(wiring.other) ? BigInt(snapshot.balance) : 0n,
        oldestUnsoldAt: coin === lower(wiring.other) ? BigInt(snapshot.oldestUnsoldAt) : 0n,
        orderRegistered: coin === lower(wiring.other) && snapshot.registered };
      result = values[functionName];
    } else if (abi === listingRegistryV2Abi) result = functionName === 'sellableCount' ? 1n : wiring.other;
    const fn = abi.find(item => item.type === 'function' && item.name === functionName);
    if (!fn || fn.type !== 'function') throw new Error('unexpected read');
    if (result === undefined) {
      const defaults = fn.outputs.map(o => o.type === 'bool' ? false : o.type === 'address' ? f.at(5) : o.type === 'bytes32' ? H(0) : 0n);
      result = defaults.length === 1 ? defaults[0] : defaults;
    }
    return encodeFunctionResult({ abi, functionName, result } as never);
  };
  return { callAt, reads };
}

describe('RC6-I1 recorded per-coin inbox money', () => {
  it('maps refresh IDs to coins while an unregistered coin and silent deposits remain readable', async () => {
    const f = fixture();
    const view = boxViewV2(decodeV2Logs(raw(recorded.refreshLogs), f.route), f.ctx, undefined, 1_000_000n);
    const r = readerFor(f);
    const money = jsonV2(await readMoneyV2(r, f.row, view, 101n, H(101)));
    expect(money.royalty?.coins?.find(c => lower(c.coin) === lower(wiring.other))).toMatchObject({
      lot: recorded.registered.lot, balance: recorded.registered.balance, registered: true, oldestUnsoldAt: '1000000',
      lastRefresh: { balance: recorded.registered.balance, oldestUnsoldAt: '1000000' }, lastSale: null,
    });
    const before = jsonV2(await readMoneyV2(readerFor(f, recorded.unregistered), f.row, boxViewV2([], f.ctx), 100n, H(100)));
    expect(before.royalty?.coins?.find(c => lower(c.coin) === lower(wiring.other))).toMatchObject({ registered: false, balance: recorded.unregistered.balance, lastSale: null });
    expect(new Set(r.reads)).toEqual(new Set([H(101)]));
  });

  it('keeps actual settlement sales apart from refresh clocks and in-kind exits, with canonical replay', async () => {
    const f = fixture();
    const first = applyV2Block(undefined, header(101n), decodeV2Logs(raw(recorded.refreshLogs), f.route), f.row).state;
    const logs = raw(recorded.saleLogs, 102n);
    const events = decodeV2Logs([...logs, ...logs], f.route);
    const second = applyV2Block(first, header(102n), events, f.row).state;
    const money = jsonV2(await readMoneyV2(readerFor(f, recorded.afterSale), f.row, second.view, 102n, H(102)));
    expect(money.royalty?.coins?.find(c => lower(c.coin) === lower(wiring.other))).toMatchObject({
      balance: recorded.afterSale.balance, oldestUnsoldAt: '1000100',
      lastSale: { sellAmount: '100000000', buyAmount: '77', feeAmount: '0', orderUid: '0xaabb', at: '1000100' },
    });
    const after = applyV2Block(second, header(103n), decodeV2Logs(raw(recorded.inKindLogs, 103n), f.route), f.row).state;
    const afterMoney = jsonV2(await readMoneyV2(readerFor(f, recorded.afterInKind), f.row, after.view, 103n, H(103)));
    expect(afterMoney.royalty?.coins?.find(c => lower(c.coin) === lower(wiring.other))).toMatchObject({
      balance: '0', oldestUnsoldAt: '0', inKindClaimed: recorded.afterSale.balance, lastSale: { at: '1000100' },
    });
    const replaced = applyV2Block(first, { ...header(102n), hash: H(999) }, [], f.row).state;
    const rewound = jsonV2(await readMoneyV2(readerFor(f), f.row, replaced.view, 102n, H(999)));
    expect(rewound.royalty?.coins?.find(c => lower(c.coin) === lower(wiring.other))).toMatchObject({ lastSale: null });
    expect(decodeV2Logs(logs.map(l => ({ ...l, address: f.at(7) })), f.route)).toEqual([]);
  });

  it('folds native Flushed receipts without counting receiver funding twice', async () => {
    const f = fixture();
    const logs = raw(recorded.flushLogs).map(l => ({ ...l, address: wiring.router }));
    const view = boxViewV2(decodeV2Logs(logs, f.route), f.ctx);
    const money = jsonV2(await readMoneyV2(readerFor(f), f.row, view, 101n, H(101)));
    expect(money.royalty?.coins?.find(c => c.coin === zeroAddress)).toMatchObject({ flushed: '123', unwrapped: '0', lastSale: null });
  });
});

it.each([false, true])('RC6-I2 recorded initialT distinguishes exhausted holders and no buyers: %s', noBuyer => {
  const f = fixture();
  // Keep the recorded coordinator payloads; the fixture route supplies this box's identity.
  const events = [...(noBuyer ? recorded.noBuyerFailureLogs : recorded.holderFailureLogs), ...(!noBuyer ? recorded.holderClaimLogs : [])];
  const view = boxViewV2(decodeV2Logs(raw(events).map(l => ({ ...l, address: f.at(0) })), f.route), f.ctx);
  const live = jsonV2(liveViewV2({ block: 101n, p: f.row.q, pDecimals: 6, view, pool: null, supply: 0n, balances: new Map(), volumeQ: 0n, volumeT: 0n }, 1_000_000n));
  expect(live.closing).toMatchObject({ initialT: noBuyer ? '0' : recorded.pending.tLeft, tLeft: '0' });
});

it('RC6RR-FC-3 publishes the recorded late inbox P as the creator entitlement without a prior sweep', async () => {
  const f = fixture();
  const view = boxViewV2(decodeV2Logs(raw(recorded.noBuyerFailureLogs).map(l => ({ ...l, address: f.at(0) })), f.route), f.ctx);
  expect(view.claim?.initialT).toBe(0n);
  // The last two: a refused read, and an answer that is not one word (`0x1234`), are both unknown, never a failed money read.
  for (const [snapshot, entitlement, inboxP, answer] of [[recorded.noBuyerLate, '77', '77', 'word'], [recorded.exhausted, '0', '0', 'word'],
    [recorded.noBuyerLate, '77', null, 'refused'], [recorded.noBuyerLate, '77', null, 'short']] as const) {
    const base = readerFor(f);
    const callAt = async (to: Address, data: Hex, hash: Hex): Promise<Hex> => {
      if (lower(to) === lower(wiring.router)) {
        const { functionName } = decodeFunctionData({ abi: royaltyRouterV2Abi, data });
        // RC6-RR-INBOX: the P a failed box's claim first moves in, read at the same hash; a refused read is unknown.
        if (functionName === 'pendingPriceCoin') {
          if (answer === 'refused') throw Object.assign(new Error('execution reverted'), { cause: { data: '0x' } });
          if (answer === 'short') return '0x1234';
          return encodeFunctionResult({ abi: royaltyRouterV2Abi, functionName, result: BigInt(snapshot.pendingP) });
        }
      }
      if (to !== f.at(0)) return base.callAt(to, data, hash);
      const { functionName } = decodeFunctionData({ abi: coordinatorV2Abi, data });
      if (functionName === 'claimState') return encodeFunctionResult({ abi: coordinatorV2Abi, functionName, result: [BigInt(snapshot.pot), BigInt(snapshot.tLeft)] });
      if (functionName === 'quoteClaim') {
        if (!snapshot.ok) throw Object.assign(new Error('execution reverted'), { cause: { data: snapshot.quote } });
        return snapshot.quote as Hex;
      }
      if (functionName === 'failed') return encodeFunctionResult({ abi: coordinatorV2Abi, functionName, result: true });
      return base.callAt(to, data, hash);
    };
    const money = jsonV2(await readMoneyV2({ callAt }, f.row, view, 101n, H(101)));
    expect(money.claim).toEqual({ pot: snapshot.pot, tLeft: snapshot.tLeft, creatorEntitlement: entitlement, inboxP });
    const live = jsonV2(liveViewV2({ block: 101n, p: f.row.q, pDecimals: 6, view, money: await readMoneyV2({ callAt }, f.row, view, 101n, H(101)),
      pool: null, supply: 0n, balances: new Map(), volumeQ: 0n, volumeT: 0n }, 1_000_000n));
    expect(live.closing).toMatchObject({ pot: snapshot.pot, creatorEntitlement: entitlement, inboxP });
  }
  // A live box has no claim to move inbox P into: nothing is read or published.
  const liveBox = await readMoneyV2(readerFor(f), f.row, boxViewV2([], f.ctx), 101n, H(101));
  expect(liveBox.claim.inboxP).toBeNull();
});

function serviceFixture(noise = false) {
  const base = serviceBoxV2();
  const contracts = [...base.record.contracts];
  const code = new Map(base.code);
  const originalRouter = contracts[8];
  const runtime = originalRouter ? code.get(lower(originalRouter)) : undefined;
  if (!runtime) throw new Error('missing fixture inbox');
  code.set(lower(wiring.router), runtime);
  contracts[8] = wiring.router;
  const box = { ...base, record: { ...base.record, contracts }, code };
  const world = new World('inbox-recorded');
  world.block(10n); world.block(99n, [listingAddedLog(serviceListingV2())]); world.block(100n, [boxLogsV2(box)]);
  const toWorld = (logs: typeof recorded.refreshLogs) => logs.map(l => ({ address: l.emitter as Address, topics: l.topics as Hex[], data: l.data as Hex }));
  world.block(101n, toWorld(recorded.refreshLogs));
  const sales = toWorld(recorded.saleLogs.filter(l => l.emitter === recorded.wiring.settlement));
  const sale = sales[0];
  if (!sale) throw new Error('missing recorded sale');
  world.block(102n, [...sales, ...(noise ? [{ ...sale, topics: [sale.topics[0] as Hex, H(1234)] }] : [])]);
  world.to(110n);
  const f = fixture(); const reads = readerFor(f, recorded.afterSale);
  const chain = serviceChainV2(world, [box]);
  const original = chain.callAt.bind(chain);
  chain.callAt = async (to, data, hash) => {
    if (lower(to) === lower(wiring.router)) return reads.callAt(to, data, hash);
    try {
      const { functionName } = decodeFunctionData({ abi: listingRegistryV2Abi, data });
      if (functionName === 'sellableCount' || functionName === 'sellableToken') return reads.callAt(f.release.listingRegistry.address, data, hash);
    } catch { /* not a listing read */ }
    return original(to, data, hash);
  };
  const history: HistoryMessage[] = [];
  const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifestV2(), auditEvery: 10000,
    onHistory: message => { history.push(message); } });
  const token = box.record.contracts[1];
  if (!token) throw new Error('missing fixture token');
  return { indexer, chain, world, token, history };
}

function publication(f: ReturnType<typeof serviceFixture>) {
  const view = f.indexer.v2BoxView(f.token);
  if (!view) throw new Error('missing inbox fixture publication');
  const { vaultItems, ...legacyView } = view;
  // SH-235 adds inventory to this untouched collection vault. Keep the old fields byte-pinned.
  expect(vaultItems).toEqual({ firstId: '1', n: '100', known: [], owners: {} });
  return jsonV2({ view: legacyView, recent: f.indexer.recent(f.token),
    history: f.history.map(m => m.type === 'block' ? { type: m.type, block: m.result.block, boxes: m.result.boxes } : m) });
}

it.each([false, true])('RC7-I10 preserves the start-commit publication and reorg history with unrelated owner=%s', async noise => {
  const f = serviceFixture(noise);
  const { indexer, chain, world, token } = f;
  await indexer.start();
  const before = publication(f);
  expect(indexer.v2BoxView(token)?.money?.royalty?.coins?.find(c => lower(c.coin) === lower(wiring.other))?.lastSale)
    .toMatchObject({ sellAmount: '100000000', buyAmount: '77' });
  const fork = world.fork(101n, 'without-sale'); fork.to(111n);
  chain.setBranch(fork.headers.filter(h => h.number > 101n), []);
  await indexer.enqueue(chain.header(111n));
  expect(indexer.v2BoxView(token)?.money?.royalty?.coins?.find(c => lower(c.coin) === lower(wiring.other))?.lastSale).toBeNull();
  expect(JSON.stringify({ before, after: publication(f) })).toBe(JSON.stringify(baseline));
  indexer.stop();
});

const ownerTopic = `0x${wiring.router.slice(2).toLowerCase().padStart(64, '0')}` as Hex;
function expectInboxFilter(filter: LogFilter) {
  expect.soft(filter.addresses.map(lower)).not.toContain(lower(wiring.settlement));
  expect.soft(filter.topics).not.toContain(recorded.saleLogs[0]?.topics[0]);
  expect.soft(filter.settlementAddresses).toEqual([lower(wiring.settlement)]);
  expect.soft(filter.settlementTopics).toEqual([recorded.saleLogs[0]?.topics[0]]);
  expect.soft(filter.settlementOwners).toEqual([ownerTopic]);
}

it.each(['head', 'backfill', 'replay'] as const)('RC7-I10 filters Trade by inbox owner through %s', async path => {
  const f = serviceFixture(true);
  const hashes = vi.spyOn(f.chain, 'logsByHash');
  const ranges = vi.spyOn(f.chain, 'rangeLogs');
  try {
    if (path === 'backfill') {
      f.world.to(200n);
      f.chain.setBranch(f.world.headers.filter(h => h.number > 110n), []);
    } else if (path === 'head') f.chain.tip = 101n;
    await f.indexer.start();
    if (path === 'head') {
      hashes.mockClear(); ranges.mockClear();
      f.chain.tip = 102n;
      await f.indexer.enqueue(f.chain.header(102n));
    } else if (path === 'replay') {
      hashes.mockClear(); ranges.mockClear();
      const entry = f.indexer.boxesV2.get(lower(f.token));
      if (!entry) throw new Error('missing indexed box');
      await f.indexer.repairBox(entry);
    }
    expect(f.indexer.metrics.errors).toBe(0);
    const filters = path === 'head' ? hashes.mock.calls.map(c => c[1])
      : ranges.mock.calls.filter(c => c[2].addresses.some(a => lower(a) === lower(wiring.router))).map(c => c[2]);
    expect(filters.length).toBeGreaterThan(0);
    for (const filter of filters) expectInboxFilter(filter);
    // Assert at the reader boundary, before the decoder's independent owner check.
    const results = path === 'head' ? hashes.mock.results : ranges.mock.results;
    const logs = (await Promise.all(results.map(r => r.value as Promise<readonly RawLog[]>))).flat();
    const trades = logs.filter(l => lower(l.address) === lower(wiring.settlement));
    expect(trades.length).toBeGreaterThan(0);
    expect(trades.every(l => l.topics[1] === ownerTopic)).toBe(true);
    expect(f.indexer.v2BoxView(f.token)?.money?.royalty?.coins?.find(c => lower(c.coin) === lower(wiring.other))?.lastSale)
      .toMatchObject({ sellAmount: '100000000', buyAmount: '77' });
  } finally { f.indexer.stop(); }
});

it('RC7-I10 adds no settlement or owner before a box has inbox wiring', async () => {
  const f = serviceFixture(); f.chain.tip = 99n;
  const hashes = vi.spyOn(f.chain, 'logsByHash');
  const ranges = vi.spyOn(f.chain, 'rangeLogs');
  try {
    await f.indexer.start();
    const filters = [...hashes.mock.calls.map(c => c[1]), ...ranges.mock.calls.map(c => c[2])];
    expect(filters.length).toBeGreaterThan(0);
    for (const filter of filters) {
      expect(filter.settlementAddresses).toEqual([]);
      expect(filter.settlementOwners).toEqual([]);
    }
  } finally { f.indexer.stop(); }
});

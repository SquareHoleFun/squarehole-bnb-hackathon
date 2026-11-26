import { afterEach, expect, it, vi } from 'vitest';
import { shLimit } from '../../../../vitest.timeouts.mjs';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import baseline from './rpc-load-baseline.json';
import { CoreGateway } from '../../src/core/core-gateway';
import { coreGatewaySource } from '../../src/core/core-service';
import { jsonV2 } from '../../src/core/core-row';
import { request, ResponseDouble } from '../links/fixture';
import { boxHookAbi, boxItemStreamAbi } from '@squarehole/chain/abi';
import { encodeFunctionData, encodeFunctionResult, zeroAddress } from 'viem';
import { CoreChainIndexer, type HistoryMessage } from '../../src/core/chain-indexer';
import { RpcCoreReader } from '../../src/core/core-reader';
import { agreeingCalls, ev, synthBox, synthManifest, World } from './core-synth';
import { boxLogsV2, requiredV2, serviceBoxV2, serviceChainV2, serviceListingV2, synthManifestV2, listingAddedLog, V2 } from './scripted-core-chain';
import { counts, fixtureRpc } from './rpc-fixture';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// Keep every old field byte-pinned; check the additive inventory separately in these untouched vaults.
function canonical(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) => {
    if (key === 'vaultItems') {
      expect(jsonV2(item)).toEqual({ firstId: '1', n: '100', known: [], owners: {} });
      return undefined;
    }
    return typeof item === 'bigint' ? item.toString()
      : item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item;
  });
}

async function measure(multicall: boolean, capacity?: { boxes: number; active: boolean }) {
  const base = synthBox({ boxId: 0n, creationBlock: 12n });
  const box0 = { ...base, row: { ...base.row, poolManager: V2.poolManager, randomness: V2.randomness }, record: { ...base.record, poolManager: V2.poolManager, randomness: V2.randomness } };
  const boxes = Array.from({ length: (capacity?.boxes ?? 4) - 1 }, (_, i) => serviceBoxV2(BigInt(i + 4)));
  const world = new World('rpc-load');
  world.block(10n); world.block(12n, [world.created(box0)]);
  world.block(99n, [listingAddedLog(serviceListingV2())]);
  world.block(100n, boxes.map(box => boxLogsV2(box)));
  world.to(160n);
  for (let n = 161n; n <= 192n; n++) world.block(n, capacity?.active ? [[
    { ...ev.swap(box0, { amount0: 19n, amount1: -101n, sqrtPriceX96: 2n ** 96n, tick: 0, liquidity: 1000n }), address: V2.poolManager },
  ]] : []);
  world.block(193n, [[ev.taxedBuy(box0, box0.record.creator, 19n, 1n, 101n)]]);
  world.to(300n);
  const chain = serviceChainV2(world, boxes, (_box, key) => key === 'royaltyRouter.listingRegistry' ? zeroAddress : undefined);
  const original = chain.callAt.bind(chain);
  const code = chain.codeAt.bind(chain);
  chain.codeAt = async (address, hash) => box0.codes.get(address.toLowerCase()) ?? code(address, hash);
  const manifest = { ...synthManifestV2(), versions: synthManifest().versions };
  const maxAggregate = { subcalls: 0, calldataBytes: 0, responseBytes: 0 };
  const requests = fixtureRpc(chain, multicall, size => {
    expect(size.subcalls).toBeLessThanOrEqual(128);
    expect(size.calldataBytes).toBeLessThanOrEqual(48 * 1024);
    for (const key of ['subcalls', 'calldataBytes', 'responseBytes'] as const) maxAggregate[key] = Math.max(maxAggregate[key], size[key]);
  });
  const reader = new RpcCoreReader({ urls: ['https://fixture.invalid'] });
  const fingerprints = Object.fromEntries(['projections', 'publications', 'audits', 'api', 'history'].map(key => [key, createHash('sha256')]));
  const record = (key: string, value: unknown) => fingerprints[key]?.update(canonical(value) + '\n');
  const history: HistoryMessage[] = [];
  const publications: unknown[] = [];
  const indexer = new CoreChainIndexer({ reader, manifest, onHistory: message => { history.push(message); },
    onUpdate: () => {
      if (capacity && (indexer.head()?.number ?? 0n) >= 160n) record('publications', [indexer.feedView(), indexer.v2FeedView(), ...boxes.map(box => indexer.v2BoxView(requiredV2(box.record.contracts[1])))]);
      if (!capacity) publications.push([indexer.feedView(), indexer.v2FeedView(), ...boxes.map(box => indexer.v2BoxView(requiredV2(box.record.contracts[1])))]); } });
  const audit = vi.spyOn(indexer, 'audit');
  const { source, updated } = coreGatewaySource(indexer, reader, null, 60_000, () => 1000);
  const gateway = new CoreGateway({ source, port: 0, host: '127.0.0.1' });
  const observe = async () => {
    record('projections', [...indexer.boxes.values(), ...indexer.boxesV2.values()].map(entry => ({
      state: entry.states.at(-1), audit: entry.audit, verified: entry.verified, trades: entry.trades, activity: entry.activity,
    })));
    updated();
    const paths = ['/v1/feed', '/v2/feed', `/v1/boxes/${indexer.chainId}/${box0.row.contracts.token}`,
      ...boxes.map(box => `/v2/boxes/${indexer.chainId}/${box.record.contracts[1]}`)];
    for (const url of paths) {
      const { req } = request(undefined, { method: 'GET', url });
      const res = new ResponseDouble(); await gateway.route(req, res.asResponse());
      expect(res.status, url).toBe(200);
      record('api', { url, status: res.status, headers: res.headers, body: res.json() });
    }
  };
  const box0Addresses = new Set(Object.values(box0.row.contracts).filter((address): address is `0x${string}` => address !== null).map(address => address.toLowerCase()));
  box0Addresses.add(box0.row.poolManager.toLowerCase());
  const box0Answer = agreeingCalls(indexer);
  chain.callAt = async (to, data, hash) => {
    // Avoid deriving box 0's full state for every unrelated v2 view in the 150-box fixture.
    const answer = box0Addresses.has(to.toLowerCase()) ? box0Answer(to, data, hash) : undefined;
    if (answer !== undefined) return answer;
    if (to === box0.row.contracts.hook && data === encodeFunctionData({ abi: boxHookAbi, functionName: 'depthBudget' })) return encodeFunctionResult({ abi: boxHookAbi, functionName: 'depthBudget', result: [0n, 0n] });
    if (to === box0.row.contracts.itemStream) return encodeFunctionResult({ abi: boxItemStreamAbi, functionName: 'index', result: 0n });
    return original(to, data, hash);
  };
  chain.tip = 160n;
  await indexer.start(); await indexer.idle();
  expect(indexer.head()?.number).toBe(160n);
  expect(indexer.allRows()).toHaveLength(boxes.length + 1);
  expect(indexer.feedView().cards).toHaveLength(1);
  expect(indexer.v2FeedView().cards).toHaveLength(boxes.length);
  const cold = counts(requests.splice(0));
  const perBlock: Record<string, number>[] = [];
  if (capacity) await observe();
  for (let n = 161n; n <= 192n; n++) {
    chain.tip = n;
    await indexer.enqueue(chain.header(n));
    if (capacity) { await indexer.idle(); perBlock.push(counts(requests.splice(0))); await observe(); }
  }
  await indexer.idle();
  const empty = counts(requests.splice(0));
  if (capacity) {
    expect(indexer.metrics.errors).toBe(0);
    expect(indexer.metrics.auditMismatches).toBe(0);
    expect(indexer.recent(requiredV2(box0.row.contracts.token ?? undefined))?.trades).toHaveLength(capacity.active ? 32 : 0);
    record('history', history);
    for (const result of audit.mock.results) if (result.type === 'return') record('audits', await result.value);
    const digests = Object.fromEntries(Object.entries(fingerprints).map(([key, hash]) => [key, hash.digest('hex')]));
    indexer.stop();
    return { digests, maxAggregate, counts: { cold, empty, trade: {} }, snapshots: [], history, publications, perBlock };
  }
  chain.tip = 193n;
  await indexer.enqueue(chain.header(193n)); await indexer.idle();
  const trade = counts(requests.splice(0));
  // A running gateway can serve every published intermediate head during a long-gap catch-up too.
  chain.tip = 300n;
  await indexer.enqueue(chain.header(300n)); await indexer.idle();
  expect(indexer.metrics.errors).toBe(0);
  expect(indexer.metrics.auditMismatches).toBe(0);
  const snapshots = [indexer.boxView(requiredV2(box0.row.contracts.token ?? undefined)), ...boxes.map(box => indexer.v2BoxView(requiredV2(box.record.contracts[1])))];
  indexer.stop();
  return { counts: { cold, empty, trade }, snapshots, history, publications, perBlock };
}

it('RPC-4: box 0 and three v2 boxes keep snapshots/history identical within five requests per box per empty block', async () => {
  const before = await measure(false);
  const after = await measure(true);
  console.warn('RPC-LOAD', JSON.stringify({ single: before.counts, multicall: after.counts }));
  expect(after.snapshots).toEqual(before.snapshots);
  expect(after.history).toEqual(before.history);
  expect(after.publications).toEqual(before.publications);
  expect(Object.values(after.counts.empty).reduce((sum, n) => sum + n, 0) / 32 / 4).toBeLessThanOrEqual(5);
}, shLimit(60_000));

it.each(process.env.SH_TEST_CAPACITY === '1' ? [50, 150] : [4])('BATCH-4 / CAP-3: measures idle and one trade per block at %i boxes without network', async boxes => {
  const results = [];
  for (const active of [false, true]) {
    const result = await measure(true, { boxes, active });
    expect(result.perBlock).toHaveLength(32);
    const totals: Record<string, number> = {};
    for (const block of result.perBlock) for (const [method, count] of Object.entries(block)) totals[method] = (totals[method] ?? 0) + count;
    console.warn('CAPACITY-INDEXER', JSON.stringify({ boxes, active, cold: result.counts.cold, totals, perBlock: result.perBlock, digests: result.digests, maxAggregate: result.maxAggregate }));
    writeFileSync(new URL(`../../../../.cache/capacity-indexer-${boxes}-${active}.json`, import.meta.url), JSON.stringify({ boxes, active, cold: result.counts.cold, totals, perBlock: result.perBlock, digests: result.digests, maxAggregate: result.maxAggregate }, null, 2));
    expect(totals['eth_sendRawTransaction']).toBeUndefined();
    expect(totals['eth_getLogs']).toBeGreaterThan(0);
    results.push({ active, result });
  }
  for (const { active, result } of results) {
    const budget = ({ 4: [5, 11, 3], 50: [21, 43, 5], 150: [58, 118, 9] } as Record<number, readonly number[]>)[boxes];
    if (!budget) throw new Error('missing measured request budget');
    for (const [i, block] of result.perBlock.entries()) {
      const auditBlock = i === 31;
      expect(block, `${boxes} boxes, active=${active}, block=${161 + i}`).toEqual({
        eth_call: requiredV2(budget[auditBlock ? 1 : 0]) + (active ? 1 : 0),
        eth_getLogs: budget[2], eth_getBlockByNumber: auditBlock ? 2 : 1,
      });
    }
    expect(result.digests).toEqual((baseline as Record<string, unknown>)[`${boxes}-${active}`]);
  }
  // SH-229: 30 minutes. The measure counts requests, never time; at 150 boxes it takes 427 to 530 s on the Linux laptop
  // of 2026-11-10 when the stage runs alone and took 606 s and 803 s beside other work, over the earlier 600 s.
}, shLimit(1_800_000));

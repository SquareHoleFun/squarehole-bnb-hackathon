/**
 * Log indexer over the scripted fake chain (mocked transport): bounded adaptive ranges, dedupe, reorg detection by
 * block hash with rewind to the newest surviving checkpoint, full rebuild below every checkpoint, persistence with a
 * schema version, and storage failures that never break a read.
 */
import 'fake-indexeddb/auto';
import { createPublicClient, type Abi } from 'viem';
import { describe, expect, it } from 'vitest';
import { squareHoleTokenAbi } from '../abi';
import { createChainConfig } from '../config/config';
import { ChainUnavailableError } from '../errors';
import { ChainReader } from '../reads/reader';
import { ALICE, BOB, buildScenario, eventLog, type Scenario } from '../test-support/scenario';
import { LogIndexer } from './indexer';
import { createAdaptiveRange, fetchLogsAdaptive, isRangeLimitError } from './log-fetch';
import { holderCount } from './metrics';
import { INDEX_SCHEMA_VERSION, createIndexedDbIndexStore, createMemoryIndexStore, indexKey, type IndexStore } from './store';

function setup(scenario: Scenario, options: { store?: IndexStore; logs?: { initialRange: number; maxRange: number; minRange: number } } = {}) {
  const config = createChainConfig({ chainId: 31_337, manifest: scenario.manifestJson, rpcUrls: ['http://127.0.0.1:8551'], logs: options.logs });
  const client = createPublicClient({ transport: scenario.chain.transport() });
  const reader = new ChainReader(config, client as never);
  const indexer = new LogIndexer(config, client as never, reader, { store: options.store });
  return { config, client, reader, indexer };
}

describe('fetchLogsAdaptive', () => {
  it('halves a range the provider refuses and still returns every log once, in order', async () => {
    const scenario = buildScenario();
    scenario.chain.maxLogRange = 4;
    const client = createPublicClient({ transport: scenario.chain.transport() });
    const range = createAdaptiveRange(32, 1, 64);
    const logs = await fetchLogsAdaptive(client as never, { address: scenario.fit.contracts.token.address }, 0n, 40n, range);
    expect(logs.map((log) => log.blockNumber)).toEqual([15n, 15n, 20n, 22n, 22n]);
    expect(range.current).toBeLessThanOrEqual(8);
    expect(scenario.chain.calls.filter((call) => call === 'eth_getLogs').length).toBeGreaterThan(10);
  });

  it('fails with ChainUnavailableError on other errors, and when even one block is refused', async () => {
    const scenario = buildScenario();
    scenario.chain.failures.set('eth_getLogs', 1);
    const client = createPublicClient({ transport: scenario.chain.transport() });
    await expect(fetchLogsAdaptive(client as never, { address: scenario.fit.contracts.token.address }, 0n, 40n, createAdaptiveRange(64, 1, 64))).rejects.toBeInstanceOf(ChainUnavailableError);
    const strict = buildScenario();
    strict.chain.maxLogRange = 0;
    const strictClient = createPublicClient({ transport: strict.chain.transport() });
    await expect(fetchLogsAdaptive(strictClient as never, { address: strict.fit.contracts.token.address }, 0n, 3n, createAdaptiveRange(2, 1, 2))).rejects.toBeInstanceOf(ChainUnavailableError);
  });

  it('recognises provider range-limit errors', () => {
    expect(isRangeLimitError({ code: -32005, message: 'limit exceeded' })).toBe(true);
    expect(isRangeLimitError(new Error('query returned more than 10000 results'))).toBe(true);
    expect(isRangeLimitError({ message: 'x', cause: { message: 'block range is too large' } })).toBe(true);
    expect(isRangeLimitError(new Error('connection refused'))).toBe(false);
  });
});

describe('LogIndexer', () => {
  it('indexes from the manifest start block, discovers pairs from PairCreated and decodes approved events only', async () => {
    const scenario = buildScenario();
    const { indexer, reader } = setup(scenario);
    const head = await reader.block('latest');
    const result = await indexer.sync(head);
    expect(result).toMatchObject({ complete: true, reorgs: [] });
    expect(result.indexedTo?.number).toBe('40');
    expect(indexer.pairsAt(40n).map((pair) => pair.pairId)).toEqual([scenario.fit.appPairId, scenario.misfits.appPairId]);
    expect(indexer.pairsAt(16n).map((pair) => pair.pairId)).toEqual([scenario.fit.appPairId]);
    expect(indexer.logsOf(scenario.fit.appPairId, 40n, ['Transfer'])).toHaveLength(5);
    expect(indexer.logsOf(scenario.misfits.appPairId, 40n, ['Swap']).map((log) => log.args.sender)).toHaveLength(2);
  });

  it('dedupes: re-syncing the same head adds nothing', async () => {
    const scenario = buildScenario();
    const { indexer, reader } = setup(scenario);
    const head = await reader.block('latest');
    const first = await indexer.sync(head);
    const again = await indexer.sync(await reader.block('latest'));
    expect(first.logsAdded).toBeGreaterThan(0);
    expect(again.logsAdded).toBe(0);
    expect(again.ranges).toBe(0);
  });

  it('detects a reorg by hash, rewinds to the newest checkpoint still on the chain and re-indexes the new fork', async () => {
    const scenario = buildScenario();
    const { indexer, reader } = setup(scenario);
    await indexer.sync(await reader.block(30n));
    await indexer.sync(await reader.block(40n));
    const holdersBefore = holderCount(indexer, indexer.pair(scenario.fit.appPairId) as never, 40n, 10n ** 27n - 10n ** 21n, []);
    // A new fork from block 31: a transfer to bob lands at block 33 instead of what was there.
    scenario.chain.reorg(31n, 'fork');
    scenario.chain.addLog({ address: scenario.fit.contracts.token.address, blockNumber: 33n, ...eventLog(squareHoleTokenAbi as Abi, 'Transfer', { from: ALICE, to: BOB, amount: 1n }) });
    scenario.chain.head = 42n;
    const result = await indexer.sync(await reader.block('latest'));
    expect(result.reorgs).toHaveLength(1);
    expect(result.reorgs[0]).toMatchObject({ staleHead: { number: '40' }, ancestor: { number: '30' } });
    expect(indexer.indexedTo?.number).toBe('42');
    const bobTransfers = indexer.logsOf(scenario.fit.appPairId, 42n, ['Transfer']).filter((log) => String(log.args.to).toLowerCase() === BOB.toLowerCase());
    expect(bobTransfers).toHaveLength(1);
    expect(bobTransfers[0]?.blockHash).toBe(scenario.chain.hashOf(33n));
    const holdersAfter = holderCount(indexer, indexer.pair(scenario.fit.appPairId) as never, 42n, 10n ** 27n - 10n ** 21n, []);
    expect(holdersBefore.available && holdersAfter.available && holdersAfter.count).toBe(holdersBefore.available ? holdersBefore.count + 1 : -1);
  });

  it('a reorg below every stored checkpoint rebuilds from the start block', async () => {
    const scenario = buildScenario();
    const { indexer, reader } = setup(scenario);
    await indexer.sync(await reader.block(40n));
    scenario.chain.reorg(1n, 'deep');
    const result = await indexer.sync(await reader.block('latest'));
    expect(result.reorgs[0]?.ancestor).toBeNull();
    expect(result.complete).toBe(true);
    // Every log of the old fork (blocks 15-30) is gone and was not replaced (the fake fork has none).
    expect(indexer.pairsAt(40n)).toEqual([]);
  });

  it('a chain head that shrinks below the stored head (evm_revert shape) is a reorg: walk back to the newest checkpoint on the chain', async () => {
    const scenario = buildScenario();
    const { indexer, reader } = setup(scenario);
    await indexer.sync(await reader.block(30n));
    await indexer.sync(await reader.block(38n));
    await indexer.sync(await reader.block(40n));
    // evm_revert to block 35: blocks up to 35 keep their hashes, 36-40 no longer exist.
    scenario.chain.head = 35n;
    const result = await indexer.sync(await reader.block('latest'));
    expect(result.reorgs).toEqual([expect.objectContaining({ staleHead: expect.objectContaining({ number: '40' }), ancestor: expect.objectContaining({ number: '30' }) })]);
    expect(result.complete).toBe(true);
    expect(indexer.indexedTo).toEqual({ number: '35', hash: scenario.chain.hashOf(35n) });
    expect(indexer.covers(40n)).toBe(false);

    // Blocks mined after the revert are new blocks with new hashes; the index extends onto them.
    scenario.chain.reorg(36n, 'after-revert');
    scenario.chain.head = 38n;
    const next = await indexer.sync(await reader.block('latest'));
    expect(next.reorgs).toEqual([]);
    expect(indexer.indexedTo).toEqual({ number: '38', hash: scenario.chain.hashOf(38n) });
  });

  it('a shrunk head below every checkpoint rebuilds from the start block instead of failing the sync', async () => {
    const scenario = buildScenario();
    const { indexer, reader } = setup(scenario);
    await indexer.sync(await reader.block(40n));
    scenario.chain.reorg(25n, 'reset');
    scenario.chain.head = 35n;
    const result = await indexer.sync(await reader.block('latest'));
    expect(result.reorgs).toEqual([expect.objectContaining({ ancestor: null })]);
    expect(result.complete).toBe(true);
    expect(indexer.logsOf(scenario.misfits.appPairId, 35n, ['Swap'])).toEqual([]);
    expect(indexer.pairsAt(35n).map((pair) => pair.pairId)).toEqual([scenario.fit.appPairId, scenario.misfits.appPairId]);
  });

  it('an RPC failure while re-reading the stored head fails the sync (the caller must not use the index for that block)', async () => {
    const scenario = buildScenario();
    const { indexer, reader } = setup(scenario);
    await indexer.sync(await reader.block(40n));
    const target = await reader.block(40n);
    scenario.chain.failures.set('eth_getBlockByNumber', 1);
    await expect(indexer.sync(target)).rejects.toBeInstanceOf(ChainUnavailableError);
  });

  it('a block whose logs changed hash during a range fetch restarts the range instead of committing it', async () => {
    const scenario = buildScenario();
    const { indexer, reader } = setup(scenario);
    const head = await reader.block('latest');
    let flipped = false;
    const original = scenario.chain.request.bind(scenario.chain);
    scenario.chain.request = async (args) => {
      const result = await original(args);
      if (args.method === 'eth_getLogs' && !flipped) {
        flipped = true;
        // The fork replaces blocks 20+ (and drops their logs) right after the first getLogs answered.
        scenario.chain.reorg(20n, 'mid-fetch');
      }
      return result;
    };
    const result = await indexer.sync(head);
    expect(result.complete).toBe(true);
    const logs = Object.values(indexer.snapshotState()?.logs ?? {});
    expect(logs.length).toBeGreaterThan(0);
    for (const log of logs) {
      expect(log.blockHash).toBe(scenario.chain.hashOf(BigInt(log.blockNumber)));
      expect(BigInt(log.blockNumber) < 20n).toBe(true);
    }
    expect(indexer.pairsAt(40n).map((pair) => pair.pairId)).toEqual([scenario.fit.appPairId, scenario.misfits.appPairId]);
  });

  it('persists to IndexedDB with a schema version; a stale schema or foreign deployment is rebuilt, not trusted', async () => {
    const scenario = buildScenario();
    const store = createIndexedDbIndexStore();
    const first = setup(scenario, { store });
    await first.indexer.sync(await first.reader.block('latest'));
    const key = indexKey(31_337, scenario.manifest.contracts.registry.address, String(scenario.manifest.startBlock));
    const saved = await store.load(key);
    expect(saved?.schemaVersion).toBe(INDEX_SCHEMA_VERSION);
    expect(store.kind).toBe('indexeddb');

    // A fresh indexer on the same store resumes without re-fetching logs.
    const second = setup(buildScenario(), { store });
    const resumed = await second.indexer.sync(await second.reader.block('latest'));
    expect(resumed.logsAdded).toBe(0);

    // A record from an older schema is ignored and rebuilt.
    await store.save(key, { ...(saved as NonNullable<typeof saved>), schemaVersion: INDEX_SCHEMA_VERSION - 1 });
    const third = setup(buildScenario(), { store });
    const rebuilt = await third.indexer.sync(await third.reader.block('latest'));
    expect(rebuilt.logsAdded).toBeGreaterThan(0);
  });

  it('an unusable IndexedDB (missing or throwing) falls back to memory and the read still succeeds', async () => {
    const missing = createIndexedDbIndexStore(null);
    expect(missing.kind).toBe('indexeddb (unavailable, memory only)');
    const throwing = createIndexedDbIndexStore({
      open() {
        throw new Error('SecurityError: blocked');
      },
    } as unknown as IDBFactory);
    const scenario = buildScenario();
    const { indexer, reader } = setup(scenario, { store: throwing });
    const result = await indexer.sync(await reader.block('latest'));
    expect(result.complete).toBe(true);
    expect(result.store).toBe('indexeddb (unavailable, memory only)');
  });

  it('bounds work per sync and continues on the next call', async () => {
    const scenario = buildScenario();
    const config = createChainConfig({ chainId: 31_337, manifest: scenario.manifestJson, rpcUrls: ['http://127.0.0.1:8551'], logs: { initialRange: 5, maxRange: 5, minRange: 1 } });
    const client = createPublicClient({ transport: scenario.chain.transport() });
    const reader = new ChainReader(config, client as never);
    const indexer = new LogIndexer(config, client as never, reader, { store: createMemoryIndexStore(), maxRangesPerSync: 3 });
    const head = await reader.block('latest');
    const partial = await indexer.sync(head);
    expect(partial.complete).toBe(false);
    expect(indexer.covers(40n)).toBe(false);
    let result = partial;
    for (let i = 0; i < 5 && !result.complete; i += 1) result = await indexer.sync(head);
    expect(result.complete).toBe(true);
  });
});

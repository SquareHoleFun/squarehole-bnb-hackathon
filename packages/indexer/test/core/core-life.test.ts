/**
 * Box 0's recorded life on a local core v1 chain (fixtures/core-local-life.json, recorded by
 * scripts/record-core-fixture.ts from anvil with core v1 deployed by script/local/DeployCoreV1Local.s.sol and the life
 * of CoreV1LocalLife.s.sol), replayed with nothing running:
 *
 * - BC-073: box 0 found from the manifest's registry alone, its code checked at its creation block, its creation block's
 *   own trade (the bootstrap) indexed; the row from the logs equals `registry.recordOf(0)`.
 * - BC-081: the indexer's phase equals the hook's `phase()` at EVERY block from the creation block to the head.
 * - BC-080: the audits the recorded run made (every 32 blocks and after each stage) all agree with the chain's reads.
 * - § 3.3: every log of box 0's contracts decodes, but the events S10a does not read (approvals, initialisations).
 * - BC-078 (1 box, live): history written two deep, wiped and rebuilt from the chain: identical rows and candles.
 */
import { boxRowFromRecord, rowsFromRegistryLogs, type BoxRow, type RegistryRecord } from '@squarehole/chain';
import { boxCollectionAbi, boxRegistryAbi, boxTicketsAbi, boxTokenAbi, boxVaultAbi, fitBuybackExecutorAbi } from '@squarehole/chain/abi';
import { decodeFunctionResult, toEventSelector, type Abi, type AbiEvent } from 'viem';
import { beforeAll, describe, expect, it } from 'vitest';
import { CoreChainIndexer, type HistoryMessage } from '../../src/core/chain-indexer';
import { decodeCoreLog } from '../../src/core/core-events';
import { MemoryHistory } from '../../src/history/memory-history';
import { HistoryWriter } from '../../src/history/writer';
import { loadCoreLife, type CoreLife } from './scripted-core-chain';

let life: CoreLife;

beforeAll(() => {
  life = loadCoreLife();
});

/** Follows the recorded chain block by block from the creation block, with a callback after each block. */
async function follow(onBlock: (indexer: CoreChainIndexer, n: bigint) => Promise<void> | void, onHistory?: (m: HistoryMessage) => Promise<void>): Promise<CoreChainIndexer> {
  const chain = loadCoreLife().chain;
  chain.tip = life.creationBlock;
  const indexer = new CoreChainIndexer({ reader: chain, manifest: life.manifest, auditEvery: 1_000_000, ...(onHistory ? { onHistory } : {}) });
  await indexer.start();
  await indexer.idle();
  await onBlock(indexer, life.creationBlock);
  for (let n = life.creationBlock + 1n; n <= life.head; n += 1n) {
    chain.tip = n;
    await indexer.enqueue(chain.header(n));
    await onBlock(indexer, n);
  }
  return indexer;
}

describe('box 0 on a local core v1 chain (recorded life)', () => {
  it('BC-073: found from the manifest\'s registry alone, checked at its creation block, its bootstrap trade indexed; the row equals recordOf(0)', async () => {
    const indexer = new CoreChainIndexer({ reader: life.chain, manifest: life.manifest });
    await indexer.start();
    await indexer.idle();
    expect(indexer.metrics.errors).toBe(0);
    const rows = indexer.allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.verdict).toEqual({ classification: 'shown', reason: null });
    const row = rows[0]?.row as BoxRow;
    expect(row.isBox0).toBe(true);
    expect(row.creationBlock).toBe(life.creationBlock);
    expect(row.spec.tokenSymbol).toBe('FIT');
    // The registry's own view of the box, now, through the same decoder.
    const record = decodeFunctionResult({ abi: boxRegistryAbi as Abi, functionName: 'recordOf', data: life.recordOf0 } as never) as unknown as RegistryRecord;
    const fromRecord = boxRowFromRecord({ ...record, contracts: [...record.contracts], codeHashes: [...record.codeHashes] }, row.encodedSpec, { chainId: life.manifest.chainId, registry: row.registry, box0Registry: row.registry, origin: row.origin });
    expect(fromRecord).toEqual(row);
    // The same row straight from the registry's logs (the BoxCreated log recorded on the local chain; step 2).
    const registryLogs = life.logs.filter((l) => l.address.toLowerCase() === row.registry.toLowerCase());
    expect(rowsFromRegistryLogs(registryLogs, { chainId: life.manifest.chainId, registry: row.registry, box0Registry: row.registry }).rows).toEqual([row]);
    // The bootstrap trade in the creation block itself.
    const view = indexer.boxView(row.contracts.token as string);
    expect(view?.trading.swaps).toBeGreaterThanOrEqual(1);
    const firstTrade = indexer.recent(row.contracts.token as string)?.trades[0];
    expect(firstTrade?.block).toBe(life.creationBlock);
    expect(firstTrade?.route).toBe('bootstrap');
  });

  it('BC-081: the indexer\'s phase equals the hook\'s phase() at every block of the life (upcoming, window, bonding, graduating, graduated)', async () => {
    const seen = new Set<string>();
    const wrong: string[] = [];
    let token = '';
    await follow((indexer, n) => {
      token ||= [...indexer.boxes.keys()][0] ?? '';
      const phase = indexer.boxView(token)?.phase;
      const contract = life.phases.get(n);
      if (contract !== undefined) {
        seen.add(contract);
        if (phase !== contract) wrong.push(`${n}: ${phase} ≠ ${contract}`);
      }
    });
    expect(wrong).toEqual([]);
    expect([...seen].sort()).toEqual(['bonding', 'graduated', 'graduating', 'upcoming', 'window']);
    expect(life.phases.size).toBe(Number(life.head - life.creationBlock + 1n));
  });

  it('BC-080: every audit the recorded run made agrees with the chain (supply, burned, vault, pool, layout, depth, stream)', async () => {
    const results: { block: bigint; ok: boolean; mismatches: readonly string[] }[] = [];
    await follow(async (indexer, n) => {
      const hash = indexer.head()?.hash.toLowerCase() ?? '';
      if (!life.auditHashes.has(hash)) return;
      for (const { result } of await indexer.audit()) results.push({ block: n, ok: result.ok, mismatches: result.mismatches });
    });
    expect(results.length).toBeGreaterThanOrEqual(10);
    expect(results.filter((r) => !r.ok)).toEqual([]);
  });

  it('§ 3.3: every log of box 0\'s contracts decodes, but the events S10a does not read', () => {
    const indexerRow = rowsFromRegistryLogs(life.logs.filter((l) => l.address.toLowerCase() === life.contracts.registry?.toLowerCase()), { chainId: life.manifest.chainId, registry: life.contracts.registry as `0x${string}`, box0Registry: life.contracts.registry as `0x${string}` }).rows[0] as BoxRow;
    const addresses = new Map(Object.entries(indexerRow.contracts).filter(([, a]) => a !== null).map(([role, a]) => [(a as string).toLowerCase(), role]));
    const route = { addresses: addresses as never, poolManager: indexerRow.poolManager, poolId: indexerRow.poolId, randomness: indexerRow.randomness, drand: indexerRow.randomness, drandConsumers: new Set([(indexerRow.contracts.tickets as string).toLowerCase()]) };
    const undecoded = new Map<string, number>();
    const decoded = new Set<string>();
    for (const log of life.logs) {
      const event = decodeCoreLog(log, route);
      if (event) decoded.add(`${event.source}.${event.name}`);
      if (!addresses.has(log.address.toLowerCase())) continue;
      if (event) continue;
      undecoded.set(`${addresses.get(log.address.toLowerCase())}:${log.topics[0]?.slice(0, 10)}`, (undecoded.get(`${addresses.get(log.address.toLowerCase())}:${log.topics[0]?.slice(0, 10)}`) ?? 0) + 1);
    }
    // Not read by S10a: approvals, the clones' one-time initialisation, the price average's samples and budget top-ups.
    const unread = new Set(
      [boxTokenAbi, boxTicketsAbi, boxCollectionAbi, boxVaultAbi, fitBuybackExecutorAbi]
        .flatMap((abi) => (abi as readonly AbiEvent[]).filter((item) => item.type === 'event' && ['Approval', 'ApprovalForAll', 'VaultInitialized', 'CollectionInitialized', 'Observed', 'BudgetFunded', 'ContractURIUpdated', 'MetadataUpdate'].includes(item.name)))
        .map((item) => toEventSelector(item).slice(0, 10)),
    );
    for (const key of undecoded.keys()) expect(unread.has(key.split(':')[1] ?? ''), key).toBe(true);
    for (const name of ['poolManager.Swap', 'hook.PoolLaunched', 'hook.CurveClosed', 'hook.Migrated', 'launchRouter.TaxedBuy', 'launchRouter.Bootstrapped', 'coordinator.Graduated', 'receiver.BatchSplit', 'receiver.Collected', 'vault.TicketsOpened', 'collection.ConsecutiveTransfer', 'tickets.PlaceholdersTaken', 'tickets.DrawSettled', 'itemStream.Claimed', 'token.Transfer']) {
      expect(decoded, name).toContain(name);
    }
  });

  it('BC-078 (1 box, live): history two deep, wiped and rebuilt from the chain, gives identical rows and candles', async () => {
    const first = new MemoryHistory();
    const writer = new HistoryWriter(first);
    await follow(() => undefined, writer.accept);
    await writer.flush();
    const live = await first.dump(life.manifest.chainId);
    expect(live.trades.length).toBeGreaterThan(5);
    expect(live.batches.length).toBeGreaterThan(2);
    expect(live.items.length).toBe(4269);
    // Wipe, then rebuild in one catch-up from the chain (the range backfill path).
    await first.wipe(life.manifest.chainId);
    expect((await first.dump(life.manifest.chainId)).trades).toEqual([]);
    const rebuilt = new MemoryHistory();
    const again = new HistoryWriter(rebuilt);
    const indexer = new CoreChainIndexer({ reader: loadCoreLife().chain, manifest: life.manifest, onHistory: again.accept });
    await indexer.start();
    await indexer.idle();
    await again.flush();
    expect(await rebuilt.dump(life.manifest.chainId)).toEqual({ ...live, chainBlocks: expect.any(Array) as unknown as string[] });
    // The block-by-block run writes every block; the backfill only blocks with logs: the event rows are identical.
    const backfillBlocks = (await rebuilt.dump(life.manifest.chainId)).chainBlocks;
    expect(live.chainBlocks.filter((b) => backfillBlocks.includes(b)).length).toBe(backfillBlocks.length);
  });
});

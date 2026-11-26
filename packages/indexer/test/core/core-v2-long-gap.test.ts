import { describe, expect, it } from 'vitest';
import { CoreChainIndexer } from '../../src/core/chain-indexer';
import { loadCoreConfig } from '../../src/core/core-config';
import { MemoryHistory } from '../../src/history/memory-history';
import { HistoryWriter } from '../../src/history/writer';
import { checkBoxV2 } from '../../src/core/v2/discovery-v2';
import { World } from './core-synth';
import { requiredV2, serviceBoxV2, serviceChainV2, serviceListingV2, synthManifestV2, boxLogsV2, listingAddedLog, receiverEventV2, V2 } from './scripted-core-chain';

const token = (b: ReturnType<typeof serviceBoxV2>) => requiredV2(b.record.contracts[1]).toLowerCase();
async function follow(chain: ReturnType<typeof serviceChainV2>) {
  const history = new MemoryHistory();
  const writer = new HistoryWriter(history);
  const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifestV2(), auditEvery: 10_000, onHistory: writer.accept });
  await indexer.start();
  await indexer.idle();
  await writer.flush();
  return { indexer, history, writer };
}

describe('CQ8-2: v2 release and listing registry recovery in the service', () => {
  it('loads releases through the service configuration', () => {
    const config = loadCoreConfig({ SH_CORE_MANIFEST: 'fixture.json', SH_CORE_HTTP_URLS: 'http://rpc.example' }, () => JSON.stringify(synthManifestV2()));
    expect(config.manifest).toHaveProperty('releases', synthManifestV2().releases);
  });
  for (const reuse of [false, true]) for (const deep of [false, true]) {
    it(`drops orphaned v2 boxes and listings, reused id=${reuse}, rebuild=${deep}`, async () => {
      const orphan = serviceBoxV2();
      const replacement = serviceBoxV2(4n, 130n, 44n);
      const old = new World('v2-old');
      old.block(10n);
      old.block(100n, [listingAddedLog(serviceListingV2()), boxLogsV2(orphan), receiverEventV2(orphan, 'FitPaid')]);
      old.to(deep ? 260n : 110n);
      const chain = serviceChainV2(old, [orphan, replacement]);
      expect((await checkBoxV2(chain, synthManifestV2(), { registry: V2.registry, record: orphan.record, encodedSpec: orphan.encodedSpec }, { creationHash: chain.header(100n).hash, headHash: chain.header(chain.tip).hash, reviewed: [] })).classification).toBe('shown');
      const got = await follow(chain);
      expect(got.indexer.allRows()).toHaveLength(1);
      expect(got.indexer.v2FeedView().cards.map((c) => c.token)).toEqual([token(orphan)]);
      expect(got.indexer.listingsV2(V2.registry).listings).toHaveLength(1);
      const canonical = old.fork(99n, 'v2-canonical');
      if (reuse) {
        canonical.block(130n, [listingAddedLog(serviceListingV2()), boxLogsV2(replacement), receiverEventV2(replacement, 'FitPaid', { amount: 777n })]);
        canonical.block(140n, [receiverEventV2(replacement, 'PlatformPaid')]);
      }
      canonical.to(deep ? 350n : 200n);
      chain.setBranch(canonical.headers.filter((h) => h.number > 99n), canonical.logs.filter((l) => l.blockNumber > 99n));
      await got.indexer.enqueue(chain.header(chain.tip));
      await got.indexer.idle();
      await got.writer.flush();
      expect(got.indexer.metrics.errors).toBe(0);
      expect(got.indexer.v2FeedView().cards.map((c) => c.token)).toEqual(reuse ? [token(replacement)] : []);
      expect(got.indexer.listingsV2(V2.registry).listings).toHaveLength(reuse ? 1 : 0);
      expect(got.indexer.v2BoxView(token(orphan))).toBeNull();
      const truth = await follow(serviceChainV2(canonical, [replacement]));
      expect(got.indexer.v2FeedView()).toEqual(truth.indexer.v2FeedView());
      expect(got.indexer.v2BoxView(token(replacement))).toEqual(truth.indexer.v2BoxView(token(replacement)));
      const want = await truth.history.dump(V2.chainId);
      expect({ ...await got.history.dump(V2.chainId), chainBlocks: want.chainBlocks }).toEqual(want);
    });
  }
  it('stages listing discovery with rows: a failed range header publishes neither', async () => {
    const box = serviceBoxV2();
    const world = new World('v2-stage');
    world.block(10n); world.block(100n, [listingAddedLog(serviceListingV2()), boxLogsV2(box)]); world.to(200n);
    const chain = serviceChainV2(world, [box]);
    chain.tip = 90n;
    const got = await follow(chain);
    const byHash = chain.headerByHash.bind(chain);
    chain.headerByHash = async (hash) => hash === chain.header(100n).hash ? null : byHash(hash);
    chain.tip = 200n;
    await got.indexer.enqueue(chain.header(200n));
    expect(got.indexer.metrics.errors).toBe(1);
    expect(got.indexer.allRows()).toEqual([]);
    expect(got.indexer.listingsV2(V2.registry).listings).toEqual([]);
    chain.headerByHash = byHash;
    await got.indexer.enqueue(chain.header(200n));
    expect(got.indexer.v2FeedView().cards).toHaveLength(1);
  });
});

it('CQ11-E: direct platform Safe income and rollback', async () => {
  const box = serviceBoxV2(); const world = new World('safe-payments');
  world.block(10n); world.block(100n, [listingAddedLog(serviceListingV2()), boxLogsV2(box)]);
  world.block(101n, [receiverEventV2(box, 'PlatformPaid', { amount: 900719925474099312345n })]);
  world.to(105n); const chain = serviceChainV2(world, [box]); const got = await follow(chain);
  expect(got.indexer.v2FeedView().platform[0]).toMatchObject({ paidByToken: { [box.record.q.toLowerCase()]: '900719925474099312345' } });
  expect(got.indexer.v2FeedView().platform[0]).not.toHaveProperty('kept');
  const fork = world.fork(100n, 'safe-canonical');
  fork.block(101n, [receiverEventV2(box, 'PlatformPaid', { amount: 17n })]); fork.to(200n);
  chain.setBranch(fork.headers.filter((h) => h.number > 100n), fork.logs.filter((l) => l.blockNumber > 100n));
  await got.indexer.enqueue(chain.header(200n)); await got.indexer.idle();
  expect(got.indexer.v2FeedView().platform[0]).toMatchObject({ paidByToken: { [box.record.q.toLowerCase()]: '17' } });
  expect(got.indexer.v2FeedView()).toEqual((await follow(serviceChainV2(fork, [box]))).indexer.v2FeedView());
});

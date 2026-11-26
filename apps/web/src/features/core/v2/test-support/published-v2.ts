import { required } from './required';
import { CoreChainIndexer } from '../../../../../../../packages/indexer/src/core/chain-indexer';
import { World } from '../../../../../../../packages/indexer/test/core/core-synth';
import { boxLogsV2, eventV2, serviceBoxV2, serviceChainV2, serviceListingV2, listingAddedLog, synthManifestV2 } from '../../../../../../../packages/indexer/test/core/scripted-core-chain';
import type { V2Source } from '../indexer-v2';

export async function publishedV2(failed = true) {
  const box = serviceBoxV2(); const manifest = synthManifestV2();
  const world = new World('web-cq11');
  world.block(10n); world.block(99n, [listingAddedLog(serviceListingV2())]); world.block(100n, [boxLogsV2(box)]);
  world.block(101n, failed ? [
    eventV2('coordinator', 'BoxFailed', required(box.record.contracts[0]), { caller: box.record.creator, cause: 3, timestamp: 1000n }),
    eventV2('coordinator', 'PotFixed', required(box.record.contracts[0]), { pot: 10000001n, tLeft: 3n * 10n ** 18n, tip: 0n, closer: box.record.creator }),
  ] : []);
  const chain = serviceChainV2(world, [box], (_box, key) => {
    if (key === 'coordinator.claimState') return failed ? [10000001n, 3n * 10n ** 18n] : [0n, 0n];
    if (key === 'coordinator.failed' || key === 'hook.failed') return failed;
    if (key === 'receiver.creatorOwed') return [900719925474099300000001n, 0n];
    return undefined;
  });
  const indexer = new CoreChainIndexer({ reader: chain, manifest, auditEvery: 10000 });
  await indexer.start();
  const body = required(indexer.v2BoxView(required(box.record.contracts[1])));
  const feed = indexer.v2FeedView(); const listings = required(indexer.v2ListingsView(required(manifest.releases[0]).registry.address));
  indexer.stop();
  const source: V2Source = { network: 'local', origin: 'https://indexer.invalid', rpc: 'http://127.0.0.1:8599', manifest };
  return { body, feed, source, listings };
}

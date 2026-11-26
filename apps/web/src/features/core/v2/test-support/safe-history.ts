import { fitBuybackExecutorAbi } from '@squarehole/chain/abi';
import { CoreChainIndexer } from '../../../../../../../packages/indexer/src/core/chain-indexer';
import { toJson } from '../../../../../../../packages/indexer/src/model';
import { event, synthBox, synthManifest, World } from '../../../../../../../packages/indexer/test/core/core-synth';
import { boxLogsV2, eventV2, listingAddedLog, serviceBoxV2, serviceChainV2, serviceListingV2, synthManifestV2, V2 } from '../../../../../../../packages/indexer/test/core/scripted-core-chain';
import { parseSnapshotV2, type V2Source } from '../indexer-v2';
import { required } from './required';

/** Real mixed-version indexer output; no publisher or bot journal is simulated. */
export async function safeHistory() {
  const original = synthBox({ boxId: 0n, creationBlock: 100n });
  const shared = { poolManager: V2.poolManager, randomness: V2.randomness };
  const genesis = { ...original, row: { ...original.row, ...shared }, record: { ...original.record, ...shared } };
  const box = serviceBoxV2();
  const token = required(box.record.contracts[1]);
  const fit = required(genesis.row.contracts.token ?? undefined);
  const executor = required(genesis.row.contracts.executor ?? undefined);
  const receiver = required(box.record.contracts[5]);
  const manifest = { ...synthManifestV2(), versions: synthManifest().versions };
  const world = new World('safe-history');
  world.block(10n);
  world.block(99n, [listingAddedLog(serviceListingV2())]);
  world.block(100n, [world.created(genesis), boxLogsV2(box)]);
  world.block(101n, [
    eventV2('receiver', 'FitPaid', receiver, { safe: V2.platformSafe, amount: 900719925474099300000001n }),
    eventV2('receiver', 'PlatformPaid', receiver, { safe: V2.platformSafe, amount: 2000001n }),
    // RC5-C: royalties in another coin stay in the box's inbox; no Safe receives them (RoyaltyForwarded is gone).
    eventV2('receiver', 'RoyaltyFunded', receiver, { token: fit, amount: 13n }),
    event(fitBuybackExecutorAbi, executor, 'BudgetFunded', { from: V2.platformSafe, amount: 999n }),
  ]);
  world.block(102n, [event(fitBuybackExecutorAbi, executor, 'TokensBurned', { bought: 900719925474099300000001n, unsolicited: 2n })]);
  const chain = serviceChainV2(world, [box]);
  const code = chain.codeAnswers;
  chain.codeAnswers = (address, hash) => genesis.codes.get(address.toLowerCase()) ?? code(address, hash);
  chain.tip = 101n;
  const indexer = new CoreChainIndexer({ reader: chain, manifest, auditEvery: 10_000 });
  await indexer.start();
  const source: V2Source = { network: 'local', manifest, origin: 'https://indexer.invalid', rpc: 'http://127.0.0.1:8599' };
  const publication = () => ({
    source, body: required(indexer.v2BoxView(token)), view: parseSnapshotV2(required(indexer.v2BoxView(token)), source), feed: indexer.feedView(),
    activity: JSON.parse(toJson({ asOf: indexer.asOf(), items: required(indexer.recent(fit)).activity, next: null })) as { asOf: unknown; items: Record<string, unknown>[]; next: null },
  });
  const funded = publication();
  chain.tip = 102n;
  await indexer.enqueue(chain.header(102n));
  const burned = publication();
  // Replace the burn block: a reverted attempt emits no TokensBurned; the later retry burns exactly 7 raw FIT.
  const fork = world.fork(101n, 'safe-history-corrected');
  fork.block(102n);
  fork.block(103n, [event(fitBuybackExecutorAbi, executor, 'TokensBurned', { bought: 7n, unsolicited: 0n })]);
  chain.setBranch(fork.headers.filter((h) => h.number > 101n), fork.logs.filter((l) => l.blockNumber > 101n));
  await indexer.enqueue(chain.header(103n));
  const corrected = publication();
  indexer.stop();
  return { funded, burned, corrected, fit, executor };
}

import { expect, it } from 'vitest';
import { encodeErrorResult, type Hex } from 'viem';
import { coordinatorV2Abi } from '../../src/core/v2/chain-v2';
import { CoreChainIndexer } from '../../src/core/chain-indexer';
import { World } from '../core/core-synth';
import { boxLogsV2, eventV2, requiredV2, serviceBoxV2, serviceChainV2, serviceListingV2, listingAddedLog, synthManifestV2 } from '../core/scripted-core-chain';

const initial = (1n << 200n) + 7n;
const late = initial + 19n;
const claimedError = () => Object.assign(new Error('closed'), { data: encodeErrorResult({ abi: coordinatorV2Abi, errorName: 'InvalidClaim' }) });

it('FINAL2-OC01: canonical publication retries failed quotes and restores unclaimed claims after a reorg', async () => {
  const box = serviceBoxV2();
  const token = requiredV2(box.record.contracts[1]);
  const coordinator = requiredV2(box.record.contracts[0]);
  const world = new World('claim-publication');
  world.block(10n); world.block(99n, [listingAddedLog(serviceListingV2())]); world.block(100n, [boxLogsV2(box)]);
  world.block(101n, [
    eventV2('coordinator', 'BoxFailed', coordinator, { caller: box.record.creator, cause: 1, timestamp: 1000n }),
    eventV2('coordinator', 'PotFixed', coordinator, { pot: initial, tLeft: 0n, tip: 0n, closer: box.record.creator }),
  ]);
  world.block(102n, [eventV2('coordinator', 'Claimed', coordinator, { holder: box.record.creator, to: box.record.creator, t: 0n, p: initial })]);
  world.to(103n);
  const claimedHashes = new Set(world.headers.filter(h => h.number >= 102n).map(h => h.hash));
  const quotes: Hex[] = [];
  let offline = false;
  const chain = serviceChainV2(world, [box], (_box, key, hash) => {
    const n = chain.byHash.get(hash.toLowerCase())?.number ?? 0n;
    const claimed = claimedHashes.has(hash);
    if (key === 'coordinator.failed') return n >= 101n;
    if (key === 'coordinator.claimState') return [n < 101n ? 0n : claimed ? (n === 102n ? 0n : late) : initial + late, 0n];
    if (key === 'coordinator.quoteClaim') {
      quotes.push(hash);
      if (offline) throw new Error('canonical quote unavailable');
      if (claimed) throw claimedError();
      return initial;
    }
    if (key === 'receiver.fitOwed') return 0n;
    return undefined;
  });
  chain.tip = 101n;
  const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifestV2(), auditEvery: 10_000 });
  await indexer.start();
  const before = indexer.v2BoxView(token);
  expect(before).toMatchObject({ closing: { creatorEntitlement: String(initial) } });
  expect(quotes).toEqual([chain.header(101n).hash]);

  offline = true; chain.tip = 102n;
  await indexer.enqueue(chain.header(102n));
  expect(indexer.head()?.number).toBe(101n);
  expect(indexer.v2BoxView(token)).toEqual(before);
  offline = false;
  await indexer.enqueue(chain.header(102n));
  expect(indexer.v2BoxView(token)).toMatchObject({
    closing: { pot: '0', creatorEntitlement: '0' },
    safePaid: { fit: {} }, money: { hash: chain.header(102n).hash, owed: { fitOwed: '0' } },
  });
  chain.tip = 103n; await indexer.enqueue(chain.header(103n));
  expect(indexer.v2BoxView(token)).toMatchObject({ closing: { pot: String(late), creatorEntitlement: '0' } });

  const fork = world.fork(101n, 'claim-removed'); fork.to(104n);
  chain.setBranch(fork.headers.filter(h => h.number > 101n), []);
  await indexer.enqueue(chain.header(104n));
  expect(indexer.v2BoxView(token)).toMatchObject({
    closing: { creatorEntitlement: String(initial) },
    money: { hash: chain.header(104n).hash },
  });
  expect(quotes).toContain(chain.header(104n).hash);
  const clean = new CoreChainIndexer({ reader: chain, manifest: synthManifestV2(), auditEvery: 10_000 });
  await clean.start();
  expect(clean.v2BoxView(token)?.closing).toEqual(indexer.v2BoxView(token)?.closing);
  indexer.stop(); clean.stop();
});

it('FINAL2-OC01: a consumed zero creator claim does not invent a FIT receipt', async () => {
  const box = serviceBoxV2(); const token = requiredV2(box.record.contracts[1]);
  const coordinator = requiredV2(box.record.contracts[0]);
  const world = new World('empty-claim');
  world.block(10n); world.block(99n, [listingAddedLog(serviceListingV2())]); world.block(100n, [boxLogsV2(box)]);
  world.block(101n, [
    eventV2('coordinator', 'BoxFailed', coordinator, { caller: box.record.creator, cause: 1, timestamp: 1000n }),
    eventV2('coordinator', 'PotFixed', coordinator, { pot: 0n, tLeft: 0n, tip: 0n, closer: box.record.creator }),
  ]);
  world.to(102n);
  const chain = serviceChainV2(world, [box], (_box, key, hash) => {
    if (key === 'coordinator.failed') return (chain.byHash.get(hash.toLowerCase())?.number ?? 0n) >= 101n;
    if (key === 'coordinator.quoteClaim') throw claimedError();
    return undefined;
  });
  const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifestV2(), auditEvery: 10_000 });
  await indexer.start();
  expect(indexer.v2BoxView(token)).toMatchObject({ closing: { pot: '0', creatorEntitlement: '0' } });
  indexer.stop();
});

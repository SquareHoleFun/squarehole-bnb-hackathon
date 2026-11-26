import { describe, expect, it } from 'vitest';
import { encodeErrorResult } from 'viem';
import { CoreChainIndexer } from '../../../src/core/chain-indexer';
import { coordinatorV2Abi } from '../../../src/core/v2/chain-v2';
import { World } from '../core-synth';
import { boxLogsV2, eventV2, requiredV2, serviceBoxV2, serviceChainV2, serviceListingV2, listingAddedLog, synthManifestV2, V2 } from '../scripted-core-chain';
import { deferred } from '../core-art-deferred';

function fixture() {
  const box = serviceBoxV2(); const token = requiredV2(box.record.contracts[1]);
  const world = new World('claim-reads');
  world.block(10n); world.block(99n, [listingAddedLog(serviceListingV2())]); world.block(100n, [boxLogsV2(box)]);
  world.block(101n, [
    eventV2('coordinator', 'BoxFailed', requiredV2(box.record.contracts[0]), { caller: box.record.creator, cause: 3, timestamp: 1000n }),
    eventV2('coordinator', 'PotFixed', requiredV2(box.record.contracts[0]), { pot: 10_000_001n, tLeft: 3n * 10n ** 18n, tip: 3n, closer: box.record.creator }),
  ]);
  world.to(103n);
  const chain = serviceChainV2(world, [box], (_box, key, hash) => {
    const block = chain.byHash.get(hash.toLowerCase())?.number ?? 0n;
    const failed = block >= 101n;
    if (key === 'coordinator.claimState') return failed ? [block >= 102n ? 12_000_001n : 10_000_001n, 3n * 10n ** 18n] : [0n, 0n];
    if (key === 'coordinator.failed' || key === 'hook.failed') return failed;
    if (key === 'receiver.fitOwed') return 900719925474099312345n;
    if (key === 'receiver.platformOwed') return 789n;
    if (key === 'receiver.buyBackP') return 123n;
    if (key === 'receiver.tBurnPending') return 25n;
    return undefined;
  });
  return { box, token, world, chain };
}

describe('CQ11-E canonical money reads', () => {
  it('shows live pot deposits even without a box event, P per whole coin, owed ledgers and Safe addresses', async () => {
    const { chain, token } = fixture(); const reads: string[] = [];
    const call = chain.callAt.bind(chain); chain.callAt = async (to, data, hash) => { reads.push(hash); return call(to, data, hash); };
    const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifestV2(), auditEvery: 10_000 });
    await indexer.start();
    expect(indexer.v2BoxView(token)).toMatchObject({
      money: { block: '103', hash: chain.header(103n).hash, owed: { fitOwed: '900719925474099312345', platformOwed: '789', buyBackP: '123', tBurnPending: '25' }, safes: { fit: V2.platformSafe, platform: V2.platformSafe } },
      closing: { pot: '12000001', tLeft: '3000000000000000000', pricePerTX18: '4000000333333333333333333', pricePerTDisplay: '4.000000333333333333333333' },
    });
    expect(reads).toContain(chain.header(103n).hash);
    expect(JSON.stringify(indexer.v2BoxView(token))).toContain('900719925474099312345');
  });
  it('a missing money read publishes no partial block and retries the same canonical block', async () => {
    const { chain, token } = fixture(); chain.tip = 100n;
    const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifestV2(), auditEvery: 10_000 }); await indexer.start();
    const before = indexer.v2BoxView(token); const call = chain.callAt.bind(chain);
    chain.callAt = async () => { throw new Error('money read offline'); }; chain.tip = 103n;
    await indexer.enqueue(chain.header(103n));
    expect(indexer.head()?.number).toBe(100n);
    expect(indexer.v2BoxView(token)).toEqual(before);
    chain.callAt = call; await indexer.enqueue(chain.header(103n));
    expect(indexer.head()?.number).toBe(103n);
    expect(indexer.v2BoxView(token)).toMatchObject({ closing: { pot: '12000001' } });
  });
});

it('CQ11-E a failed audit clears verification, and a reorg cannot retain its orphan verdict', async () => {
  const box = serviceBoxV2(); const token = requiredV2(box.record.contracts[1]); const world = new World('audit-fork');
  world.block(10n); world.block(99n, [listingAddedLog(serviceListingV2())]); world.block(100n, [boxLogsV2(box)]); world.to(103n);
  const chain = serviceChainV2(world, [box]);
  const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifestV2(), auditEvery: 10_000 }); await indexer.start();
  expect((await indexer.audit()).map((r) => r.result.ok)).toEqual([true]);
  const call = chain.callAt.bind(chain); chain.callAt = async () => { throw new Error('audit offline'); };
  expect(await indexer.audit()).toEqual([]); expect(indexer.v2BoxView(token)?.verified).toBeNull();
  chain.callAt = call; await indexer.audit();
  const fork = world.fork(100n, 'audit-new'); fork.to(104n);
  chain.setBranch(fork.headers.filter((h) => h.number > 100n), []); await indexer.enqueue(chain.header(104n));
  expect(indexer.v2BoxView(token)).toMatchObject({ verified: null, audit: null, money: { hash: chain.header(104n).hash } });
});

it('CQ11-E a reorg during asynchronous reads cannot publish orphan money', async () => {
  const { box, chain, world, token } = fixture(); chain.tip = 100n;
  const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifestV2(), auditEvery: 10_000 }); await indexer.start();
  const call = chain.callAt.bind(chain); let changed = false;
  chain.callAt = async (...args) => {
    const value = await call(...args);
    if (!changed) { changed = true; const fork = world.fork(100n, 'money-new'); fork.to(104n); chain.setBranch(fork.headers.filter((h) => h.number > 100n), []); }
    return value;
  };
  chain.tip = 103n; await indexer.enqueue(chain.header(103n));
  expect(indexer.head()?.number).toBe(100n); expect(indexer.v2BoxView(token)?.failed).toBeNull();
  const clean = serviceChainV2({ headers: [...chain.canonical.keys()].map((n) => chain.header(n)), logs: world.logs.filter((l) => l.blockNumber <= 100n) }, [box]);
  chain.callAt = clean.callAt.bind(clean); await indexer.enqueue(chain.header(104n));
  expect(indexer.head()?.number).toBe(104n); expect(indexer.v2BoxView(token)?.failed).toBeNull();
});

it('CQ11-E restarting during money reads cannot revive a stopped block fold', async () => {
  const { chain } = fixture(); chain.tip = 100n;
  const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifestV2(), auditEvery: 10_000 }); await indexer.start();
  const call = chain.callAt.bind(chain); const resumed = deferred<number>(); let restart: Promise<void> | undefined;
  chain.chainId = () => resumed.promise;
  chain.callAt = async (...args) => {
    const value = await call(...args);
    if (!restart) { indexer.stop(); restart = indexer.start(); }
    return value;
  };
  chain.tip = 103n; await indexer.enqueue(chain.header(103n));
  const stoppedAt = indexer.head()?.number;
  chain.callAt = call; resumed.resolve(V2.chainId); await restart;
  expect(stoppedAt).toBe(100n);
  expect(indexer.head()?.number).toBe(103n);
});

it.each([false, true])('CQ11-E exhausted claims keep late P apart; no buyers=%s', async (noBuyers) => {
  const box = serviceBoxV2(); const token = requiredV2(box.record.contracts[1]); const coordinator = requiredV2(box.record.contracts[0]);
  const world = new World(`late-${noBuyers}`); world.block(10n); world.block(99n, [listingAddedLog(serviceListingV2())]); world.block(100n, [boxLogsV2(box)]);
  world.block(101n, [eventV2('coordinator', 'BoxFailed', coordinator, { caller: box.record.creator, cause: 1, timestamp: 1000n }), eventV2('coordinator', 'PotFixed', coordinator, { pot: 20n, tLeft: noBuyers ? 0n : 10n, tip: 1n, closer: box.record.creator })]);
  world.block(103n, [eventV2('coordinator', 'Claimed', coordinator, { holder: box.record.creator, to: box.record.creator, t: noBuyers ? 0n : 10n, p: noBuyers ? 20n : 53n })]);
  world.block(105n); world.to(106n);
  const chain = serviceChainV2(world, [box], (_b, key, hash) => {
    const n = chain.byHash.get(hash)?.number ?? 0n;
    if (key === 'coordinator.quoteClaim') {
      if (noBuyers && n >= 101n && n < 103n) return 20n;
      throw Object.assign(new Error('creator claim exhausted'), { data: encodeErrorResult({ abi: coordinatorV2Abi, errorName: 'InvalidClaim' }) });
    }
    if (key === 'coordinator.claimState') return [n >= 104n ? 33n : n >= 103n ? (noBuyers ? 33n : 0n) : n >= 102n ? 53n : n >= 101n ? 20n : 0n, !noBuyers && n >= 101n && n < 103n ? 10n : 0n];
    return undefined;
  }); chain.tip = 102n;
  const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifestV2(), auditEvery: 10_000 }); await indexer.start();
  expect(indexer.v2BoxView(token)?.closing).toMatchObject({ pot: '53', creatorEntitlement: noBuyers ? '20' : '0' });
  chain.tip = 104n; await indexer.enqueue(chain.header(104n));
  expect(indexer.v2BoxView(token)?.closing).toMatchObject({ pot: '33', tLeft: '0', creatorEntitlement: '0', pricePerTX18: '0' });
  chain.tip = 106n; await indexer.enqueue(chain.header(106n));
  expect(indexer.v2BoxView(token)).toMatchObject({ closing: { pot: '33' } });
});

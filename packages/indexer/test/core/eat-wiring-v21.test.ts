import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, type Hex } from 'viem';
import { CoreChainIndexer } from '../../src/core/chain-indexer';
import { listingBurnV21Abi, listingRegistryV2Abi } from '../../src/core/v2/chain-v2';
import { World } from './core-synth';
import { boxLogsV2, eventV2, listingAddedLog, serviceBoxV2, serviceChainV2, serviceListingV2, synthManifestV2, V2 } from './scripted-core-chain';

const selector = '0x42966c68';
function fixture(checked = true) {
  const box = serviceBoxV2();
  const listing = serviceListingV2();
  const world = new World('eat-wiring');
  world.block(10n);
  world.block(99n, [listingAddedLog(listing), ...(checked ? [eventV2('listingRegistry', 'CheckedBurnRecorded', V2.listingRegistry,
    { id: listing.id, token: listing.token, selector })] : [])]);
  world.block(100n, [boxLogsV2(box)]);
  world.to(200n);
  const chain = serviceChainV2(world, [box]);
  const baseCall = chain.callAt.bind(chain);
  const capabilityHashes: Hex[] = [];
  let answer: (hash: Hex) => Hex = () => selector;
  chain.callAt = async (to, data, hash) => {
    if (to.toLowerCase() === V2.listingRegistry.toLowerCase()) {
      const decoded = decodeFunctionData({ abi: [...listingRegistryV2Abi, ...listingBurnV21Abi], data });
      if (decoded.functionName === 'checkedBurnSelector') {
        capabilityHashes.push(hash);
        expect(decoded.args).toEqual([listing.token]);
        return encodeFunctionResult({ abi: listingBurnV21Abi, functionName: 'checkedBurnSelector', result: answer(hash) });
      }
    }
    return baseCall(to, data, hash);
  };
  const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifestV2(), auditEvery: 10_000 });
  return { world, chain, indexer, capabilityHashes, setAnswer: (fn: typeof answer) => { answer = fn; } };
}

describe('WIRING-I: canonical checked listing capability', () => {
  it.each([100n, 200n])('audits discovery and creation through the capability reader at head %s', async head => {
    const f = fixture();
    f.chain.tip = 90n;
    await f.indexer.start();
    try {
      f.chain.tip = head;
      await f.indexer.enqueue(f.chain.header(head));
      expect(f.indexer.metrics.errors).toBe(0);
      expect(f.indexer.v2FeedView().cards).toHaveLength(1);
      expect(f.indexer.v2ListingsView(V2.registry)?.listings[0]).toMatchObject({ checkedBurnSelector: selector,
        detail: { checkedBurnSelector: selector, decimals: 6, raise: serviceListingV2().raise.toString() } });
      expect(f.capabilityHashes).toContain(f.chain.header(99n).hash);
      expect(f.capabilityHashes).toContain(f.chain.header(100n).hash);
    } finally { f.indexer.stop(); }
  });

  it('keeps legacy listings on the legacy reader without inventing an unchecked capability', async () => {
    const f = fixture(false);
    f.setAnswer(() => { throw new Error('legacy selector absent'); });
    await f.indexer.start();
    try {
      expect(f.indexer.v2FeedView().cards).toHaveLength(1);
      expect(f.capabilityHashes).toEqual([]);
      expect(f.indexer.v2ListingsView(V2.registry)?.listings[0]).not.toHaveProperty('checkedBurnSelector');
      expect(f.indexer.v2ListingsView(V2.registry)?.listings[0]).not.toHaveProperty('detail.checkedBurnSelector');
    } finally { f.indexer.stop(); }
  });

  it.each(['unavailable', 'mismatch'] as const)('refuses a %s capability without publishing an unchecked row, then retries', async failure => {
    const f = fixture();
    f.chain.tip = 90n;
    await f.indexer.start();
    try {
      f.setAnswer(() => { if (failure === 'unavailable') throw new Error('capability unavailable'); return '0x00000000'; });
      f.chain.tip = 200n;
      await f.indexer.enqueue(f.chain.header(200n));
      expect(f.indexer.metrics.errors).toBe(1);
      expect(f.indexer.listingsV2(V2.registry).listings).toEqual([]);
      expect(f.indexer.allRows()).toEqual([]);
      f.setAnswer(() => selector);
      await f.indexer.enqueue(f.chain.header(200n));
      expect(f.indexer.v2FeedView().cards).toHaveLength(1);
      expect(f.indexer.v2ListingsView(V2.registry)?.listings[0]).toHaveProperty('detail.checkedBurnSelector', selector);
    } finally { f.indexer.stop(); }
  });

  it.each(['unavailable', 'mismatch'] as const)('refuses a %s creation-block capability even after successful listing admission reads', async failure => {
    const f = fixture();
    f.chain.tip = 99n;
    await f.indexer.start();
    try {
      f.setAnswer(hash => {
        if (hash === f.chain.header(100n).hash) {
          if (failure === 'unavailable') throw new Error('creation capability unavailable');
          return '0x00000000';
        }
        return selector;
      });
      f.chain.tip = 100n;
      await f.indexer.enqueue(f.chain.header(100n));
      expect(f.indexer.metrics.errors).toBe(1);
      expect(f.indexer.allRows()).toEqual([]);
      expect(f.indexer.v2ListingsView(V2.registry)?.listings[0]).toHaveProperty('detail.checkedBurnSelector', selector);
    } finally { f.indexer.stop(); }
  });

  it('retains and rechecks capability after a raise update, and drops it with an orphaned admission', async () => {
    const f = fixture();
    f.chain.tip = 100n;
    await f.indexer.start();
    try {
      const listing = serviceListingV2();
      // An equal-value update still re-reads the immutable capability at the new canonical hash.
      f.world.block(201n, [eventV2('listingRegistry', 'RaiseUpdated', V2.listingRegistry,
        { id: listing.id, previousRaise: listing.raise, raise: listing.raise })]);
      f.chain.setBranch(f.world.headers.filter(h => h.number > 100n), f.world.logs.filter(l => l.blockNumber > 100n));
      await f.indexer.enqueue(f.chain.header(201n));
      expect(f.indexer.metrics.errors).toBe(0);
      expect(f.capabilityHashes).toContain(f.chain.header(201n).hash);
      expect(f.indexer.v2ListingsView(V2.registry)?.listings[0]).toHaveProperty('detail.checkedBurnSelector', selector);
      const fork = f.world.fork(98n, 'legacy-admission');
      fork.block(99n, [listingAddedLog(listing)]); fork.to(202n);
      f.chain.setBranch(fork.headers.filter(h => h.number > 98n), fork.logs.filter(l => l.blockNumber > 98n));
      await f.indexer.enqueue(f.chain.header(202n));
      expect(f.indexer.v2ListingsView(V2.registry)?.listings[0]).not.toHaveProperty('detail.checkedBurnSelector');
    } finally { f.indexer.stop(); }
  });
});

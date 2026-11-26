import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionResult } from 'viem';
import { synthBoxV2 } from '../../../../chain/src/core/v2/test-support/synth-v2';
import { listingRegistryV2Abi } from '../../../../chain/src/core/v2/abi-v2';
import { CoreChainIndexer } from '../../../src/core/chain-indexer';
import { World } from '../core-synth';
import { requiredV2, serviceChainV2, serviceListingV2, synthManifestV2, boxLogsV2, listingAddedLog, eventV2, V2 } from '../scripted-core-chain';

const initialRaise = 9007199254740993000001n;
const raised = initialRaise + 77n;
const updated = (previousRaise: bigint, raise: bigint) => eventV2('listingRegistry', 'RaiseUpdated', V2.listingRegistry, { id: 7, previousRaise, raise });
function fixture(end = 105n, sameBlock = false) {
  const box = synthBoxV2({ boxId: 4n, raise: initialRaise, pricing: { listingId: 7, token: V2.weth } });
  const listing = { ...serviceListingV2(), raise: initialRaise };
  const world = new World('cq11-listing');
  world.block(10n); world.block(99n, [listingAddedLog(listing)]);
  world.block(100n, [boxLogsV2(box)]);
  world.block(101n, sameBlock ? [updated(initialRaise, raised - 1n), updated(raised - 1n, raised)] : [updated(initialRaise, raised)]);
  world.to(end);
  const chain = serviceChainV2(world, [box]);
  const moneyCall = chain.callAt.bind(chain);
  const detail = (raise: bigint) => ({ id: 7, token: listing.token, decimals: 6, class: listing.class, kind: listing.kind, listedAt: 1n, raise, q: { bootstrapQ: raise / 1000n, batchMinQ: 1n, tipMaxQ: 1n, swapStepMinQ: 1n } });
  chain.callAt = async (to, data, hash) => {
    if (to.toLowerCase() !== V2.listingRegistry.toLowerCase()) return moneyCall(to, data, hash);
    expect(decodeFunctionData({ abi: listingRegistryV2Abi, data }).functionName).toBe('listing');
    const block = chain.byHash.get(hash.toLowerCase())?.number ?? 0n;
    return encodeFunctionResult({ abi: listingRegistryV2Abi, functionName: 'listing', result: detail(block >= 101n ? raised : initialRaise) });
  };
  const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifestV2(), auditEvery: 10_000 });
  return { box, world, chain, indexer, detail, moneyCall };
}

describe('CQ11 permanent rows through live admission and replay', () => {
  for (const end of [105n, 200n]) for (const sameBlock of [false, true]) {
    it(`validates rows and refreshes raises at head ${end}, same-block updates=${sameBlock}`, async () => {
      const { chain, indexer, box } = fixture(end, sameBlock);
      const calls = vi.spyOn(chain, 'callAt');
      await indexer.start();
      expect(indexer.metrics.errors).toBe(0);
      expect(indexer.v2FeedView().cards).toHaveLength(1);
      expect(indexer.listingsV2(V2.registry).byId(7)?.raise).toBe(raised);
      expect(indexer.v2ListingsView(V2.registry)?.listings[0]).toMatchObject({ raise: raised.toString(), detail: { raise: raised.toString(), q: { bootstrapQ: (raised / 1000n).toString() } } });
      expect(indexer.v2BoxView(requiredV2(box.record.contracts[1]))?.row.record.raise).toBe(initialRaise.toString());
      expect(calls.mock.calls.some(([to]) => to.toLowerCase() === V2.listingRegistry.toLowerCase())).toBe(true);
      expect(calls.mock.calls.some(([to]) => to.toLowerCase() === requiredV2(box.record.contracts[5]).toLowerCase())).toBe(true);
    });
  }

  it.each(['id', 'token', 'class', 'kind', 'raise', 'decimals'] as const)('rejects a mismatched or invalid canonical %s', async (field) => {
    const { chain, indexer, detail } = fixture();
    const bad = { ...detail(initialRaise), [field]: field === 'token' ? V2.registry : field === 'raise' ? raised : field === 'decimals' ? 37 : 0 };
    chain.callAt = async () => encodeFunctionResult({ abi: listingRegistryV2Abi, functionName: 'listing', result: bad });
    await indexer.start();
    expect(indexer.metrics.lastError).toMatch(/listing (record|JSON)/);
    expect(indexer.v2FeedView().cards).toHaveLength(0);
    expect(indexer.listingsV2(V2.registry).listings).toHaveLength(0);
  });

  it('rolls back refreshed details with the raise event and preserves the original box', async () => {
    const { chain, indexer, world, box, detail, moneyCall } = fixture();
    await indexer.start();
    expect(indexer.metrics.errors).toBe(0);
    const fork = world.fork(100n, 'cq11-raise-gone'); fork.to(106n);
    chain.setBranch(fork.headers.filter((h) => h.number > 100n), []);
    chain.callAt = async (to, data, hash) => to.toLowerCase() === V2.listingRegistry.toLowerCase()
      ? encodeFunctionResult({ abi: listingRegistryV2Abi, functionName: 'listing', result: detail(initialRaise) })
      : moneyCall(to, data, hash);
    await indexer.enqueue(chain.header(106n));
    expect(indexer.v2ListingsView(V2.registry)?.listings[0]).toMatchObject({ raise: initialRaise.toString(), detail: { raise: initialRaise.toString() } });
    expect(indexer.v2BoxView(requiredV2(box.record.contracts[1]))?.row.record.raise).toBe(initialRaise.toString());
  });

  it('audits current money storage without reading retired emitters', async () => {
    const { chain, indexer } = fixture();
    const filters = vi.spyOn(chain, 'logsByHash');
    await indexer.start();
    expect(indexer.metrics.errors).toBe(0);
    const calls = vi.spyOn(chain, 'callAt'); calls.mockClear();
    await indexer.audit();
    expect(calls).toHaveBeenCalled();
    expect(indexer.v2FeedView().cards[0]?.verified).toBe(true);
    for (const [to] of calls.mock.calls) {
      expect(to.toLowerCase()).not.toBe(V2.platformCap.toLowerCase());
      expect(to.toLowerCase()).not.toBe(serviceListingV2().converter.toLowerCase());
    }
    for (const [, filter] of filters.mock.calls) {
      expect(filter.addresses.map((a) => a.toLowerCase())).not.toContain(V2.platformCap.toLowerCase());
      expect(filter.addresses.map((a) => a.toLowerCase())).not.toContain(serviceListingV2().converter.toLowerCase());
    }
  });
});

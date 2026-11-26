import { decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, parseAbi, parseAbiParameters, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { listingRegistryV2Abi } from '../../../../chain/src/core/v2/abi-v2';
import { synthManifestV2, synthBoxV2, listingAddedLog, synthListing } from '../../../../chain/src/core/v2/test-support/synth-v2';
import { routeV2, type CoreEventV2 } from '../../../src/core/v2/events-v2';
import { boxesOnListingV2, listingBookV2, readListingDetailV2, listingDetailToJson, listingDetailFromJson } from '../../../src/core/v2/listings-v2';

const token = '0x0000000000000000000000000000000000000011' as Address;
const hash = `0x${'12'.repeat(32)}` as Hex;
const firstRelease = synthManifestV2().releases[0];
if (!firstRelease) throw new Error('missing synthetic release');
const release = firstRelease;
const abi = parseAbi(['event ListingAdded(uint32 indexed id, address indexed token, uint8 class, uint8 kind, uint256 raise)', 'event RaiseUpdated(uint32 indexed id, uint256 previousRaise, uint256 raise)']);
const oldRaise = 9007199254740993000001n;
const newRaise = oldRaise + 777n;
function event(name: 'ListingAdded' | 'RaiseUpdated', block = 1n, raise = newRaise, previousRaise = oldRaise): CoreEventV2 {
  const topics = encodeEventTopics({ abi, eventName: name, args: name === 'ListingAdded' ? { id: 7, token } : { id: 7 } }) as [Hex, ...Hex[]];
  const data = name === 'ListingAdded' ? encodeAbiParameters(parseAbiParameters('uint8,uint8,uint256'), [3, 1, oldRaise]) : encodeAbiParameters(parseAbiParameters('uint256,uint256'), [previousRaise, raise]);
  const decoded = decodeEventLog({ abi, topics, data });
  return { source: 'listingRegistry', name, args: decoded.args, address: release.listingRegistry.address, ref: { blockNumber: block, blockHash: hash, txHash: hash, txIndex: 0, logIndex: 0 }, boxId: null, listingId: null };
}

describe('CQ11-0 permanent listings', () => {
  it('never discovers removed converters from legacy listing metadata', () => {
    const manifest = synthManifestV2();
    const legacy = { id: 7, converter: token };
    const route = routeV2(release, manifest, [legacy], [synthBoxV2({ boxId: 1n }).record]);
    expect(route).not.toHaveProperty('converters');
    expect(route).not.toHaveProperty('platformCap');
    expect(route).not.toHaveProperty('ethInHelper');
    expect([...route.parts.values()].map((p) => p.role)).not.toContain('swapModule');
    expect([...route.parts.values()].map((p) => p.role)).not.toContain('sampler');
  });
  it('encodes shared listing fixtures with the frozen permanent-row ABI', () => {
    const row = synthListing(7, token, { raise: oldRaise });
    const log = listingAddedLog(row);
    const decoded = decodeEventLog({ abi, topics: log.topics as [Hex, ...Hex[]], data: log.data });
    expect(decoded.args).toMatchObject({ id: 7, token, raise: oldRaise });
    expect(decoded.args).not.toHaveProperty('converter');
  });
  it('builds a row from only the new decoded ListingAdded fields', () => {
    const book = listingBookV2([event('ListingAdded')]);
    expect(book.byId(7)).toMatchObject({ id: 7, token, class: 'STABLE', kind: 'LISTED', raise: oldRaise });
    expect(book.ofToken(token)).toHaveLength(1);
    expect(book.byId(7)).not.toHaveProperty('routeHash');
    expect(book.byId(7)).not.toHaveProperty('converter');
  });
  it('applies raises in chain order to the permanent row without changing existing boxes', () => {
    const book = listingBookV2([event('RaiseUpdated', 3n, newRaise + 1n, newRaise), event('ListingAdded'), event('RaiseUpdated', 2n)]);
    expect(book.newestOf(token)?.raise).toBe(newRaise + 1n);
    expect(book.ofToken(token)).toHaveLength(1);
    const record = synthBoxV2({ boxId: 1n }).record;
    expect(boxesOnListingV2(book, 7, [{ ...record, pricingListingId: 7, raise: oldRaise }])).toEqual([{ boxId: 1n, raise: oldRaise }]);
  });
  it('reads only the permanent listing tuple and preserves bigint through JSON', async () => {
    const raw = { id: 7, token, decimals: 6, class: 3, kind: 1, listedAt: 10n, raise: newRaise, q: { bootstrapQ: 1n, batchMinQ: 2n, tipMaxQ: 3n, swapStepMinQ: 4n } };
    const calls: string[] = [];
    const reader = { callAt: async (_to: string, data: Hex, blockHash: Hex) => {
      expect(blockHash).toBe(hash);
      const call = decodeFunctionData({ abi: listingRegistryV2Abi, data });
      calls.push(call.functionName);
      return encodeFunctionResult({ abi: listingRegistryV2Abi, functionName: 'listing', result: raw });
    } };
    const detail = await readListingDetailV2(reader, release, 7, hash);
    expect(calls).toEqual(['listing']);
    expect(detail).toEqual({ ...raw, class: 'STABLE', kind: 'LISTED' });
    expect(listingDetailToJson(detail)).toMatchObject({ raise: newRaise.toString() });
    expect(listingDetailFromJson(listingDetailToJson(detail))).toEqual(detail);
  });
});

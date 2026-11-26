import { F143_DRAND, withF143 } from './f143-synth';
/** CQ11-0: independent event vectors for permanent listings, close/claim and surviving parts. */
import { encodeAbiParameters, keccak256, pad, parseAbiParameters, toBytes, toHex, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import type { RawLog } from '../../src/events';
import { decodeV2Log, decodeV2Logs, routeV2 } from '../../src/core/v2/events-v2';
import { synthBoxV2, synthManifestV2, V2 } from '../../../chain/src/core/v2/test-support/synth-v2';

const topic = (signature: string): Hex => keccak256(toBytes(signature));
const w = (v: bigint | Address): Hex => (typeof v === 'bigint' ? pad(toHex(v)) : pad(v));
let index = 0;
const raw = (address: Address, topics: Hex[], data: Hex, block = 100n): RawLog => ({ address, topics, data, blockNumber: block, blockHash: keccak256(toHex(block)), transactionHash: keccak256(toHex(block + 1n)), transactionIndex: 0, logIndex: index++ });

const release = synthManifestV2().releases[0];
if (!release) throw new Error('synthetic release');
const box = synthBoxV2({ boxId: 4n });
const role = (i: number): Address => box.record.contracts[i] as Address;
const CONVERTER = '0xc0de00000000000000000000000000000000c0de' as Address;
const route = routeV2(release, synthManifestV2(), [{ id: 7 }], [box.record]);

describe('CQ11 v2 event vectors', () => {
  it('decodes permanent rows, raise changes, claim pots and hook fees', () => {
    const token = '0x00000000000000000000000000000000000070ce' as Address;
    const listing = decodeV2Log(raw(V2.listingRegistry, [topic('ListingAdded(uint32,address,uint8,uint8,uint256)'), w(7n), w(token)], encodeAbiParameters(parseAbiParameters('uint8,uint8,uint256'), [4, 1, 5n * 10n ** 18n])), route);
    expect(listing).toMatchObject({ source: 'listingRegistry', name: 'ListingAdded', boxId: null, args: { id: 7, class: 4, kind: 1, raise: 5n * 10n ** 18n } });
    const raised = decodeV2Log(raw(V2.listingRegistry, [topic('RaiseUpdated(uint32,uint256,uint256)'), w(7n)], encodeAbiParameters(parseAbiParameters('uint256,uint256'), [5n, 6n])), route);
    expect(raised).toMatchObject({ source: 'listingRegistry', name: 'RaiseUpdated', args: { id: 7, previousRaise: 5n, raise: 6n } });
    const owner = '0x000000000000000000000000000000000000000A' as Address;
    const pot = decodeV2Log(raw(role(0), [topic('PotFixed(uint256,uint256,uint256,address)'), w(owner)], encodeAbiParameters(parseAbiParameters('uint256,uint256,uint256'), [100n, 20n, 1n])), route);
    expect(pot).toMatchObject({ source: 'coordinator', name: 'PotFixed', boxId: 4n, args: { pot: 100n, tLeft: 20n, tip: 1n } });
    const fee = (pool: Hex) => raw(role(2), [topic('SaleFee(bytes32,address,uint256)'), pool, w(owner)], encodeAbiParameters(parseAbiParameters('uint256'), [5n]));
    expect(decodeV2Log(fee(box.record.poolId), route)).toMatchObject({ source: 'hook', name: 'SaleFee', boxId: 4n, args: { fee: 5n } });
    expect(decodeV2Log(fee(w(7n)), route)).toBeNull();
  });

  it('rejects removed emitters, unknown emitters and removed logs', () => {
    const sig = topic('FitFunded(uint256,uint8,uint256)');
    const log = raw(CONVERTER, [sig, w(4n), w(1n)], encodeAbiParameters(parseAbiParameters('uint256'), [9n]));
    expect(decodeV2Log(log, route)).toBeNull();
    const known = raw(V2.listingRegistry, [topic('RaiseUpdated(uint32,uint256,uint256)'), w(7n)], encodeAbiParameters(parseAbiParameters('uint256,uint256'), [1n, 2n]));
    expect(decodeV2Log({ ...known, removed: true }, route)).toBeNull();
    for (const address of [CONVERTER, V2.platformCap, V2.ethInHelper, role(11), role(13)]) {
      expect(decodeV2Log({ ...known, address }, route)).toBeNull();
    }
  });

  it('reads direct Safe payouts only from the receiver', () => {
    const sig = topic('PlatformPaid(address,uint256)');
    const logs = [raw(role(5), [sig, w(V2.platformSafe)], encodeAbiParameters(parseAbiParameters('uint256'), [3n])), raw(V2.platformCap, [sig, w(V2.platformSafe)], encodeAbiParameters(parseAbiParameters('uint256'), [2n]))];
    expect(decodeV2Logs(logs, route).map((e) => [e.source, e.name, e.boxId])).toEqual([['receiver', 'PlatformPaid', 4n]]);
  });

  it('retains the vault and creator-payee event vectors', () => {
    const owner = '0x00000000000000000000000000000000000000a1' as Address;
    const cases: [Address, string, Hex[], Hex, string, Record<string, unknown>][] = [
      [role(3), 'Withdrawn(address,uint256[],uint256,uint256,uint256,uint256,uint256)', [w(owner)], encodeAbiParameters(parseAbiParameters('uint256[], uint256, uint256, uint256, uint256, uint256'), [[1n, 2n], 3n, 4n, 5n, 6n, 7n]), 'vault', { principal: 3n, insideAfter: 7n }],
      [role(3), 'Returned(address,uint256[],uint256,uint256,uint256,uint256,uint256)', [w(owner)], encodeAbiParameters(parseAbiParameters('uint256[], uint256, uint256, uint256, uint256, uint256'), [[9n], 3n, 4n, 5n, 6n, 7n]), 'vault', { fee: 4n }],
      [role(3), 'TicketsOpened(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)', [], encodeAbiParameters(parseAbiParameters('uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256'), [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]), 'vault', { count: 1n, ticketsAfter: 8n }],
      [role(3), 'TicketsReleased(address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)', [w(owner)], encodeAbiParameters(parseAbiParameters('uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256'), [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]), 'vault', { count: 1n }],
      [role(3), 'TicketDelivered(uint256,address,uint256,uint256)', [w(5n), w(owner)], encodeAbiParameters(parseAbiParameters('uint256, uint256'), [1_800_000_000n, 2n]), 'vault', { id: 5n, requestedAt: 1_800_000_000n, ticketsAfter: 2n }],
      [role(3), 'HandBackFeeWaived(address,uint256)', [w(role(0))], encodeAbiParameters(parseAbiParameters('uint256'), [9n]), 'vault', { timestamp: 9n }],
      [role(5), 'CreatorPayeeChanged(address,address)', [w(owner), w(CONVERTER)], '0x', 'receiver', {}],
    ];
    for (const [address, signature, indexed, data, source, args] of cases) {
      const name = signature.slice(0, signature.indexOf('('));
      expect(decodeV2Log(raw(address, [topic(signature), ...indexed], data), route), signature).toMatchObject({ source, name, boxId: 4n, args });
    }
  });
});


it('F143: v2 routes round posts from the DrandSource, never the backed source', () => {
  const manifest = withF143(synthManifestV2());
  const route = routeV2(release, manifest, [], [{ ...box.record, randomness: F143_DRAND.address }]);
  const posted = raw(F143_DRAND.address, [topic('RoundPosted(uint256,bytes32,address,uint256)'), w(42n), w(role(0))], encodeAbiParameters(parseAbiParameters('bytes32,uint256'), [w(99n), 5n]));
  expect(decodeV2Log(posted, route)).toMatchObject({ source: 'randomness', name: 'RoundPosted', args: { round: 42n, bounty: 5n } });
  expect(decodeV2Log({ ...posted, address: manifest.chain.randomness.address }, route)).toBeNull();
});

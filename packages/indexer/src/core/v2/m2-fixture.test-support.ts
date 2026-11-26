/** Local factory/reader double for M2-34 integration; no production admission claim. */
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbiParameters, type AbiEvent, type Address, type Hex } from 'viem';
import { labelAddress } from '../../../../chain/src/core/test-support';
import { synthBoxV2, synthManifestV2, plainCode, tArgs, ZERO, V2 } from '../../../../chain/src/core/v2/test-support/synth-v2';
import { encodeBoxSpecV2, standardRuntime, rolesOfV2, type ReleaseV2 } from './chain-v2';
import type { BoxRowV2 } from '../core-row';
import type { RawLog } from '../../events';

export const H = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
export const A = labelAddress('m2:alice');
export const B = labelAddress('m2:bob');
export const COLLECTION = labelAddress('m2:collection');
export const SHOP_PARAMS = parseAbiParameters('(uint256 seedT,uint256[4] givePricesT,uint16 pickBps,uint16 weeklyBps,uint16 collectionBps,uint32 listDelay,address curator,address[] collections,uint8[] tiers)');
export const packed = (...xs: Hex[]): Hex => `0x${xs.map(x => x.slice(2)).join('')}`;
export function fields(length: number, values: readonly (readonly [number, Hex])[]): Hex {
  const bytes = Array.from({ length }, () => '00');
  for (const [offset, value] of values) bytes.splice(offset, (value.length - 2) / 2, ...value.slice(2).match(/../g) ?? []);
  return `0x${bytes.join('')}`;
}

export function m2Fixture(shop = true) {
  const base = synthBoxV2({ boxId: 52n, tokenOnly: true });
  const implementations = Object.fromEntries(['holderLedger', 'tokenLedger', 'shopVault', 'starterSetLoader'].map(key => {
    const address = labelAddress(`m2:impl:${key}`); return [key, { address, codeHash: keccak256(plainCode(address)) }];
  }));
  const oldManifest = synthManifestV2();
  const release = { ...oldManifest.releases[0], implementations: { ...oldManifest.releases[0]?.implementations, ...implementations } } as ReleaseV2;
  const manifest = { ...oldManifest, releases: [release] };
  const contracts = [...base.record.contracts];
  contracts[17] = labelAddress('m2:ledger');
  contracts[3] = shop ? labelAddress('m2:shop') : ZERO;
  contracts[19] = shop ? labelAddress('m2:loader') : ZERO;
  const at = (i: number): Address => contracts[i] as Address;
  const contents = encodeAbiParameters(SHOP_PARAMS, [{ seedT: 1000n, givePricesT: [1n, 2n, 3n, 4n], pickBps: 12500, weeklyBps: 1000, collectionBps: 250, listDelay: 604800, curator: A, collections: [COLLECTION], tiers: [0] }]);
  const spec = { ...base.spec, boxType: shop ? 4 : 3, contentsParams: shop ? contents : '0x' as Hex,
    buyers: { ...base.spec.buyers, a: { leg: 1, dest: 6, legParams: '0x' as Hex, destParams: H(1) } },
    addOns: shop ? [{ id: 7, params: '0x' as Hex }, { id: 8, params: encodeAbiParameters(parseAbiParameters('bytes32,uint32'), [H(10), 10]) }] : [],
  };
  const code = new Map(base.code);
  const put = (index: number, name: string, args: Hex) => code.set(at(index).toLowerCase(), standardRuntime((release.implementations as unknown as Record<string, {address: Address}>)[name]?.address as Address, args));
  put(0, 'coordinator', fields(shop ? 235 : 234, shop ? [[234, '0x04']] : []));
  const tokenArgs = tArgs(at(0), at(3), 10n ** 27n, spec.tokenName, spec.tokenSymbol);
  put(1, 'tokenLedger', `0x${tokenArgs.slice(2, 82)}${at(17).slice(2)}${tokenArgs.slice(122)}`);
  put(2, 'hook', fields(231, [[0, base.record.q], [20, at(1)], [139, at(0)], [159, at(5)], [211, at(17)]]));
  put(5, 'receiver', fields(263, [[0, at(0)], [20, at(2)], [40, base.record.q], [60, at(1)], [223, at(17)]]));
  put(17, 'holderLedger', packed(at(0), at(1), at(2), at(5), base.record.q));
  if (shop) { put(3, 'shopVault', packed(at(0), at(1), at(19), contents)); put(19, 'starterSetLoader', packed(at(0), at(3), H(10), '0x0000000a')); }
  const encodedSpec = encodeBoxSpecV2(spec);
  const record = { ...base.record, contracts, specHash: keccak256(encodedSpec), codeHashes: contracts.map(a => a === ZERO ? H(0) : keccak256(code.get(a.toLowerCase()) as Hex)) };
  for (const impl of Object.values(release.implementations)) if (impl) code.set(impl.address.toLowerCase(), plainCode(impl.address));
  const reader = { codeAt: async (a: Address) => code.get(a.toLowerCase()) ?? '0x' as Hex };
  const row = { ...record, ...rolesOfV2(record), protocol: 2, chainId: V2.chainId, registry: V2.registry, record, spec, encodedSpec, release, origin: { blockHash: H(100), txHash: H(1), logIndex: 0 }, marks: [], pDecimals: 18 } as BoxRowV2;
  return { manifest, release, record, spec, encodedSpec, code, reader, row, at };
}

/** Raw bytes are encoded from independent event declarations in each test. */
export function logM2(event: AbiEvent, address: Address, args: Record<string, unknown>, logIndex: number, block = 101n, hash = H(101)): RawLog & { topics: Hex[] } {
  return { address, topics: encodeEventTopics({ abi: [event], eventName: event.name, args }) as Hex[],
    data: encodeAbiParameters(event.inputs.filter(i => !i.indexed), event.inputs.filter(i => !i.indexed).map(i => args[i.name ?? ''])),
    blockNumber: block, blockHash: hash, transactionHash: H(200), transactionIndex: 0, logIndex, removed: false };
}

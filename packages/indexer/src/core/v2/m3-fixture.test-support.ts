/** M3-32 creation double using frozen S1/S6 clone layouts; no deployed factory claim. */
import { encodeAbiParameters, keccak256, parseAbiParameters, toHex, type Address, type Hex } from 'viem';
import { labelAddress } from '../../../../chain/src/core/test-support';
import { synthBoxV2, synthManifestV2, plainCode, tArgs, ZERO } from '../../../../chain/src/core/v2/test-support/synth-v2';
import { encodeBoxSpecV2, standardRuntime, rolesOfV2, type ReleaseV2 } from './chain-v2';
import type { BoxRowV2 } from '../core-row';
import { H, fields, packed } from './m2-fixture.test-support';
export { H, A, B, logM2 as logM3 } from './m2-fixture.test-support';
export function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('missing M3 test fixture value');
  return value;
}
export const SEED = 2n ** 120n + 7n;
export function m3Fixture(pile = false, seed = SEED) {
  const base = synthBoxV2({ boxId: 352n, tokenOnly: pile });
  const original = synthManifestV2();
  const pins = Object.fromEntries(['itemLedger', 'pileVault'].map(key => {
    const address = labelAddress(`m3:impl:${key}`); return [key, { address, codeHash: keccak256(plainCode(address)) }];
  }));
  const release = { ...original.releases[0], implementations: { ...original.releases[0]?.implementations, ...pins } } as ReleaseV2;
  const manifest = { ...original, releases: [release] };
  const contracts = [...base.record.contracts];
  contracts[3] = labelAddress('m3:vault');
  contracts[7] = ZERO;
  contracts[8] = ZERO;
  contracts[16] = pile ? ZERO : labelAddress('m3:items');
  contracts[19] = pile && seed > 0n ? required(contracts[3]) : ZERO;
  const at = (i: number) => contracts[i] as Address;
  const spec = { ...base.spec, boxType: pile ? 5 : 1, n: pile ? 0 : 4,
    contentsParams: pile ? encodeAbiParameters(parseAbiParameters('address,uint256'), [ZERO, seed]) : '0x' as Hex,
    buyers: pile ? base.spec.buyers : { ...base.spec.buyers, a: { leg: 1, dest: 8, legParams: '0x' as Hex, destParams: H(1) } },
    sellers: pile ? base.spec.sellers : { ...base.spec.sellers, a: { leg: 1, dest: 8, legParams: '0x' as Hex, destParams: H(2) } },
  };
  const code = new Map(base.code);
  const put = (index: number, name: string, args: Hex) => code.set(at(index).toLowerCase(), standardRuntime(required((release.implementations as unknown as Record<string, { address: Address }>)[name]).address, args));
  put(1, 'token', tArgs(at(0), at(3), 10n ** 27n, spec.tokenName, spec.tokenSymbol));
  put(5, 'receiver', fields(263, [[0, at(0)], [20, at(2)], [40, base.record.q], [60, at(1)], [243, at(16)], [172, toHex(1n, { size: 16 })], [188, toHex(2n, { size: 16 })]]));
  if (pile) put(3, 'pileVault', packed(at(0), at(1), ZERO, base.record.creator, toHex(seed, { size: 32 })));
  else {
    put(3, 'vault', fields(56, [[0, at(0)]]));
    put(16, 'itemLedger', packed(at(0), at(3), at(4), at(7), at(5), at(2), base.record.q, '0x0102', H(1), H(2)));
  }
  const encodedSpec = encodeBoxSpecV2(spec);
  const record = { ...base.record, contracts, specHash: keccak256(encodedSpec), codeHashes: contracts.map(a => a === ZERO ? H(0) : keccak256(required(code.get(a.toLowerCase())))) };
  for (const p of Object.values(release.implementations)) if (p) code.set(p.address.toLowerCase(), plainCode(p.address));
  const reader = { codeAt: async (a: Address) => code.get(a.toLowerCase()) ?? '0x' as Hex };
  const row = { ...record, ...rolesOfV2(record), protocol: 2, chainId: manifest.chainId, registry: release.registry.address, record, spec, encodedSpec, release, origin: { blockHash: H(100), txHash: H(1), logIndex: 0 }, marks: [], pDecimals: 18 } as BoxRowV2;
  return { manifest, release, record, spec, encodedSpec, code, reader, row, at };
}

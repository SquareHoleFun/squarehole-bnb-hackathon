/** Synthetic saved files. No real creator salts or assets. Independent Node hash oracle. */
import { createHash } from 'node:crypto';
import { encodeAbiParameters, keccak256, toHex, type Hex, type PublicClient } from 'viem';
import { buildBoxTree } from '../../../../../artwork/src/box-commitment';
import { canonicalJson } from '../../../../../artwork/src/manifest';
import { encodeBoxSpecV2, type BoxSpecV2 } from '../../../../../box-spec/src/generated/box-spec.v2';
import { synthBoxV2 } from './synth-v2';

export const revealFixtureCollection = '0x0000000000000000000000000000000000000300';
export const fixtureHash = (text: string): Hex => `0x${createHash('sha256').update(text).digest('hex')}`;
export function revealFixtureClient(file: ReturnTypeShape, revealed = new Set<bigint>()): PublicClient {
  const contracts = Array.from({ length: 24 }, (_, i) => toHex(BigInt(i + 1), { size: 20 }));
  contracts[4] = revealFixtureCollection;
  return {
    getChainId: async () => 11155111,
    getBlock: async () => ({ number: 123n, hash: fixtureHash('block') }),
    getCode: async () => '0x6000',
    readContract: async ({ functionName, args }: { functionName: string; args?: bigint[] }) => {
      const values: Record<string, unknown> = {
        recordOf: { boxId: 7n, specHash: file.specHash, q: toHex(0n, { size: 20 }), contracts, codeHashes: contracts.map(() => keccak256('0x6000')) },
        revealRoot: file.spec.revealRoot, collectionSize: BigInt(file.revealList.n), firstId: 1n, revealTriggers: 4,
        revealState: [false, false, revealed.has(args?.[0] ?? 0n), !revealed.has(args?.[0] ?? 0n)],
      };
      if (!(functionName in values)) throw new Error('unexpected read');
      return values[functionName];
    },
  } as unknown as PublicClient;
}
export function openRevealFixture(n = 500) {
  const items = Array.from({ length: n }, (_, i) => ({
    id: String(i + 1), traitsPacked: ((1n << 80n) + BigInt(i)).toString(),
    imageSha256: fixtureHash(`rent-free:image:${i}`), avatarSha256: fixtureHash(`rent-free:avatar:${i}`),
    modelSha256: fixtureHash(`rent-free:model:${i}`), salt: fixtureHash(`created-box:salt:${i}`),
  }));
  const revealList = { format: 'squarehole.box-reveal-list/1', n: String(n), items };
  const spec = { ...synthBoxV2({ boxId: 7n }).spec, n };
  return recommitFixture({ format: 'squarehole.boxspec/2', demo: false, encoded: '0x' as Hex,
    specHash: '0x' as Hex, spec: specData(spec), revealList });
}
const specData = (spec: BoxSpecV2) => JSON.parse(JSON.stringify(spec, (_key, v: unknown) => typeof v === 'bigint' ? v.toString() : v)) as Record<string, unknown>;

export function recommitFixture(file: ReturnTypeShape, root = true) {
  const base = synthBoxV2({ boxId: 7n }).spec;
  const spec = { ...base, ...file.spec, firstId: BigInt(String(file.spec.firstId)),
    raise: BigInt(String(file.spec.raise)), creatorBuy: BigInt(String(file.spec.creatorBuy)) } as BoxSpecV2;
  const revealRoot = root ? buildBoxTree(file.revealList.items.map(item => keccak256(encodeAbiParameters([
    { type: 'uint256' }, { type: 'uint128' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' },
  ], [BigInt(item.id), BigInt(item.traitsPacked), item.imageSha256, item.avatarSha256, item.modelSha256, item.salt]))), spec.n).root : spec.revealRoot;
  const committed = { ...spec, revealRoot, revealListId: fixtureHash(canonicalJson(file.revealList)) };
  file.encoded = encodeBoxSpecV2(committed);
  file.specHash = keccak256(file.encoded);
  file.spec = specData(committed);
  return file;
}

interface ReturnTypeShape {
  format: string; demo: boolean; encoded: Hex; specHash: Hex; spec: Record<string, unknown>;
  revealList: { format: string; n: string; items: { id: string; traitsPacked: string; imageSha256: Hex; avatarSha256: Hex; modelSha256: Hex; salt: Hex }[] };
}

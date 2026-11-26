/** Browser-safe creation preparation. No signing, sending, chain reads or implicit approvals. */
import { concat, decodeAbiParameters, encodeAbiParameters, encodeFunctionData, erc20Abi, isAddress, keccak256,
  stringToHex, toHex, zeroAddress, zeroHash, type Address, type Hex } from 'viem';
import { NotSendableError } from '../../write/calls';
import { coordinatorV2Abi, factoryV2Abi, pileVaultV2Abi, shopVaultV2Abi, starterSetLoaderV2Abi } from './abi-v2';
import { shopConfigV2, starterCommitmentV2 } from './m2-spec-v2';
import { pileConfigV2 } from './m3-spec-v2';
import type { BoxSpecV2 } from './spec-v2';
import type { WriteCallV2 } from './write-calls-v2';

/** BoxSpecV2.CHUNK_MAX / BoxCoordinatorV2.CHUNK_MAX at core-v21-rc8; differential-pinned by Forge. */
export const CREATE_CHUNK_MAX_V2 = 8192;
export interface CreateChunkV2 { readonly data: Hex; readonly nextHash: Hex }

/** ChunkLoader.rootOf: full 8192-byte chunks, a short last chunk, keccak256(chunk || next), zero terminator. */
export function chunkChainV2(data: Hex): { readonly root: Hex; readonly chunks: readonly CreateChunkV2[] } {
  if (!/^0x(?:[\da-f]{2})*$/i.test(data)) throw new Error('invalid chunk bytes');
  const chunks: CreateChunkV2[] = [];
  let nextHash: Hex = zeroHash;
  const count = Math.ceil((data.length - 2) / (2 * CREATE_CHUNK_MAX_V2));
  for (let i = count - 1; i >= 0; i--) {
    const piece: Hex = `0x${data.slice(2 + i * CREATE_CHUNK_MAX_V2 * 2, 2 + (i + 1) * CREATE_CHUNK_MAX_V2 * 2)}`;
    chunks.push({ data: piece, nextHash });
    nextHash = keccak256(concat([piece, nextHash]));
  }
  return { root: nextHash, chunks: chunks.reverse() };
}

/** BoxFactoryV2Parts._texts/_placeholders and BoxCollectionV2Args.texts, including UTF-8 byte lengths. */
export function tokenUriTextsV2(spec: BoxSpecV2): Hex {
  if (spec.boxType !== 1) return '0x';
  const placeholder = spec.addOns.find(a => a.id === 1);
  const ph = placeholder ? decodeAbiParameters([{ type: 'string' }, { type: 'string' }, { type: 'string' },
    { type: 'string' }, { type: 'string' }], placeholder.params) : ['', '', '', '', ''];
  const page = spec.addOns.find(a => a.id === 6);
  const link = page ? decodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32[]' }, { type: 'string' }], page.params)[2] : '';
  const texts = [spec.description, ph[3] ?? '', ph[4] ?? '', link, ph[2] ?? ''].map(t => stringToHex(t));
  const lengths = texts.map(t => (t.length - 2) / 2);
  if (lengths.every(n => n === 0)) return '0x';
  const head = lengths.map((n, i) => {
    const size = i === 3 ? 1 : 2;
    if (n > (i === 3 ? 255 : 65535)) throw new RangeError('creation text exceeds its packed byte length');
    return toHex(n, { size });
  });
  return concat([...head, ...texts]);
}

export const CREATE_GAS_CEILING_V2 = 49_500_000n;
export interface CreateGasRequestV2 extends WriteCallV2 { readonly account: Address }

/** Estimate the exact transaction with a public client's estimateGas. Never silently reduce its required margin.
 * The caller supplies the current block limit and may lower the hard ceiling for a chain/transaction gas cap.
 * Fixed margin: ceil(20%) or 150k; ceiling: min(49.5M, caller cap, 99% of block limit).
 */
export async function estimateCreateGasV2(
  estimateGas: (request: CreateGasRequestV2) => Promise<bigint>,
  request: CreateGasRequestV2,
  blockGasLimit: bigint,
  hardCeiling = CREATE_GAS_CEILING_V2,
): Promise<{ readonly estimate: bigint; readonly gasLimit: bigint }> {
  if (blockGasLimit <= 0n || hardCeiling <= 0n || hardCeiling > CREATE_GAS_CEILING_V2) throw new RangeError('invalid creation gas ceiling');
  const estimate = await estimateGas(request);
  if (estimate <= 0n) throw new RangeError('invalid creation gas estimate');
  const percentage = (estimate + 4n) / 5n;
  const gasLimit = estimate + (percentage > 150_000n ? percentage : 150_000n);
  if (gasLimit > hardCeiling || gasLimit > blockGasLimit * 99n / 100n) throw new RangeError('creation gas exceeds ceiling');
  return { estimate, gasLimit };
}

export interface CreatePaymentPlanV2 {
  readonly factory: Address;
  readonly spec: BoxSpecV2;
  readonly cs: Hex;
  readonly hs: Hex;
  /** Read boxQParameters at the same pinned block as listing and predictBox. */
  readonly bootstrapQ: bigint;
}
export interface StarterItemV2 { readonly collection: Address; readonly id: bigint; readonly tier: number }
export interface CreatePlanV2 extends CreatePaymentPlanV2 {
  readonly chainId: number;
  readonly creator: Address;
  readonly coordinator: Address;
  /** Role 3, verified from the created coordinator before seed or shop calls. */
  readonly vault?: Address;
  /** Role 19, verified from the created coordinator before starter calls. */
  readonly starterLoader?: Address;
  readonly starterItems?: readonly StarterItemV2[];
}
export interface CreateCallV2 extends WriteCallV2 {
  /** loadStarter encodes StarterSetLoaderV2.load, never the loader-only ShopVaultV2.loadStarter. */
  readonly kind: 'approve' | 'createBox' | 'loadChunk' | 'loadSeed' | 'loadStarter' | 'fundSeed' | 'complete';
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const uint256 = (v: bigint) => v >= 0n && v < 1n << 256n;
const nonzeroAddress = (a: string): boolean => isAddress(a) && !same(a, zeroAddress);

/** The script and app share the exact factory payment/calldata. Zero-value approval cleanup is a separate action. */
export function createPaymentCallsV2(plan: CreatePaymentPlanV2): readonly CreateCallV2[] {
  const { factory, spec, cs, hs, bootstrapQ } = plan;
  const payment = bootstrapQ + spec.creatorBuy;
  if (!nonzeroAddress(factory) || !isAddress(spec.pricing.token) || same(factory, spec.pricing.token)
    || !uint256(bootstrapQ) || !uint256(spec.creatorBuy) || !uint256(payment)
    || ![cs, hs].every(s => /^0x[\da-f]{64}$/i.test(s))) throw new NotSendableError('invalid creation payment plan');
  const calls: CreateCallV2[] = [];
  const native = same(spec.pricing.token, zeroAddress);
  if (!native) calls.push({ kind: 'approve', to: spec.pricing.token, value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [factory, payment] }) });
  calls.push({ kind: 'createBox', to: factory, value: native ? payment : 0n,
    data: encodeFunctionData({ abi: factoryV2Abi, functionName: 'createBox', args: [spec, cs, hs] }) });
  return calls;
}

/** Derive canonical actions from a validated spec and pinned chain facts, never from caller-provided calldata.
 * Seed ERC-20 / shop-T / NFT allowances are prerequisites, outside this price-coin-to-factory approval authority.
 * Submit in order, await receipts, and re-read roles/state before post-create steps; this is not a state machine.
 */
export function buildCreateCallsV2(plan: CreatePlanV2): readonly CreateCallV2[] {
  const { spec, factory, coordinator, creator, vault, starterLoader, starterItems = [] } = plan;
  const roles = [factory, coordinator, ...(vault ? [vault] : []), ...(starterLoader ? [starterLoader] : [])];
  if (!Number.isSafeInteger(plan.chainId) || plan.chainId <= 0 || !nonzeroAddress(creator)
    || roles.some(a => !nonzeroAddress(a) || same(a, creator) || same(a, spec.pricing.token))
    || new Set(roles.map(a => a.toLowerCase())).size !== roles.length) throw new NotSendableError('invalid creation roles');
  const calls = [...createPaymentCallsV2(plan)];
  for (const [part, data] of [[1, spec.metadataTable], [2, tokenUriTextsV2(spec)]] as const) {
    for (const chunk of chunkChainV2(data).chunks) calls.push({ kind: 'loadChunk', to: coordinator, value: 0n,
      data: encodeFunctionData({ abi: coordinatorV2Abi, functionName: 'loadChunk', args: [part, chunk.data, chunk.nextHash] }) });
  }
  if (spec.boxType === 5) {
    const seed = pileConfigV2(spec.contentsParams);
    if (seed.seedAmount > 0n) {
      if (!vault) throw new NotSendableError('pile vault required');
      calls.push({ kind: 'loadSeed', to: vault, value: same(seed.asset, zeroAddress) ? seed.seedAmount : 0n,
        data: encodeFunctionData({ abi: pileVaultV2Abi, functionName: 'loadSeed' }) });
    }
  }
  if (spec.boxType === 4) {
    if (!vault || !starterLoader) throw new NotSendableError('shop vault and starter loader required');
    const shop = shopConfigV2(spec.contentsParams);
    const commitment = starterCommitmentV2(spec);
    if (!commitment || starterItems.length !== commitment.count) throw new NotSendableError('starter count mismatch');
    const suffixes: Hex[] = [];
    const seen = new Set<string>();
    let next: Hex = zeroHash;
    for (const item of [...starterItems].reverse()) {
      const key = `${item.collection.toLowerCase()}:${item.id}`;
      if (!nonzeroAddress(item.collection) || !uint256(item.id) || seen.has(key)
        || !shop.collections.some((c, i) => same(c, item.collection) && shop.tiers[i] === item.tier)) {
        throw new NotSendableError('invalid starter item');
      }
      seen.add(key);
      suffixes.push(next);
      next = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'bytes32' }],
        [item.collection, item.id, item.tier, next]));
    }
    if (!same(next, commitment.setHash)) throw new NotSendableError('starter commitment mismatch');
    suffixes.reverse();
    for (let start = 0; start < starterItems.length; start += 32) {
      const page = starterItems.slice(start, start + 32);
      const nextHash = suffixes[start + page.length - 1];
      if (nextHash === undefined) throw new NotSendableError('missing starter suffix');
      calls.push({ kind: 'loadStarter', to: starterLoader, value: 0n,
        data: encodeFunctionData({ abi: starterSetLoaderV2Abi, functionName: 'load',
          args: [page.map(i => i.collection), page.map(i => i.id), page.map(i => i.tier), nextHash] }) });
    }
    if (shop.seedT > 0n) calls.push({ kind: 'fundSeed', to: vault, value: 0n,
      data: encodeFunctionData({ abi: shopVaultV2Abi, functionName: 'fundSeed' }) });
    calls.push({ kind: 'complete', to: starterLoader, value: 0n,
      data: encodeFunctionData({ abi: starterSetLoaderV2Abi, functionName: 'complete' }) });
  } else if (starterItems.length || starterLoader) throw new NotSendableError('starter calls require a shop');
  return calls;
}

/** Recheck immediately before signing. Exact bytes reject other selectors, extra/trailing arguments and amounts. */
export function assertSendableCreateCallV2(call: WriteCallV2, plan: CreatePlanV2, from: Address, chainId: number): void {
  if (!isAddress(from) || !same(from, plan.creator) || chainId !== plan.chainId
    || !isAddress(call.to) || !uint256(call.value)) throw new NotSendableError('creation caller, chain or value mismatch');
  const expected = buildCreateCallsV2(plan);
  if (!expected.some(c => same(c.to, call.to) && c.value === call.value && same(c.data, call.data))) {
    throw new NotSendableError('call is not an exact canonical creation action in the plan');
  }
}

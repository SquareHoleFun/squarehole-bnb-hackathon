/**
 * A launched pair as the registry records it (`SquareHoleRegistry.PairRecord`, emitted in full by `PairCreated`).
 * Every identity the readers use comes from here: token, mirror, ledger, collector, hook, pool id, quote, converter.
 * The record is checked before use: its chain id must be the configured chain and its pair id must be
 * keccak256(abi.encode(chainId, token)), exactly as the registry enforces on write.
 */
import { formatPairId, type PairId } from '@squarehole/domain';
import { encodeAbiParameters, getAddress, keccak256, type Address, type Hex } from 'viem';
import { ChainDataError } from '../errors';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface RegistryPair {
  readonly chainId: number;
  /** On-chain pair id keccak256(abi.encode(chainId, token)). */
  readonly registryPairId: Hex;
  /** App pair id "<chainId>:<lowercase token>" (ADR-0003). */
  readonly pairId: PairId;
  readonly kind: 'token' | 'nft_collection';
  readonly token: Address;
  readonly mirror: Address | null;
  readonly ledger: Address;
  readonly collector: Address;
  readonly hook: Address;
  readonly poolId: Hex;
  readonly quote: Address;
  readonly rewardSide: 'T' | 'Q';
  readonly converter: Address | null;
  readonly fractionsPerNft: bigint;
  readonly units: bigint;
  readonly initialSupply: bigint;
  readonly templateVersion: number;
  readonly startFdvQ: bigint;
  readonly minStartUnitValueQ: bigint;
  readonly tickSpacing: number;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly liquidity: bigint;
  readonly initialSqrtPriceX96: bigint;
  readonly metadataManifestHash: Hex;
  readonly creator: Address;
  readonly createdAtBlock: bigint;
  /** T sorts below Q, i.e. T is the PoolKey's currency0. */
  readonly tIsCurrency0: boolean;
}

/** The ABI-decoded `PairRecord` struct (viem output of `pair()` / `PairCreated.record`). */
export interface RawPairRecord {
  readonly chainId: bigint;
  readonly pairId: Hex;
  readonly kind: number;
  readonly token: Address;
  readonly mirror: Address;
  readonly ledger: Address;
  readonly collector: Address;
  readonly hook: Address;
  readonly poolId: Hex;
  readonly quote: Address;
  readonly rewardSide: number;
  readonly converter: Address;
  readonly fractionsPerNft: bigint;
  readonly units: bigint;
  readonly initialSupply: bigint;
  readonly templateVersion: number;
  readonly startFdvQ: bigint;
  readonly minStartUnitValueQ: bigint;
  readonly tickSpacing: number;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly liquidity: bigint;
  readonly sqrtPriceX96: bigint;
  readonly metadataManifestHash: Hex;
  readonly creator: Address;
  readonly createdAtBlock: bigint;
}

export function registryPairIdOf(chainId: number, token: Address): Hex {
  return keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }], [BigInt(chainId), token]));
}

const isZero = (value: string): boolean => value.toLowerCase() === ZERO_ADDRESS;

/** Checks and normalises a registry record. Throws `ChainDataError('inconsistent_state')` on any contradiction. */
export function toRegistryPair(record: RawPairRecord, expectedChainId: number): RegistryPair {
  const fail = (message: string): never => {
    throw new ChainDataError('inconsistent_state', `Registry record rejected: ${message}`);
  };
  if (record.chainId !== BigInt(expectedChainId)) fail(`chain ${record.chainId} is not ${expectedChainId}`);
  if (isZero(record.token)) fail('zero token');
  if (record.pairId.toLowerCase() !== registryPairIdOf(expectedChainId, record.token).toLowerCase()) fail('pair id is not keccak256(chainId, token)');
  if (record.kind !== 0 && record.kind !== 1) fail(`unknown asset kind ${record.kind}`);
  if (record.rewardSide !== 0 && record.rewardSide !== 1) fail(`unknown fee-share side ${record.rewardSide}`);
  const kind = record.kind === 1 ? 'nft_collection' : 'token';
  const rewardSide = record.rewardSide === 1 ? 'T' : 'Q';
  if ((kind === 'nft_collection') === isZero(record.mirror)) fail('a collection has a mirror and a token has none');
  if ((rewardSide === 'T') === isZero(record.converter)) fail('R = T names the converter and R = Q does not');
  if (record.fractionsPerNft <= 0n || record.units <= 0n || record.initialSupply <= 0n) fail('non-positive supply fields');
  if (record.initialSupply !== record.units * record.fractionsPerNft * 10n ** 18n) fail('initialSupply != units x r x 1e18');
  const token = getAddress(record.token);
  const quote = getAddress(record.quote);
  return Object.freeze({
    chainId: expectedChainId,
    registryPairId: record.pairId,
    pairId: formatPairId(expectedChainId, token),
    kind,
    token,
    mirror: kind === 'nft_collection' ? getAddress(record.mirror) : null,
    ledger: getAddress(record.ledger),
    collector: getAddress(record.collector),
    hook: getAddress(record.hook),
    poolId: record.poolId,
    quote,
    rewardSide,
    converter: rewardSide === 'T' ? getAddress(record.converter) : null,
    fractionsPerNft: record.fractionsPerNft,
    units: record.units,
    initialSupply: record.initialSupply,
    templateVersion: record.templateVersion,
    startFdvQ: record.startFdvQ,
    minStartUnitValueQ: record.minStartUnitValueQ,
    tickSpacing: record.tickSpacing,
    tickLower: record.tickLower,
    tickUpper: record.tickUpper,
    liquidity: record.liquidity,
    initialSqrtPriceX96: record.sqrtPriceX96,
    metadataManifestHash: record.metadataManifestHash,
    creator: getAddress(record.creator),
    createdAtBlock: record.createdAtBlock,
    tIsCurrency0: token.toLowerCase() < quote.toLowerCase(),
  });
}

/** JSON-safe form (bigints as decimal strings) for the index store. */
export type SerializedRegistryPair = { readonly [K in keyof RawPairRecord]: RawPairRecord[K] extends bigint ? string : RawPairRecord[K] };

export function serializeRawRecord(record: RawPairRecord): SerializedRegistryPair {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, typeof value === 'bigint' ? value.toString() : value])) as SerializedRegistryPair;
}

const BIGINT_FIELDS: readonly (keyof RawPairRecord)[] = [
  'chainId',
  'fractionsPerNft',
  'units',
  'initialSupply',
  'startFdvQ',
  'minStartUnitValueQ',
  'liquidity',
  'sqrtPriceX96',
  'createdAtBlock',
];

export function deserializeRawRecord(record: SerializedRegistryPair): RawPairRecord {
  const copy: Record<string, unknown> = { ...record };
  for (const field of BIGINT_FIELDS) copy[field] = BigInt(record[field] as string);
  return copy as unknown as RawPairRecord;
}

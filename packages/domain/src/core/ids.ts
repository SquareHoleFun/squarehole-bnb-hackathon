/**
 * Typed identities for the core v2 model (v2 docs/07 "Use projectId, marketId, collectionId, campaignId
 * separately"; SH-V2-T03). Each id is a branded string or number, so one kind can never be passed as another.
 *
 * Chain assets and collections use CAIP-19 (`eip155:<chainId>/slip44:60` for native ETH,
 * `eip155:<chainId>/erc20:<address>`, `eip155:<chainId>/erc721:<address>`). Demo assets use `mock:<name>` (as in
 * v2's mock intent, `"assetId": "mock:Q"`): a mock id has no chain and can never be a live asset. Addresses are
 * stored lowercase. A launch id keeps the existing pair id format (`<chainId>:<address>`, ADR-0003), so today's routes
 * and records stay valid.
 */
import { IdentityError } from '../errors';
import { canonicalAddress, isAddress, isChainId, isPairId, isZeroAddress, parsePairId } from '../ids';
import type { Address, PairId } from '../types';

declare const brand: unique symbol;
type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export type ChainId = Brand<number, 'ChainId'>;
export type AssetId = Brand<string, 'AssetId'>;
export type CollectionId = Brand<string, 'CollectionId'>;
export type NftTokenId = Brand<string, 'NftTokenId'>;
export type NftId = Brand<string, 'NftId'>;
export type LaunchId = Brand<string, 'LaunchId'>;
export type MarketId = Brand<string, 'MarketId'>;
export type PolicyId = Brand<string, 'PolicyId'>;

/** The chains the core model names. Production is Ethereum mainnet (F02, ADR-0002); Sepolia is the testnet goal. */
export const CORE_CHAIN_IDS = Object.freeze({ ethereum: 1, sepolia: 11_155_111, localDemo: 31_337 });

const MAX_UINT256 = 2n ** 256n - 1n;
const CHAIN = '([1-9][0-9]*)';
const ADDRESS = '(0x[0-9a-fA-F]{40})';
const UINT = '(0|[1-9][0-9]*)';
const NATIVE_PATTERN = new RegExp(`^eip155:${CHAIN}/slip44:60$`);
const ERC20_PATTERN = new RegExp(`^eip155:${CHAIN}/erc20:${ADDRESS}$`);
const COLLECTION_PATTERN = new RegExp(`^eip155:${CHAIN}/erc721:${ADDRESS}$`);
const NFT_PATTERN = new RegExp(`^eip155:${CHAIN}/erc721:${ADDRESS}/${UINT}$`);
const MARKET_PATTERN = new RegExp(`^eip155:${CHAIN}/uniswap-v4-pool:(0x[0-9a-fA-F]{64})$`);
const MOCK_PATTERN = /^mock:[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;
const POLICY_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const TOKEN_ID_PATTERN = new RegExp(`^${UINT}$`);
const POOL_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

const malformed = (what: string): IdentityError => new IdentityError('malformed_id', `Malformed ${what}`);

export function toChainId(value: unknown): ChainId {
  if (!isChainId(value)) throw new IdentityError('malformed_chain_id', 'Chain id must be a positive safe integer');
  return value as ChainId;
}

/** Strict decimal chain id text (no sign, no leading zeros). */
function chainFromText(text: string | undefined, what: string): ChainId {
  const value = Number(text);
  if (text === undefined || !isChainId(value) || String(value) !== text) throw malformed(what);
  return value as ChainId;
}

/** A contract address inside an id: well formed and never the zero address (ADR-0008). */
function contractAddress(text: string | undefined, what: string): Address {
  if (text === undefined || !isAddress(text) || isZeroAddress(text)) throw malformed(what);
  return canonicalAddress(text);
}

// --- Assets -------------------------------------------------------------------------------------------------------

export type ParsedAssetId =
  | { readonly kind: 'native'; readonly id: AssetId; readonly chainId: ChainId; readonly address: null }
  | { readonly kind: 'erc20'; readonly id: AssetId; readonly chainId: ChainId; readonly address: Address }
  | { readonly kind: 'mock'; readonly id: AssetId; readonly chainId: null; readonly address: null };

export function nativeAssetId(chainId: ChainId): AssetId {
  return `eip155:${toChainId(chainId)}/slip44:60` as AssetId;
}

export function erc20AssetId(chainId: ChainId, address: string): AssetId {
  return `eip155:${toChainId(chainId)}/erc20:${contractAddress(address, 'ERC-20 address')}` as AssetId;
}

/** A demo-only asset. It has no chain, so no live manifest, snapshot or quote on a real chain can hold it. */
export function mockAssetId(name: string): AssetId {
  const id = `mock:${name}`;
  if (!MOCK_PATTERN.test(id)) throw malformed('mock asset id');
  return id as AssetId;
}

export function parseAssetId(value: string): ParsedAssetId {
  const text = typeof value === 'string' ? value : '';
  const native = NATIVE_PATTERN.exec(text);
  if (native) {
    const chainId = chainFromText(native[1], 'asset id');
    return { kind: 'native', id: nativeAssetId(chainId), chainId, address: null };
  }
  const erc20 = ERC20_PATTERN.exec(text);
  if (erc20) {
    const chainId = chainFromText(erc20[1], 'asset id');
    const address = contractAddress(erc20[2], 'asset id');
    return { kind: 'erc20', id: `eip155:${chainId}/erc20:${address}` as AssetId, chainId, address };
  }
  if (MOCK_PATTERN.test(text)) return { kind: 'mock', id: text as AssetId, chainId: null, address: null };
  throw malformed('asset id');
}

function tryParse<T>(parse: () => T): T | null {
  try {
    return parse();
  } catch {
    return null;
  }
}

export function isAssetId(value: unknown): value is AssetId {
  return typeof value === 'string' && tryParse(() => parseAssetId(value)) !== null;
}

export function isMockAssetId(value: unknown): boolean {
  return typeof value === 'string' && MOCK_PATTERN.test(value);
}

/** The chain of a chain asset; null for a mock asset. */
export function chainOfAssetId(id: AssetId): ChainId | null {
  return parseAssetId(id).chainId;
}

// --- Collections and NFTs -----------------------------------------------------------------------------------------

export interface ParsedCollectionId {
  readonly id: CollectionId;
  readonly chainId: ChainId;
  readonly address: Address;
}

export function collectionId(chainId: ChainId, address: string): CollectionId {
  return `eip155:${toChainId(chainId)}/erc721:${contractAddress(address, 'collection address')}` as CollectionId;
}

export function parseCollectionId(value: string): ParsedCollectionId {
  const match = COLLECTION_PATTERN.exec(typeof value === 'string' ? value : '');
  if (!match) throw malformed('collection id');
  const chainId = chainFromText(match[1], 'collection id');
  const address = contractAddress(match[2], 'collection id');
  return { id: collectionId(chainId, address), chainId, address };
}

/** An ERC-721 token id: a uint256 as a canonical decimal string. */
export function nftTokenId(value: string | bigint): NftTokenId {
  let parsed: bigint;
  if (typeof value === 'bigint') parsed = value;
  else if (typeof value === 'string' && TOKEN_ID_PATTERN.test(value)) parsed = BigInt(value);
  else throw malformed('NFT token id');
  if (parsed < 0n || parsed > MAX_UINT256) throw malformed('NFT token id');
  return parsed.toString() as NftTokenId;
}

export interface ParsedNftId {
  readonly id: NftId;
  readonly collection: CollectionId;
  readonly chainId: ChainId;
  readonly tokenId: NftTokenId;
}

export function nftId(collection: CollectionId, tokenId: NftTokenId): NftId {
  return `${parseCollectionId(collection).id}/${nftTokenId(tokenId)}` as NftId;
}

export function parseNftId(value: string): ParsedNftId {
  const match = NFT_PATTERN.exec(typeof value === 'string' ? value : '');
  if (!match) throw malformed('NFT id');
  const chainId = chainFromText(match[1], 'NFT id');
  const collection = collectionId(chainId, contractAddress(match[2], 'NFT id'));
  const tokenId = nftTokenId(match[3] ?? '');
  return { id: nftId(collection, tokenId), collection, chainId, tokenId };
}

// --- Launches and markets -----------------------------------------------------------------------------------------

export interface ParsedLaunchId {
  readonly id: LaunchId;
  readonly chainId: ChainId;
  readonly address: Address;
}

/** The launch record identity: `<chainId>:<token address>`, the same text as today's pair id. */
export function launchId(chainId: ChainId, address: string): LaunchId {
  return `${toChainId(chainId)}:${contractAddress(address, 'launch token address')}` as LaunchId;
}

export function parseLaunchId(value: string): ParsedLaunchId {
  if (!isPairId(value)) throw malformed('launch id');
  const parsed = parsePairId(value);
  const address = contractAddress(parsed.address, 'launch id');
  return { id: launchId(parsed.chainId as ChainId, address), chainId: parsed.chainId as ChainId, address };
}

export function launchIdFromPairId(pairId: PairId | string): LaunchId {
  return parseLaunchId(pairId).id;
}

export function launchIdToPairId(id: LaunchId): PairId {
  const parsed = parseLaunchId(id);
  return `${parsed.chainId}:${parsed.address}`;
}

export interface ParsedMarketId {
  readonly id: MarketId;
  readonly chainId: ChainId;
  readonly venue: 'uniswap-v4';
  readonly poolId: `0x${string}`;
}

/** One pool on one chain. Only Uniswap v4 pools exist in this repo today. */
export function marketId(chainId: ChainId, poolId: string): MarketId {
  if (!POOL_ID_PATTERN.test(poolId)) throw malformed('pool id');
  return `eip155:${toChainId(chainId)}/uniswap-v4-pool:${poolId.toLowerCase()}` as MarketId;
}

export function parseMarketId(value: string): ParsedMarketId {
  const match = MARKET_PATTERN.exec(typeof value === 'string' ? value : '');
  if (!match) throw malformed('market id');
  const chainId = chainFromText(match[1], 'market id');
  const poolId = (match[2] ?? '').toLowerCase() as `0x${string}`;
  return { id: marketId(chainId, poolId), chainId, venue: 'uniswap-v4', poolId };
}

// --- Policies -----------------------------------------------------------------------------------------------------

export function policyId(value: string): PolicyId {
  if (typeof value !== 'string' || !POLICY_PATTERN.test(value)) throw malformed('policy id');
  return value as PolicyId;
}

export function isPolicyId(value: unknown): value is PolicyId {
  return typeof value === 'string' && POLICY_PATTERN.test(value);
}

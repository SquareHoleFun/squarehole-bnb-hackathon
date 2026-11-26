/**
 * The site's TypeScript stub of the shapes M1-00 froze for format 2 (packages/contracts/src/box-v2/interfaces:
 * SpecTypes.sol, RecipeTypes.sol, IListingRegistry.sol's listing enums, IBoxCoordinatorV2.sol's chunk parts), member by
 * member and checked against the Solidity sources (spec-types.test.ts). M1-10's generated twin
 * (packages/box-spec/src/generated/box-spec.v2.ts) replaces it in wave 2; `validate()` and the field rules are M1-10's.
 * Wire rules: every enum is a uint8 and 0 is never a member; the spec hash is keccak256(abi.encode(spec)); params are
 * the members of their tuple encoded as a list.
 */
import type { Address } from '@squarehole/domain';
import { encodeAbiParameters, keccak256, type Hex } from 'viem';

export const FORMAT_V2 = 2;
export const VERSION_V2 = 2;

export const BoxTypeV2 = Object.freeze({ NEW_COLLECTION: 1, EXISTING: 2, TOKEN_ONLY: 3, SHOP: 4, PILE: 5 });
export const Leg = Object.freeze({ AsPaid: 1, BuyT: 2, RESERVED_3: 3, RESERVED_4: 4, RESERVED_5: 5 });
export const Dest = Object.freeze({ Eat: 1, Creator: 2, RESERVED_3: 3, Depth: 4, RESERVED_5: 5, Holders: 6, BudgetOrPile: 7, Items: 8, Module: 9 });
export const Split = Object.freeze({ NoSplit: 1, RESERVED_2: 2, RESERVED_3: 3, RESERVED_4: 4 });
export const ListingClass = Object.freeze({ NATIVE: 1, STANDARD: 2, STABLE: 3, STOCK: 4, OTHER: 5 });
export const ListingKind = Object.freeze({ LISTED: 1, BOX_TOKEN: 2 });
export const ChunkPart = Object.freeze({ Table: 1, Texts: 2 });

/** RecipeTypes.sol `Branch`. */
export interface BranchV2 {
  readonly leg: number;
  readonly dest: number;
  readonly legParams: Hex;
  readonly destParams: Hex;
}

/** RecipeTypes.sol `Side`: fields 17 (buyers) and 18 (sellers). */
export interface SideV2 {
  readonly a: BranchV2;
  readonly b: BranchV2;
  readonly split: number;
  readonly splitParams: Hex;
}

export interface AddOnV2 {
  readonly id: number;
  readonly params: Hex;
}

/** SpecTypes.sol `BoxSpec`, fields 0-31 in id order (uint256 as bigint). */
export interface BoxSpecV2 {
  readonly format: number;
  readonly version: number;
  readonly boxType: number;
  readonly tokenName: string;
  readonly tokenSymbol: string;
  readonly collectionName: string;
  readonly collectionSymbol: string;
  readonly description: string;
  readonly n: number;
  readonly firstId: bigint;
  readonly pricing: { readonly listingId: number; readonly token: Address };
  readonly raise: bigint;
  readonly layout: number;
  readonly gradLayout: number;
  readonly launchFormat: number;
  readonly openAt: number;
  readonly deadlineDays: number;
  readonly buyers: SideV2;
  readonly sellers: SideV2;
  readonly artMode: number;
  readonly revealRoot: Hex;
  readonly metadataTable: Hex;
  readonly generatorHash: Hex;
  readonly coverSha256: Hex;
  readonly revealListId: Hex;
  readonly marketplaceOwner: Address;
  readonly creatorFeeRecipient: Address;
  readonly creatorBuy: bigint;
  readonly collectionCoverSha256: Hex;
  readonly addOns: readonly AddOnV2[];
  readonly contentsParams: Hex;
  readonly pickFeeBps: number;
}

/** SpecTypes.sol `Listing`: one listing as validate() sees it. */
export interface ListingV2 {
  readonly id: number;
  readonly token: Address;
  readonly decimals: number;
  readonly class: number;
  readonly kind: number;
  readonly raise: bigint;
}

const BRANCH = { type: 'tuple', components: [{ name: 'leg', type: 'uint8' }, { name: 'dest', type: 'uint8' }, { name: 'legParams', type: 'bytes' }, { name: 'destParams', type: 'bytes' }] } as const;
const SIDE = [{ name: 'a', ...BRANCH }, { name: 'b', ...BRANCH }, { name: 'split', type: 'uint8' }, { name: 'splitParams', type: 'bytes' }] as const;

/** BoxSpec's ABI tuple, field by field. */
export const BOX_SPEC_V2_ABI_COMPONENTS = [
  { name: 'format', type: 'uint16' },
  { name: 'version', type: 'uint16' },
  { name: 'boxType', type: 'uint8' },
  { name: 'tokenName', type: 'string' },
  { name: 'tokenSymbol', type: 'string' },
  { name: 'collectionName', type: 'string' },
  { name: 'collectionSymbol', type: 'string' },
  { name: 'description', type: 'string' },
  { name: 'n', type: 'uint32' },
  { name: 'firstId', type: 'uint256' },
  { name: 'pricing', type: 'tuple', components: [{ name: 'listingId', type: 'uint32' }, { name: 'token', type: 'address' }] },
  { name: 'raise', type: 'uint256' },
  { name: 'layout', type: 'uint8' },
  { name: 'gradLayout', type: 'uint8' },
  { name: 'launchFormat', type: 'uint8' },
  { name: 'openAt', type: 'uint32' },
  { name: 'deadlineDays', type: 'uint16' },
  { name: 'buyers', type: 'tuple', components: SIDE },
  { name: 'sellers', type: 'tuple', components: SIDE },
  { name: 'artMode', type: 'uint8' },
  { name: 'revealRoot', type: 'bytes32' },
  { name: 'metadataTable', type: 'bytes' },
  { name: 'generatorHash', type: 'bytes32' },
  { name: 'coverSha256', type: 'bytes32' },
  { name: 'revealListId', type: 'bytes32' },
  { name: 'marketplaceOwner', type: 'address' },
  { name: 'creatorFeeRecipient', type: 'address' },
  { name: 'creatorBuy', type: 'uint256' },
  { name: 'collectionCoverSha256', type: 'bytes32' },
  { name: 'addOns', type: 'tuple[]', components: [{ name: 'id', type: 'uint16' }, { name: 'params', type: 'bytes' }] },
  { name: 'contentsParams', type: 'bytes' },
  { name: 'pickFeeBps', type: 'uint16' },
] as const;

export const BOX_SPEC_V2_FIELDS: readonly string[] = Object.freeze(BOX_SPEC_V2_ABI_COMPONENTS.map((field) => field.name));

/** abi.encode(spec): what `createBox` takes as calldata. */
export const encodeBoxSpecV2 = (spec: BoxSpecV2): Hex => encodeAbiParameters([{ type: 'tuple', components: BOX_SPEC_V2_ABI_COMPONENTS }], [spec]);
export const specHashV2 = (spec: BoxSpecV2): Hex => keccak256(encodeBoxSpecV2(spec));

export const emptyBranch = (): BranchV2 => ({ leg: 0, dest: 0, legParams: '0x', destParams: '0x' });

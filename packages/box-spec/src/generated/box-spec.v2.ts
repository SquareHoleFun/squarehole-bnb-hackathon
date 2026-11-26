// GENERATED FILE, do not edit: packages/box-spec/scripts/generate-v2.mjs writes it from packages/box-spec/box-spec.v2.json
// and packages/box-spec/add-ons.v2.json; `node packages/box-spec/scripts/generate-v2.mjs --check` fails when stale.
// The Solidity twin is packages/contracts/src/box-v2/BoxSpecV2.sol; both come from scripts/lib/checks-v2.mjs over the
// types ticket M1-00 froze (SpecTypes.sol, RecipeTypes.sol). Every enum is a uint8 on the wire; 0 is never a member.
import { decodeAbiParameters, encodeAbiParameters, hexToBytes, keccak256, stringToHex, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { canonicalParams, checkString, checkStringAt, hexLength, isZeroHex, nonZeroItems, ParamKind, readWordAt, sameAddress, tableV1, word, type Verdict } from '../runtime';

// ------------------------------------------------------------------------------------------------ fixed values
/** False for the real M1-10 source; kept as the release boundary marker. A deploy must assert it is false. */
export const SOURCE_IS_STUB: boolean = false;
/** box-spec-v2-draft.md § 2, field 0 */
export const SPEC_FORMAT_VERSION = 2;
/** box-spec-v2-draft.md § 1-2, field 1: core v2 is the box protocol's version 2 */
export const CORE_VERSION = 2;
/** format 1's (plan § 1); V IBoxTokenV2.sol BoxTokenV2Args.MAX_NAME_BYTES (T's clone argument is a bytes32) */
export const MAX_TOKEN_NAME_BYTES = 32n;
/** format 1's; V IBoxTokenV2.sol BoxTokenV2Args.MAX_SYMBOL_BYTES (a bytes11) */
export const MAX_SYMBOL_BYTES = 11n;
/** format 1's (plan § 1); ADR-0017 § 6 caps table: unchanged */
export const MAX_TEXT_BYTES = 1024n;
/** format 1's (BC-008) */
export const MIN_N = 10;
/** format 1's (BC-008) */
export const MAX_N = 10000;
/** format 1's (V MisfitsGenesis.sol:172); box-spec-v2-draft.md § 2 fields 8, 9: as format 1 */
export const FIRST_ID = 1n;
/** format 1's (F80): 2026-09-01 00:00:00 UTC; a non-zero openAt below it is a unit mistake */
export const MIN_OPEN_AT = 1788220800;
/** ADR-0017 § 6 caps table: 24,575 as v1 (BoxSpecV1.MAX_METADATA_TABLE_BYTES), loaded after creation in chunks against its hash (F96 R20C); M1-60 measures the heaviest spec and sets it */
export const TABLE_MAX = 24575n;
/** this file's first value (M1-10-a): no document gives one; each chunk is kept as data code (0x00 + bytes, IBoxCoordinatorV2), so it is at most 24,575; 8,192 loads a TABLE_MAX table in 3 transactions (ADR-0017 § 8 defaults: 'a few transactions'). M1-60 sets it so each loading transaction fits the block budget; the coordinator's CHUNK_MAX() returns it */
export const CHUNK_MAX = 8192n;
/** format 1's (V BoxMetadataTable.sol:22) */
export const MAX_TRAIT_TYPES = 16n;
/** format 1's; ADR-0017 § 6 caps table: 8 */
export const MAX_ADD_ONS = 8n;
/** V ReleaseConstantsV2.NATIVE_LISTING_ID: listing 0 is native ETH, token address(0) */
export const NATIVE_LISTING_ID = 0;
/** V BoxSpecV1.PICK_FEE_BPS (F23 C3): field 31's default (ADR-0017 § 5) */
export const PICK_FEE_BPS_DEFAULT = 2500;

// ------------------------------------------------------------------------------------------------ enums (uint8)
export const BoxType = { NEW_COLLECTION: 1, EXISTING: 2, TOKEN_ONLY: 3, SHOP: 4, PILE: 5 } as const;
export const GradLayout = { RESERVED_1: 1, RESERVED_2: 2, FULL_RANGE: 3 } as const;
export const FeeChoice = { Keep: 1, Burn: 2, Grow: 3, Holders: 4, Items: 5, EatPriceCoin: 6, HoldersT: 7, ItemsT: 8, Pile: 9, Module: 10, ShopT: 11 } as const;
export const Leg = { AsPaid: 1, BuyT: 2, RESERVED_3: 3, RESERVED_4: 4, RESERVED_5: 5 } as const;
export const Dest = { Eat: 1, Creator: 2, RESERVED_3: 3, Depth: 4, RESERVED_5: 5, Holders: 6, BudgetOrPile: 7, Items: 8, Module: 9 } as const;
export const Split = { NoSplit: 1, RESERVED_2: 2, RESERVED_3: 3, RESERVED_4: 4 } as const;
export const FeeSide = { Buyers: 1, Sellers: 2 } as const;
export const HoldersCurrency = { P: 1, T: 2 } as const;
export const ItemsInsidePolicy = { Keep: 1, BuyBackBurn: 2, Depth: 3 } as const;
export const Layout = { CURVE_V1: 1 } as const;
export const LaunchFormat = { CURVE: 1 } as const;
export const ArtMode = { OPEN: 1, HIDDEN: 2 } as const;
export const RoyaltyDestination = { FEE_HANDLING: 1, CREATOR: 2, POOL_DEPTH: 3 } as const;
export const StringRule = { JSON_TEXT: 1, SVG: 2, URL: 3 } as const;
export const RULE_RANGES = {
  JSON_TEXT: [[32, 33], [35, 91], [93, 126]],
  SVG: [[32, 126]],
  URL: [[33, 33], [35, 59], [61, 61], [63, 91], [93, 93], [95, 95], [97, 122], [126, 126]],
} as const satisfies Readonly<Record<string, readonly (readonly [number, number])[]>>;
export const RULE_PREFIXES = {
  JSON_TEXT: [],
  SVG: [],
  URL: [104, 116, 116, 112, 115, 58, 47, 47],
} as const satisfies Readonly<Record<string, readonly number[]>>;
export const Reason = {
  OK: 0,
  UNSUPPORTED_VERSION: 1,
  NOT_A_MEMBER: 2,
  NOT_OFFERED: 3,
  OUT_OF_RANGE: 4,
  LENGTH_OUT_OF_RANGE: 5,
  BAD_CHARACTER: 6,
  ZERO_VALUE: 7,
  MUST_BE_ZERO: 8,
  Q_NOT_LISTED: 9,
  RAISE_NOT_A_PRESET: 10,
  MENU_RULE: 11,
  DEADLINE_RULE: 12,
  TOO_MANY_ADD_ONS: 13,
  ADD_ON_ORDER: 14,
  ADD_ON_UNKNOWN: 15,
  ADD_ON_NOT_AVAILABLE: 16,
  ADD_ON_PARAMS_MALFORMED: 17,
  ADD_ON_REQUIRED: 18,
  ADD_ON_CONFLICT: 19,
  METADATA_TABLE_MALFORMED: 20,
  LISTING_UNKNOWN: 21,
  LISTING_MISMATCH: 22,
  RECIPE_RULE: 23,
  SPLIT_RULE: 24,
  PLUG_IN_MALFORMED: 25,
  GAS_BUDGET: 26,
} as const;
export const REASON_NAMES: Readonly<Record<number, string>> = Object.fromEntries(Object.entries(Reason).map(([k, v]) => [v, k]));
export const Field = {
  format: 0,
  version: 1,
  boxType: 2,
  tokenName: 3,
  tokenSymbol: 4,
  collectionName: 5,
  collectionSymbol: 6,
  description: 7,
  n: 8,
  firstId: 9,
  pricing: 10,
  raise: 11,
  layout: 12,
  gradLayout: 13,
  launchFormat: 14,
  openAt: 15,
  deadlineDays: 16,
  buyers: 17,
  sellers: 18,
  artMode: 19,
  revealRoot: 20,
  metadataTable: 21,
  generatorHash: 22,
  coverSha256: 23,
  revealListId: 24,
  marketplaceOwner: 25,
  creatorFeeRecipient: 26,
  creatorBuy: 27,
  collectionCoverSha256: 28,
  addOns: 29,
  contentsParams: 30,
  pickFeeBps: 31,
  'buyers.a.leg': 17001,
  'buyers.a.dest': 17002,
  'buyers.a.legParams': 17003,
  'buyers.a.destParams': 17004,
  'buyers.b.leg': 17011,
  'buyers.b.dest': 17012,
  'buyers.b.legParams': 17013,
  'buyers.b.destParams': 17014,
  'buyers.split': 17021,
  'buyers.splitParams': 17022,
  'sellers.a.leg': 18001,
  'sellers.a.dest': 18002,
  'sellers.a.legParams': 18003,
  'sellers.a.destParams': 18004,
  'sellers.b.leg': 18011,
  'sellers.b.dest': 18012,
  'sellers.b.legParams': 18013,
  'sellers.b.destParams': 18014,
  'sellers.split': 18021,
  'sellers.splitParams': 18022,
  'addOns.placeholders': 100,
  'addOns.placeholders.placeholderName': 101,
  'addOns.placeholders.placeholderSymbol': 102,
  'addOns.placeholders.placeholderDescription': 103,
  'addOns.placeholders.hiddenDescription': 104,
  'addOns.placeholders.hiddenSvg': 105,
  'addOns.edition-specials': 300,
  'addOns.edition-specials.label': 301,
  'addOns.edition-specials.count': 302,
  'addOns.royalties': 400,
  'addOns.royalties.bps': 401,
  'addOns.royalties.destination': 402,
  'addOns.collection-metadata': 600,
  'addOns.collection-metadata.bannerSha256': 601,
  'addOns.collection-metadata.teaserSha256s': 602,
  'addOns.collection-metadata.externalLink': 603,
  'addOns.collection-list': 700,
  'addOns.starter-set': 800,
  'addOns.starter-set.setHash': 801,
  'addOns.starter-set.count': 802,
  'addOns.held-item-earnings': 900,
  'addOns.humble-creator': 1000,
  'addOns.humble-creator.preset': 1001,
} as const;
export const FIELD_NAMES: Readonly<Record<number, string>> = Object.fromEntries(Object.entries(Field).map(([k, v]) => [v, k]));
export const AddOnId = { Placeholders: 1, EditionSpecials: 3, Royalties: 4, CollectionMetadata: 6, CollectionList: 7, StarterSet: 8, HeldItemEarnings: 9, HumbleCreator: 10 } as const;

// ------------------------------------------------------------------------------------------------ types (frozen shapes)
/** Solidity `BoxSpec` (SpecTypes.sol). */
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
  readonly pricing: PricingV2;
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
/** Solidity `BoxSpec` (SpecTypes.sol), every string as its raw bytes. */
export interface BoxSpecV2Bytes {
  readonly format: number;
  readonly version: number;
  readonly boxType: number;
  readonly tokenName: Hex;
  readonly tokenSymbol: Hex;
  readonly collectionName: Hex;
  readonly collectionSymbol: Hex;
  readonly description: Hex;
  readonly n: number;
  readonly firstId: bigint;
  readonly pricing: PricingV2;
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
/** Solidity `Pricing` (SpecTypes.sol). */
export interface PricingV2 {
  readonly listingId: number;
  readonly token: Address;
}
/** Solidity `Side` (RecipeTypes.sol). */
export interface SideV2 {
  readonly a: BranchV2;
  readonly b: BranchV2;
  readonly split: number;
  readonly splitParams: Hex;
}
/** Solidity `Branch` (RecipeTypes.sol). */
export interface BranchV2 {
  readonly leg: number;
  readonly dest: number;
  readonly legParams: Hex;
  readonly destParams: Hex;
}
/** Solidity `AddOn` (SpecTypes.sol). */
export interface AddOnV2 {
  readonly id: number;
  readonly params: Hex;
}
/** Solidity `ReleaseContext` (SpecTypes.sol). */
export interface ReleaseContextV2 {
  readonly listing: ListingV2;
}
/** Solidity `Listing` (SpecTypes.sol). */
export interface ListingV2 {
  readonly id: number;
  readonly token: Address;
  readonly decimals: number;
  readonly class: number;
  readonly kind: number;
  readonly raise: bigint;
}
/** Solidity `HoldersDestParams` (RecipeTypes.sol). */
export interface HoldersDestParamsV2 {
  readonly currency: number;
}
/** Solidity `ShopDestParams` (RecipeTypes.sol). */
export interface ShopDestParamsV2 {
  readonly ceilingPreset: number;
}
/** Solidity `ItemsDestParams` (RecipeTypes.sol). */
export interface ItemsDestParamsV2 {
  readonly insidePolicy: number;
}
/** Solidity `ModuleDestParams` (RecipeTypes.sol). */
export interface ModuleDestParamsV2 {
  readonly id: number;
}
/** Solidity `PileParams` (SpecTypes.sol). */
export interface PileParamsV2 {
  readonly asset: Address;
  readonly seedAmount: bigint;
}
/** Solidity `PileParamsV21` (SpecTypes.sol). */
export interface PileParamsV21V2 {
  readonly asset: Address;
  readonly seedAmount: bigint;
  readonly leaveBehindBps: number;
}

// ------------------------------------------------------------------------------------------------ ABI
export const BOX_SPEC_V2_ABI = {
  type: 'tuple',
  components: [
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
    { name: 'buyers', type: 'tuple', components: [{ name: 'a', type: 'tuple', components: [{ name: 'leg', type: 'uint8' }, { name: 'dest', type: 'uint8' }, { name: 'legParams', type: 'bytes' }, { name: 'destParams', type: 'bytes' }] }, { name: 'b', type: 'tuple', components: [{ name: 'leg', type: 'uint8' }, { name: 'dest', type: 'uint8' }, { name: 'legParams', type: 'bytes' }, { name: 'destParams', type: 'bytes' }] }, { name: 'split', type: 'uint8' }, { name: 'splitParams', type: 'bytes' }] },
    { name: 'sellers', type: 'tuple', components: [{ name: 'a', type: 'tuple', components: [{ name: 'leg', type: 'uint8' }, { name: 'dest', type: 'uint8' }, { name: 'legParams', type: 'bytes' }, { name: 'destParams', type: 'bytes' }] }, { name: 'b', type: 'tuple', components: [{ name: 'leg', type: 'uint8' }, { name: 'dest', type: 'uint8' }, { name: 'legParams', type: 'bytes' }, { name: 'destParams', type: 'bytes' }] }, { name: 'split', type: 'uint8' }, { name: 'splitParams', type: 'bytes' }] },
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
  ],
} as const;
export const BOX_SPEC_V2_BYTES_ABI = {
  type: 'tuple',
  components: [
    { name: 'format', type: 'uint16' },
    { name: 'version', type: 'uint16' },
    { name: 'boxType', type: 'uint8' },
    { name: 'tokenName', type: 'bytes' },
    { name: 'tokenSymbol', type: 'bytes' },
    { name: 'collectionName', type: 'bytes' },
    { name: 'collectionSymbol', type: 'bytes' },
    { name: 'description', type: 'bytes' },
    { name: 'n', type: 'uint32' },
    { name: 'firstId', type: 'uint256' },
    { name: 'pricing', type: 'tuple', components: [{ name: 'listingId', type: 'uint32' }, { name: 'token', type: 'address' }] },
    { name: 'raise', type: 'uint256' },
    { name: 'layout', type: 'uint8' },
    { name: 'gradLayout', type: 'uint8' },
    { name: 'launchFormat', type: 'uint8' },
    { name: 'openAt', type: 'uint32' },
    { name: 'deadlineDays', type: 'uint16' },
    { name: 'buyers', type: 'tuple', components: [{ name: 'a', type: 'tuple', components: [{ name: 'leg', type: 'uint8' }, { name: 'dest', type: 'uint8' }, { name: 'legParams', type: 'bytes' }, { name: 'destParams', type: 'bytes' }] }, { name: 'b', type: 'tuple', components: [{ name: 'leg', type: 'uint8' }, { name: 'dest', type: 'uint8' }, { name: 'legParams', type: 'bytes' }, { name: 'destParams', type: 'bytes' }] }, { name: 'split', type: 'uint8' }, { name: 'splitParams', type: 'bytes' }] },
    { name: 'sellers', type: 'tuple', components: [{ name: 'a', type: 'tuple', components: [{ name: 'leg', type: 'uint8' }, { name: 'dest', type: 'uint8' }, { name: 'legParams', type: 'bytes' }, { name: 'destParams', type: 'bytes' }] }, { name: 'b', type: 'tuple', components: [{ name: 'leg', type: 'uint8' }, { name: 'dest', type: 'uint8' }, { name: 'legParams', type: 'bytes' }, { name: 'destParams', type: 'bytes' }] }, { name: 'split', type: 'uint8' }, { name: 'splitParams', type: 'bytes' }] },
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
  ],
} as const;
export const RELEASE_CONTEXT_V2_ABI = { type: 'tuple', components: [{ name: 'listing', type: 'tuple', components: [{ name: 'id', type: 'uint32' }, { name: 'token', type: 'address' }, { name: 'decimals', type: 'uint8' }, { name: 'class', type: 'uint8' }, { name: 'kind', type: 'uint8' }, { name: 'raise', type: 'uint256' }] }] } as const;
/** Each params tuple, as its members list: canonical params are `encodeAbiParameters` of these (abi.encode of the members). */
export const PARAMS_V2_ABI = {
  HoldersDestParams: [{ name: 'currency', type: 'uint8' }],
  ShopDestParams: [{ name: 'ceilingPreset', type: 'uint8' }],
  ItemsDestParams: [{ name: 'insidePolicy', type: 'uint8' }],
  ModuleDestParams: [{ name: 'id', type: 'uint32' }],
  PileParams: [{ name: 'asset', type: 'address' }, { name: 'seedAmount', type: 'uint256' }],
  PileParamsV21: [{ name: 'asset', type: 'address' }, { name: 'seedAmount', type: 'uint256' }, { name: 'leaveBehindBps', type: 'uint16' }],
} as const;
export const ADD_ON_PARAMS_V2_ABI = {
  1: [{ name: 'placeholderName', type: 'string' }, { name: 'placeholderSymbol', type: 'string' }, { name: 'placeholderDescription', type: 'string' }, { name: 'hiddenDescription', type: 'string' }, { name: 'hiddenSvg', type: 'string' }],
  3: [{ name: 'label', type: 'string' }, { name: 'count', type: 'uint32' }],
  4: [{ name: 'bps', type: 'uint16' }, { name: 'destination', type: 'uint8' }],
  6: [{ name: 'bannerSha256', type: 'bytes32' }, { name: 'teaserSha256s', type: 'bytes32[]' }, { name: 'externalLink', type: 'string' }],
  7: [],
  8: [{ name: 'setHash', type: 'bytes32' }, { name: 'count', type: 'uint32' }],
  9: [],
  10: [{ name: 'preset', type: 'uint8' }],
} as const;

export function encodeBoxSpecV2(spec: BoxSpecV2): Hex {
  return encodeAbiParameters([BOX_SPEC_V2_ABI], [spec]);
}
export function decodeBoxSpecV2(encoded: Hex): BoxSpecV2 {
  return decodeAbiParameters([BOX_SPEC_V2_ABI], encoded)[0];
}
export function encodeBoxSpecV2Bytes(spec: BoxSpecV2Bytes): Hex {
  return encodeAbiParameters([BOX_SPEC_V2_BYTES_ABI], [spec]);
}
/** Decodes ABI bytes with every string kept as its raw bytes (no UTF-8 decoding), as Solidity sees them. */
export function decodeBoxSpecV2Bytes(encoded: Hex): BoxSpecV2Bytes {
  return decodeAbiParameters([BOX_SPEC_V2_BYTES_ABI], encoded)[0];
}
/** The bytes form of a spec built here: each string as its UTF-8 bytes, as viem encodes it. */
export function toBoxSpecV2Bytes(spec: BoxSpecV2): BoxSpecV2Bytes {
  return { ...spec, tokenName: stringToHex(spec.tokenName), tokenSymbol: stringToHex(spec.tokenSymbol), collectionName: stringToHex(spec.collectionName), collectionSymbol: stringToHex(spec.collectionSymbol), description: stringToHex(spec.description) };
}
/** keccak256(abi.encode(spec)): Solidity`s `BoxSpecV2.specHash`. */
export function specHashV2(spec: BoxSpecV2): Hex {
  return keccak256(encodeBoxSpecV2(spec));
}
/** Solidity`s `specHash(abi.decode(encoded))`: the canonical re-encoding of the decoded bytes, strings never decoded. */
export function specHashOfEncodedV2(encoded: Hex): Hex {
  return keccak256(encodeBoxSpecV2Bytes(decodeBoxSpecV2Bytes(encoded)));
}
export function encodeReleaseContextV2(ctx: ReleaseContextV2): Hex {
  return encodeAbiParameters([RELEASE_CONTEXT_V2_ABI], [ctx]);
}
export function decodeReleaseContextV2(encoded: Hex): ReleaseContextV2 {
  return decodeAbiParameters([RELEASE_CONTEXT_V2_ABI], encoded)[0];
}
export function encodeHoldersDestParams(p: HoldersDestParamsV2): Hex {
  return encodeAbiParameters(PARAMS_V2_ABI.HoldersDestParams, [p.currency]);
}
export function decodeHoldersDestParams(p: Hex): HoldersDestParamsV2 {
  const [currency] = decodeAbiParameters(PARAMS_V2_ABI.HoldersDestParams, p);
  return { currency };
}
export function encodeShopDestParams(p: ShopDestParamsV2): Hex {
  return encodeAbiParameters(PARAMS_V2_ABI.ShopDestParams, [p.ceilingPreset]);
}
export function decodeShopDestParams(p: Hex): ShopDestParamsV2 {
  const [ceilingPreset] = decodeAbiParameters(PARAMS_V2_ABI.ShopDestParams, p);
  return { ceilingPreset };
}
export function encodeItemsDestParams(p: ItemsDestParamsV2): Hex {
  return encodeAbiParameters(PARAMS_V2_ABI.ItemsDestParams, [p.insidePolicy]);
}
export function decodeItemsDestParams(p: Hex): ItemsDestParamsV2 {
  const [insidePolicy] = decodeAbiParameters(PARAMS_V2_ABI.ItemsDestParams, p);
  return { insidePolicy };
}
export function encodeModuleDestParams(p: ModuleDestParamsV2): Hex {
  return encodeAbiParameters(PARAMS_V2_ABI.ModuleDestParams, [p.id]);
}
export function decodeModuleDestParams(p: Hex): ModuleDestParamsV2 {
  const [id] = decodeAbiParameters(PARAMS_V2_ABI.ModuleDestParams, p);
  return { id };
}
export function encodePileParams(p: PileParamsV2): Hex {
  return encodeAbiParameters(PARAMS_V2_ABI.PileParams, [p.asset, p.seedAmount]);
}
export function decodePileParams(p: Hex): PileParamsV2 {
  const [asset, seedAmount] = decodeAbiParameters(PARAMS_V2_ABI.PileParams, p);
  return { asset, seedAmount };
}
export function encodePileParamsV21(p: PileParamsV21V2): Hex {
  return encodeAbiParameters(PARAMS_V2_ABI.PileParamsV21, [p.asset, p.seedAmount, p.leaveBehindBps]);
}
export function decodePileParamsV21(p: Hex): PileParamsV21V2 {
  const [asset, seedAmount, leaveBehindBps] = decodeAbiParameters(PARAMS_V2_ABI.PileParamsV21, p);
  return { asset, seedAmount, leaveBehindBps };
}

// ------------------------------------------------------------------------------------------------ validate
const OK: Verdict = { reason: Reason.OK, field: 0 };
const verdict = (reason: number, field: number): Verdict => ({ reason, field });
const KINDS_HOLDERS_DEST_PARAMS = [ParamKind.UINT8];
const KINDS_SHOP_DEST_PARAMS = [ParamKind.UINT8];
const KINDS_ITEMS_DEST_PARAMS = [ParamKind.UINT8];
const KINDS_MODULE_DEST_PARAMS = [ParamKind.UINT32];

/** (Reason.OK, 0) for a valid spec built here, else the first failing check`s reason and field id, as Solidity returns them. */
export function validateBoxSpecV2(s: BoxSpecV2, ctx: ReleaseContextV2): Verdict {
  return validateBoxSpecV2Bytes(toBoxSpecV2Bytes(s), ctx);
}
/** The validator itself, on raw string bytes: Solidity`s `BoxSpecV2.validate` check for check. */
export function validateBoxSpecV2Bytes(s: BoxSpecV2Bytes, ctx: ReleaseContextV2): Verdict {
  const fields = checkFields(s, ctx);
  if (fields.reason !== Reason.OK) return fields;
  const rules = checkRules(s, ctx);
  if (rules.reason !== Reason.OK) return rules;
  return checkShop(s);
}
/**
 * Solidity`s verdict on well-formed ABI bytes (as `abi.encode` writes them). viem decodes some malformed words that
 * `abi.decode` reverts on (a uint8 word over 255, an address word with high bits set), so a verdict here does not prove
 * the bytes decode on chain; it throws where viem cannot decode them.
 */
export function validateEncodedBoxSpecV2(encoded: Hex, ctx: ReleaseContextV2): Verdict {
  return validateBoxSpecV2Bytes(decodeBoxSpecV2Bytes(encoded), ctx);
}

function checkFields(s: BoxSpecV2Bytes, ctx: ReleaseContextV2): Verdict {
  let r: number;
  let v: Verdict;
  // 0 format
  if (!(s.format === 2)) return verdict(Reason.UNSUPPORTED_VERSION, Field.format);
  // 1 version
  if (!(s.version === 2)) return verdict(Reason.UNSUPPORTED_VERSION, Field.version);
  // 2 boxType
  if (!(s.boxType >= BoxType.NEW_COLLECTION && s.boxType <= BoxType.PILE)) return verdict(Reason.NOT_A_MEMBER, Field.boxType);
  if (!(s.boxType === BoxType.NEW_COLLECTION || s.boxType === BoxType.TOKEN_ONLY || s.boxType === BoxType.SHOP || s.boxType === BoxType.PILE)) return verdict(Reason.NOT_OFFERED, Field.boxType);
  // 3 tokenName
  r = checkString(hexToBytes(s.tokenName), 1, Number(MAX_TOKEN_NAME_BYTES), RULE_RANGES.JSON_TEXT, RULE_PREFIXES.JSON_TEXT);
  if (r !== Reason.OK) return verdict(r, Field.tokenName);
  // 4 tokenSymbol
  r = checkString(hexToBytes(s.tokenSymbol), 1, Number(MAX_SYMBOL_BYTES), RULE_RANGES.JSON_TEXT, RULE_PREFIXES.JSON_TEXT);
  if (r !== Reason.OK) return verdict(r, Field.tokenSymbol);
  // 5 collectionName
  if ((s.boxType === BoxType.TOKEN_ONLY || s.boxType === BoxType.SHOP || s.boxType === BoxType.PILE)) {
    if (!(hexLength(s.collectionName) === 0)) return verdict(Reason.MUST_BE_ZERO, Field.collectionName);
  } else {
    r = checkString(hexToBytes(s.collectionName), 1, Number(MAX_TOKEN_NAME_BYTES), RULE_RANGES.JSON_TEXT, RULE_PREFIXES.JSON_TEXT);
    if (r !== Reason.OK) return verdict(r, Field.collectionName);
  }
  // 6 collectionSymbol
  if ((s.boxType === BoxType.TOKEN_ONLY || s.boxType === BoxType.SHOP || s.boxType === BoxType.PILE)) {
    if (!(hexLength(s.collectionSymbol) === 0)) return verdict(Reason.MUST_BE_ZERO, Field.collectionSymbol);
  } else {
    r = checkString(hexToBytes(s.collectionSymbol), 1, Number(MAX_SYMBOL_BYTES), RULE_RANGES.JSON_TEXT, RULE_PREFIXES.JSON_TEXT);
    if (r !== Reason.OK) return verdict(r, Field.collectionSymbol);
  }
  // 7 description
  r = checkString(hexToBytes(s.description), 0, Number(MAX_TEXT_BYTES), RULE_RANGES.JSON_TEXT, RULE_PREFIXES.JSON_TEXT);
  if (r !== Reason.OK) return verdict(r, Field.description);
  // 8 n
  if ((s.boxType === BoxType.TOKEN_ONLY || s.boxType === BoxType.SHOP || s.boxType === BoxType.PILE)) {
    if (!(s.n === 0)) return verdict(Reason.MUST_BE_ZERO, Field.n);
  } else {
    if ((s.n < MIN_N || s.n > MAX_N)) return verdict(Reason.OUT_OF_RANGE, Field.n);
  }
  // 9 firstId
  if ((s.boxType === BoxType.TOKEN_ONLY || s.boxType === BoxType.SHOP || s.boxType === BoxType.PILE)) {
    if (!(s.firstId === 0n)) return verdict(Reason.MUST_BE_ZERO, Field.firstId);
  } else {
    if ((s.firstId < FIRST_ID || s.firstId > FIRST_ID)) return verdict(Reason.OUT_OF_RANGE, Field.firstId);
  }
  // 10 pricing
  if (!listingKnown(ctx, s.pricing.listingId)) return verdict(Reason.LISTING_UNKNOWN, Field.pricing);
  if (!listingTokenIs(ctx, s.pricing.listingId, s.pricing.token)) return verdict(Reason.LISTING_MISMATCH, Field.pricing);
  // 11 raise
  if (!raiseMatches(ctx, s.pricing.listingId, s.raise)) return verdict(Reason.RAISE_NOT_A_PRESET, Field.raise);
  // 12 layout
  if (!(s.layout === Layout.CURVE_V1)) return verdict(Reason.NOT_A_MEMBER, Field.layout);
  // 13 gradLayout
  if (!(s.gradLayout >= GradLayout.RESERVED_1 && s.gradLayout <= GradLayout.FULL_RANGE)) return verdict(Reason.NOT_A_MEMBER, Field.gradLayout);
  if (!(s.gradLayout === GradLayout.FULL_RANGE)) return verdict(Reason.NOT_OFFERED, Field.gradLayout);
  // 14 launchFormat
  if (!(s.launchFormat === LaunchFormat.CURVE)) return verdict(Reason.NOT_A_MEMBER, Field.launchFormat);
  // 15 openAt
  if ((!(s.openAt === 0) && s.openAt < MIN_OPEN_AT)) return verdict(Reason.OUT_OF_RANGE, Field.openAt);
  // 16 deadlineDays
  if (!(s.deadlineDays === 30 || s.deadlineDays === 60 || s.deadlineDays === 90 || s.deadlineDays === 180)) return verdict(Reason.DEADLINE_RULE, Field.deadlineDays);
  // 17 buyers
  v = checkSide(s.buyers, ctx, 17000);
  if (v.reason !== Reason.OK) return v;
  // 18 sellers
  v = checkSide(s.sellers, ctx, 18000);
  if (v.reason !== Reason.OK) return v;
  // 19 artMode
  if ((s.boxType === BoxType.TOKEN_ONLY || s.boxType === BoxType.SHOP || s.boxType === BoxType.PILE)) {
    if (!(s.artMode === 0)) return verdict(Reason.MUST_BE_ZERO, Field.artMode);
  } else {
    if (!(s.artMode === ArtMode.OPEN || s.artMode === ArtMode.HIDDEN)) return verdict(Reason.NOT_A_MEMBER, Field.artMode);
  }
  // 20 revealRoot
  if ((s.boxType === BoxType.TOKEN_ONLY || s.boxType === BoxType.SHOP || s.boxType === BoxType.PILE)) {
    if (!isZeroHex(s.revealRoot)) return verdict(Reason.MUST_BE_ZERO, Field.revealRoot);
  } else {
    if (isZeroHex(s.revealRoot)) return verdict(Reason.ZERO_VALUE, Field.revealRoot);
  }
  // 21 metadataTable
  if ((s.boxType === BoxType.TOKEN_ONLY || s.boxType === BoxType.SHOP || s.boxType === BoxType.PILE)) {
    if (!(hexLength(s.metadataTable) === 0)) return verdict(Reason.MUST_BE_ZERO, Field.metadataTable);
  } else {
    if (hexLength(s.metadataTable) < 1 || hexLength(s.metadataTable) > Number(TABLE_MAX)) return verdict(Reason.LENGTH_OUT_OF_RANGE, Field.metadataTable);
    if (!tableV1(hexToBytes(s.metadataTable), Number(MAX_TRAIT_TYPES), RULE_RANGES.JSON_TEXT)) return verdict(Reason.METADATA_TABLE_MALFORMED, Field.metadataTable);
  }
  // 22 generatorHash
  if ((s.boxType === BoxType.TOKEN_ONLY || s.boxType === BoxType.SHOP || s.boxType === BoxType.PILE)) {
    if (!isZeroHex(s.generatorHash)) return verdict(Reason.MUST_BE_ZERO, Field.generatorHash);
  }
  // 23 coverSha256
  if (isZeroHex(s.coverSha256)) return verdict(Reason.ZERO_VALUE, Field.coverSha256);
  // 24 revealListId
  if ((s.boxType === BoxType.TOKEN_ONLY || s.boxType === BoxType.SHOP || s.boxType === BoxType.PILE)) {
    if (!isZeroHex(s.revealListId)) return verdict(Reason.MUST_BE_ZERO, Field.revealListId);
  }
  // 25 marketplaceOwner
  if ((s.boxType === BoxType.TOKEN_ONLY || s.boxType === BoxType.SHOP || s.boxType === BoxType.PILE)) {
    if (!isZeroHex(s.marketplaceOwner)) return verdict(Reason.MUST_BE_ZERO, Field.marketplaceOwner);
  } else {
    if (isZeroHex(s.marketplaceOwner)) return verdict(Reason.ZERO_VALUE, Field.marketplaceOwner);
  }
  // 28 collectionCoverSha256
  if ((s.boxType === BoxType.TOKEN_ONLY || s.boxType === BoxType.SHOP || s.boxType === BoxType.PILE)) {
    if (!isZeroHex(s.collectionCoverSha256)) return verdict(Reason.MUST_BE_ZERO, Field.collectionCoverSha256);
  } else {
    if (isZeroHex(s.collectionCoverSha256)) return verdict(Reason.ZERO_VALUE, Field.collectionCoverSha256);
  }
  // 29 addOns
  v = checkAddOns(s, ctx);
  if (v.reason !== Reason.OK) return v;
  // 30 contentsParams
  if (s.boxType === BoxType.SHOP) {
    if (hexLength(s.contentsParams) < 480 || hexLength(s.contentsParams) > 4576) return verdict(Reason.LENGTH_OUT_OF_RANGE, Field.contentsParams);
  } else if (s.boxType === BoxType.PILE) {
    if (!(canonicalParams(hexToBytes(s.contentsParams), [ParamKind.ADDRESS, ParamKind.UINT256]) !== null || (canonicalParams(hexToBytes(s.contentsParams), [ParamKind.ADDRESS, ParamKind.UINT256, ParamKind.UINT16]) !== null && (pw(s.contentsParams, 2) === 0n || pw(s.contentsParams, 2) === 500n)))) return verdict(Reason.RECIPE_RULE, Field.contentsParams);
    if (((s.buyers.a.dest === Dest.BudgetOrPile || s.sellers.a.dest === Dest.BudgetOrPile) && !sameAddress(wordAddress(pw(s.contentsParams, 0)), s.pricing.token))) return verdict(Reason.RECIPE_RULE, Field.contentsParams);
  } else {
    if (!(hexLength(s.contentsParams) === 0)) return verdict(Reason.MUST_BE_ZERO, Field.contentsParams);
  }
  // 31 pickFeeBps
  if ((s.boxType === BoxType.TOKEN_ONLY || s.boxType === BoxType.SHOP || s.boxType === BoxType.PILE)) {
    if (!(s.pickFeeBps === 0)) return verdict(Reason.MUST_BE_ZERO, Field.pickFeeBps);
  } else {
    if (!(s.pickFeeBps === 100 || s.pickFeeBps === 500 || s.pickFeeBps === 2500)) return verdict(Reason.NOT_A_MEMBER, Field.pickFeeBps);
  }
  return OK;
}

function checkSide(d: SideV2, ctx: ReleaseContextV2, base: number): Verdict {
  let v: Verdict;
  v = checkBranch(d.a, ctx, base);
  if (v.reason !== Reason.OK) return v;
  if (!(d.split >= Split.NoSplit && d.split <= Split.RESERVED_4)) return verdict(Reason.NOT_A_MEMBER, base + 21);
  if (!(hexLength(d.splitParams) === 0)) {
    return verdict(Reason.MUST_BE_ZERO, base + 22);
  }
  if (d.split === Split.NoSplit) {
    if (!(d.b.leg === 0)) return verdict(Reason.MUST_BE_ZERO, base + 11);
    if (!(d.b.dest === 0)) return verdict(Reason.MUST_BE_ZERO, base + 12);
    if (!(hexLength(d.b.legParams) === 0)) return verdict(Reason.MUST_BE_ZERO, base + 13);
    if (!(hexLength(d.b.destParams) === 0)) return verdict(Reason.MUST_BE_ZERO, base + 14);
  } else {
    v = checkBranch(d.b, ctx, base + 10);
    if (v.reason !== Reason.OK) return v;
  }
  return OK;
}

function checkBranch(br: BranchV2, _ctx: ReleaseContextV2, base: number): Verdict {
  if (!(br.leg >= Leg.AsPaid && br.leg <= Leg.RESERVED_5)) return verdict(Reason.NOT_A_MEMBER, base + 1);
  if (!(br.leg === Leg.AsPaid || br.leg === Leg.BuyT)) return verdict(Reason.NOT_OFFERED, base + 1);
  if (!(br.dest >= Dest.Eat && br.dest <= Dest.Module)) return verdict(Reason.NOT_A_MEMBER, base + 2);
  if (!(br.dest === Dest.Eat || br.dest === Dest.Creator || br.dest === Dest.Depth || br.dest === Dest.Holders || br.dest === Dest.BudgetOrPile || br.dest === Dest.Items || br.dest === Dest.Module)) return verdict(Reason.NOT_OFFERED, base + 2);
  if (!(hexLength(br.legParams) === 0)) {
    return verdict(Reason.MUST_BE_ZERO, base + 3);
  }
  if (br.dest === Dest.Holders) {
    if (!(canonicalParams(hexToBytes(br.destParams), KINDS_HOLDERS_DEST_PARAMS) !== null)) return verdict(Reason.RECIPE_RULE, base + 4);
    if (!((br.leg === Leg.AsPaid && pw(br.destParams, 0) === BigInt(HoldersCurrency.P)) || (br.leg === Leg.BuyT && pw(br.destParams, 0) === BigInt(HoldersCurrency.T)))) return verdict(Reason.NOT_OFFERED, base + 4);
  } else if (br.dest === Dest.BudgetOrPile && br.leg === Leg.BuyT) {
    if (!(canonicalParams(hexToBytes(br.destParams), KINDS_SHOP_DEST_PARAMS) !== null)) return verdict(Reason.RECIPE_RULE, base + 4);
    if (!(pw(br.destParams, 0) === 2n || pw(br.destParams, 0) === 4n || pw(br.destParams, 0) === 8n)) return verdict(Reason.NOT_OFFERED, base + 4);
  } else if (br.dest === Dest.Items) {
    if (!(canonicalParams(hexToBytes(br.destParams), KINDS_ITEMS_DEST_PARAMS) !== null)) return verdict(Reason.RECIPE_RULE, base + 4);
    if (!(pw(br.destParams, 0) === BigInt(ItemsInsidePolicy.Keep) || pw(br.destParams, 0) === BigInt(ItemsInsidePolicy.BuyBackBurn) || pw(br.destParams, 0) === BigInt(ItemsInsidePolicy.Depth))) return verdict(Reason.NOT_OFFERED, base + 4);
  } else if (br.dest === Dest.Module) {
    if (!(canonicalParams(hexToBytes(br.destParams), KINDS_MODULE_DEST_PARAMS) !== null)) return verdict(Reason.MUST_BE_ZERO, base + 4);
  } else if (!(hexLength(br.destParams) === 0)) {
    return verdict(Reason.MUST_BE_ZERO, base + 4);
  }
  return OK;
}

function checkAddOns(s: BoxSpecV2Bytes, ctx: ReleaseContextV2): Verdict {
  if (BigInt(s.addOns.length) > MAX_ADD_ONS) return verdict(Reason.TOO_MANY_ADD_ONS, Field.addOns);
  let previous: number | undefined;
  for (const addOn of s.addOns) {
    const id = addOn.id;
    if (previous !== undefined && (id < previous || (id === previous && !repeatable(id)))) return verdict(Reason.ADD_ON_ORDER, Field.addOns);
    const result = checkAddOn(s, ctx, id, hexToBytes(addOn.params));
    if (result.reason !== Reason.OK) return result;
    previous = id;
  }
  return OK;
}

function repeatable(id: number): boolean {
  return id === AddOnId.EditionSpecials;
}

function checkAddOn(s: BoxSpecV2Bytes, ctx: ReleaseContextV2, id: number, p: Uint8Array): Verdict {
  if (id === AddOnId.Placeholders) return checkPlaceholders(s, ctx, p);
  if (id === AddOnId.EditionSpecials) return checkEditionSpecials(s, ctx, p);
  if (id === AddOnId.Royalties) return checkRoyalties(s, ctx, p);
  if (id === AddOnId.CollectionMetadata) return checkCollectionMetadata(s, ctx, p);
  if (id === AddOnId.CollectionList) return checkCollectionList(s, ctx, p);
  if (id === AddOnId.StarterSet) return checkStarterSet(s, ctx, p);
  if (id === AddOnId.HeldItemEarnings) return checkHeldItemEarnings();
  if (id === AddOnId.HumbleCreator) return checkHumbleCreator();
  return verdict(Reason.ADD_ON_UNKNOWN, Field.addOns);
}

/** Add-on 1 `placeholders`: Placeholders: tickets during the curve, hidden art revealed by draws. */
function checkPlaceholders(s: BoxSpecV2Bytes, _ctx: ReleaseContextV2, p: Uint8Array): Verdict {
  if (!(s.boxType === BoxType.NEW_COLLECTION)) return verdict(Reason.ADD_ON_CONFLICT, Field['addOns.placeholders']);
  const w = canonicalParams(p, [ParamKind.STRING, ParamKind.STRING, ParamKind.STRING, ParamKind.STRING, ParamKind.STRING]);
  if (w === null) return verdict(Reason.ADD_ON_PARAMS_MALFORMED, Field['addOns.placeholders']);
  const r0 = checkStringAt(p, word(w, 0), 1, 32, RULE_RANGES.JSON_TEXT, RULE_PREFIXES.JSON_TEXT);
  if (r0 !== Reason.OK) return verdict(r0, Field['addOns.placeholders.placeholderName']);
  const r1 = checkStringAt(p, word(w, 1), 1, 11, RULE_RANGES.JSON_TEXT, RULE_PREFIXES.JSON_TEXT);
  if (r1 !== Reason.OK) return verdict(r1, Field['addOns.placeholders.placeholderSymbol']);
  const r2 = checkStringAt(p, word(w, 2), 0, 1024, RULE_RANGES.JSON_TEXT, RULE_PREFIXES.JSON_TEXT);
  if (r2 !== Reason.OK) return verdict(r2, Field['addOns.placeholders.placeholderDescription']);
  const r3 = checkStringAt(p, word(w, 3), 0, 1024, RULE_RANGES.JSON_TEXT, RULE_PREFIXES.JSON_TEXT);
  if (r3 !== Reason.OK) return verdict(r3, Field['addOns.placeholders.hiddenDescription']);
  const r4 = checkStringAt(p, word(w, 4), 1, 4096, RULE_RANGES.SVG, RULE_PREFIXES.SVG);
  if (r4 !== Reason.OK) return verdict(r4, Field['addOns.placeholders.hiddenSvg']);
  if (!(s.artMode === ArtMode.HIDDEN)) return verdict(Reason.ADD_ON_CONFLICT, Field['addOns.placeholders']);
  return OK;
}

/** Add-on 3 `edition-specials`: Edition specials: named series of special items, shown as counts. */
function checkEditionSpecials(s: BoxSpecV2Bytes, _ctx: ReleaseContextV2, p: Uint8Array): Verdict {
  if (!(s.boxType === BoxType.NEW_COLLECTION)) return verdict(Reason.ADD_ON_CONFLICT, Field['addOns.edition-specials']);
  const w = canonicalParams(p, [ParamKind.STRING, ParamKind.UINT32]);
  if (w === null) return verdict(Reason.ADD_ON_PARAMS_MALFORMED, Field['addOns.edition-specials']);
  const r0 = checkStringAt(p, word(w, 0), 1, 32, RULE_RANGES.JSON_TEXT, RULE_PREFIXES.JSON_TEXT);
  if (r0 !== Reason.OK) return verdict(r0, Field['addOns.edition-specials.label']);
  if ((word(w, 1) < 1n || word(w, 1) > BigInt(s.n))) return verdict(Reason.OUT_OF_RANGE, Field['addOns.edition-specials.count']);
  return OK;
}

/** Add-on 4 `royalties`: Royalties: voluntary ERC-2981 income for the box. */
function checkRoyalties(s: BoxSpecV2Bytes, _ctx: ReleaseContextV2, p: Uint8Array): Verdict {
  if (!(s.boxType === BoxType.NEW_COLLECTION)) return verdict(Reason.ADD_ON_CONFLICT, Field['addOns.royalties']);
  const w = canonicalParams(p, [ParamKind.UINT16, ParamKind.UINT8]);
  if (w === null) return verdict(Reason.ADD_ON_PARAMS_MALFORMED, Field['addOns.royalties']);
  if (!(word(w, 0) === 0n || word(w, 0) === 100n || word(w, 0) === 250n || word(w, 0) === 500n)) return verdict(Reason.NOT_A_MEMBER, Field['addOns.royalties.bps']);
  if (!(word(w, 1) === 1n)) return verdict(Reason.NOT_A_MEMBER, Field['addOns.royalties.destination']);
  return OK;
}

/** Add-on 6 `collection-metadata`: Collection page: banner, teasers and link (contractURI, ERC-7572). */
function checkCollectionMetadata(s: BoxSpecV2Bytes, _ctx: ReleaseContextV2, p: Uint8Array): Verdict {
  if (!(s.boxType === BoxType.NEW_COLLECTION)) return verdict(Reason.ADD_ON_CONFLICT, Field['addOns.collection-metadata']);
  const w = canonicalParams(p, [ParamKind.BYTES32, ParamKind.BYTES32_ARRAY, ParamKind.STRING]);
  if (w === null) return verdict(Reason.ADD_ON_PARAMS_MALFORMED, Field['addOns.collection-metadata']);
  if (readWordAt(p, word(w, 1)) > 4n) return verdict(Reason.LENGTH_OUT_OF_RANGE, Field['addOns.collection-metadata.teaserSha256s']);
  if (!nonZeroItems(p, word(w, 1))) return verdict(Reason.ZERO_VALUE, Field['addOns.collection-metadata.teaserSha256s']);
  const r2 = checkStringAt(p, word(w, 2), 0, 128, RULE_RANGES.URL, RULE_PREFIXES.URL);
  if (r2 !== Reason.OK) return verdict(r2, Field['addOns.collection-metadata.externalLink']);
  return OK;
}

/** Add-on 7 `collection-list`: Collection list: fixed tiers and an optional add-only curator. */
function checkCollectionList(s: BoxSpecV2Bytes, _ctx: ReleaseContextV2, p: Uint8Array): Verdict {
  if (!(s.boxType === BoxType.SHOP)) return verdict(Reason.ADD_ON_CONFLICT, Field['addOns.collection-list']);
  if (p.length !== 0) return verdict(Reason.ADD_ON_PARAMS_MALFORMED, Field['addOns.collection-list']);
  return OK;
}

/** Add-on 8 `starter-set`: Starter set: committed NFTs and seed readiness before opening. */
function checkStarterSet(s: BoxSpecV2Bytes, _ctx: ReleaseContextV2, p: Uint8Array): Verdict {
  if (!(s.boxType === BoxType.SHOP)) return verdict(Reason.ADD_ON_CONFLICT, Field['addOns.starter-set']);
  const w = canonicalParams(p, [ParamKind.BYTES32, ParamKind.UINT32]);
  if (w === null) return verdict(Reason.ADD_ON_PARAMS_MALFORMED, Field['addOns.starter-set']);
  if ((word(w, 1) < 0n || word(w, 1) > 10000n)) return verdict(Reason.OUT_OF_RANGE, Field['addOns.starter-set.count']);
  if (!((word(w, 1) === 0n && word(w, 0) === 0n) || (word(w, 0) !== 0n && word(w, 1) !== 0n && word(w, 1) !== 1n && word(w, 1) !== 2n && word(w, 1) !== 3n && word(w, 1) !== 4n && word(w, 1) !== 5n && word(w, 1) !== 6n && word(w, 1) !== 7n && word(w, 1) !== 8n && word(w, 1) !== 9n))) return verdict(Reason.ADD_ON_CONFLICT, Field['addOns.starter-set']);
  return OK;
}

/** Add-on 9 `held-item-earnings`: Earnings of held items: price-coin earnings feed this box. */
function checkHeldItemEarnings(): Verdict {
  return verdict(Reason.ADD_ON_NOT_AVAILABLE, Field['addOns.held-item-earnings']);
}

/** Add-on 10 `humble-creator`: Humble creator: a cap on everything the creator takes, per 30 days. */
function checkHumbleCreator(): Verdict {
  return verdict(Reason.ADD_ON_NOT_AVAILABLE, Field['addOns.humble-creator']);
}

function checkShop(s: BoxSpecV2Bytes): Verdict {
  if (s.boxType !== BoxType.SHOP) return OK;
  const p = hexToBytes(s.contentsParams);
  const n = readWordAt(p, 32n * (13n));
  if (readWordAt(p, 32n * (0n)) !== 32n || readWordAt(p, 32n * (11n)) !== 384n || n > 64n) return verdict(Reason.RECIPE_RULE, Field.contentsParams);
  if (BigInt(p.length) !== 480n + n * 64n || readWordAt(p, 32n * (12n)) !== 416n + n * 32n || readWordAt(p, 32n * (14n + n)) !== n) return verdict(Reason.RECIPE_RULE, Field.contentsParams);
  if (readWordAt(p, 32n * (6n)) > 65535n) return verdict(Reason.RECIPE_RULE, Field.contentsParams);
  if (readWordAt(p, 32n * (7n)) > 65535n) return verdict(Reason.RECIPE_RULE, Field.contentsParams);
  if (readWordAt(p, 32n * (8n)) > 65535n) return verdict(Reason.RECIPE_RULE, Field.contentsParams);
  if (readWordAt(p, 32n * (9n)) > 4294967295n) return verdict(Reason.RECIPE_RULE, Field.contentsParams);
  if (readWordAt(p, 32n * (10n)) > 1461501637330902918203684832716283019655932542975n) return verdict(Reason.RECIPE_RULE, Field.contentsParams);
  for (let i = 0n; i < n; ++i) {
    if (readWordAt(p, 32n * (14n + i)) > 1461501637330902918203684832716283019655932542975n || readWordAt(p, 32n * (15n + n + i)) > 255n) return verdict(Reason.RECIPE_RULE, Field.contentsParams);
  }
  let previous = 0n;
  for (let i = 2n; i < 6n; ++i) {
    const price = readWordAt(p, 32n * (i));
    if (price <= previous) return verdict(Reason.OUT_OF_RANGE, Field.contentsParams);
    previous = price;
  }
  if (readWordAt(p, 32n * (6n)) !== 12500n && readWordAt(p, 32n * (6n)) !== 15000n && readWordAt(p, 32n * (6n)) !== 20000n && readWordAt(p, 32n * (6n)) !== 30000n) return verdict(Reason.NOT_A_MEMBER, Field.contentsParams);
  if (readWordAt(p, 32n * (7n)) !== 500n && readWordAt(p, 32n * (7n)) !== 1000n) return verdict(Reason.NOT_A_MEMBER, Field.contentsParams);
  if (readWordAt(p, 32n * (8n)) !== 100n && readWordAt(p, 32n * (8n)) !== 250n && readWordAt(p, 32n * (8n)) !== 500n) return verdict(Reason.NOT_A_MEMBER, Field.contentsParams);
  if (readWordAt(p, 32n * (9n)) !== 604800n && readWordAt(p, 32n * (9n)) !== 1209600n && readWordAt(p, 32n * (9n)) !== 2592000n) return verdict(Reason.NOT_A_MEMBER, Field.contentsParams);
  let minInitialGiveT = previous;
  for (let i = 0n; i < n; ++i) {
    const addressWord = readWordAt(p, 32n * (14n + i));
    if (addressWord === 0n) return verdict(Reason.ZERO_VALUE, Field.contentsParams);
    if (readWordAt(p, 32n * (15n + n + i)) > 3n) return verdict(Reason.OUT_OF_RANGE, Field.contentsParams);
    const giveT = readWordAt(p, 32n * (2n + readWordAt(p, 32n * (15n + n + i))));
    if (giveT < minInitialGiveT) minInitialGiveT = giveT;
    for (let j = 0n; j < i; ++j) {
      if (readWordAt(p, 32n * (14n + j)) === addressWord) return verdict(Reason.RECIPE_RULE, Field.contentsParams);
    }
  }
  if (readWordAt(p, 32n * (1n)) !== 0n && !hasAddOn(s, 8)) return verdict(Reason.ADD_ON_REQUIRED, Field.contentsParams);
  // F132: the allowance floor needs only two cheapest initially listed gives, even for an empty shop.
  // Division refuses an unrepresentable required seed without overflowing uint256.
  const seed = readWordAt(p, 32n * (1n));
  if (n === 0n || seed / 2n < minInitialGiveT) return verdict(Reason.OUT_OF_RANGE, Field.contentsParams);
  return OK;
}

function checkRules(s: BoxSpecV2Bytes, ctx: ReleaseContextV2): Verdict {
  let v: Verdict;
  // shop fees are sellers only on a shop; pile fees require a pile
  for (let k = 0; k < 2; k++) {
    v = branchRules1(k, s, ctx, s.buyers, s.buyers.a, true, 17000);
    if (v.reason !== Reason.OK) return v;
    if (!(s.buyers.split === Split.NoSplit)) {
      v = branchRules1(k, s, ctx, s.buyers, s.buyers.b, true, 17010);
      if (v.reason !== Reason.OK) return v;
    }
    v = branchRules1(k, s, ctx, s.sellers, s.sellers.a, false, 18000);
    if (v.reason !== Reason.OK) return v;
    if (!(s.sellers.split === Split.NoSplit)) {
      v = branchRules1(k, s, ctx, s.sellers, s.sellers.b, false, 18010);
      if (v.reason !== Reason.OK) return v;
    }
  }
  // one whole choice per side
  v = sideRules2(s, ctx, s.buyers, true, 17000);
  if (v.reason !== Reason.OK) return v;
  v = sideRules2(s, ctx, s.sellers, false, 18000);
  if (v.reason !== Reason.OK) return v;
  // only menu combinations; items require the own new collection
  for (let k = 0; k < 2; k++) {
    v = branchRules3(k, s, ctx, s.buyers, s.buyers.a, true, 17000);
    if (v.reason !== Reason.OK) return v;
    if (!(s.buyers.split === Split.NoSplit)) {
      v = branchRules3(k, s, ctx, s.buyers, s.buyers.b, true, 17010);
      if (v.reason !== Reason.OK) return v;
    }
    v = branchRules3(k, s, ctx, s.sellers, s.sellers.a, false, 18000);
    if (v.reason !== Reason.OK) return v;
    if (!(s.sellers.split === Split.NoSplit)) {
      v = branchRules3(k, s, ctx, s.sellers, s.sellers.b, false, 18010);
      if (v.reason !== Reason.OK) return v;
    }
  }
  // open art publishes its reveal list
  if ((s.artMode === ArtMode.OPEN && isZeroHex(s.revealListId))) return verdict(Reason.ZERO_VALUE, Field.revealListId);
  // hidden art keeps its reveal list private
  if ((s.artMode === ArtMode.HIDDEN && !isZeroHex(s.revealListId))) return verdict(Reason.MUST_BE_ZERO, Field.revealListId);
  // hidden art needs the placeholders add-on
  if ((s.artMode === ArtMode.HIDDEN && !hasAddOn(s, AddOnId.Placeholders))) return verdict(Reason.ADD_ON_REQUIRED, Field.artMode);
  // a creator payout names its recipient
  if (((s.buyers.a.dest === Dest.Creator || s.sellers.a.dest === Dest.Creator || hasAddOn(s, AddOnId.Royalties)) && isZeroHex(s.creatorFeeRecipient))) return verdict(Reason.ZERO_VALUE, Field.creatorFeeRecipient);
  // no fee recipient without a creator payout
  if ((!(s.buyers.a.dest === Dest.Creator || s.sellers.a.dest === Dest.Creator || hasAddOn(s, AddOnId.Royalties)) && !isZeroHex(s.creatorFeeRecipient))) return verdict(Reason.MUST_BE_ZERO, Field.creatorFeeRecipient);
  // a shop commits its collection list
  if ((s.boxType === BoxType.SHOP && !hasAddOn(s, AddOnId.CollectionList))) return verdict(Reason.ADD_ON_REQUIRED, Field.addOns);
  // the creator buy cannot fill the curve
  if ((!(s.creatorBuy === 0n) && !(s.creatorBuy < s.raise))) return verdict(Reason.OUT_OF_RANGE, Field.creatorBuy);
  return OK;
}

/** Rule `k` of a run of branch rules (rule-major: `checkRules` loops k) on one branch (`buyers`: the buyers' side; `base`: its sub-field base). */
function branchRules1(k: number, s: BoxSpecV2Bytes, _ctx: ReleaseContextV2, _d: SideV2, br: BranchV2, buyers: boolean, base: number): Verdict {
  // shop fees are sellers only on a shop
  if ((k === 0 && ((br.leg === Leg.BuyT && br.dest === Dest.BudgetOrPile) && !(s.boxType === BoxType.SHOP && !buyers)))) return verdict(Reason.NOT_OFFERED, base + 2);
  // pile fees require a pile
  if ((k === 1 && ((br.dest === Dest.BudgetOrPile && br.leg === Leg.AsPaid) && !(s.boxType === BoxType.PILE)))) return verdict(Reason.NOT_OFFERED, base + 2);
  return OK;
}

/** A run of side rules, in source order, on one side (`buyers`: the buyers' side; `base`: its sub-field base). */
function sideRules2(_s: BoxSpecV2Bytes, _ctx: ReleaseContextV2, d: SideV2, _buyers: boolean, base: number): Verdict {
  // one whole choice per side
  if (!(d.split === Split.NoSplit)) return verdict(Reason.SPLIT_RULE, base + 21);
  return OK;
}

/** Rule `k` of a run of branch rules (rule-major: `checkRules` loops k) on one branch (`buyers`: the buyers' side; `base`: its sub-field base). */
function branchRules3(k: number, s: BoxSpecV2Bytes, _ctx: ReleaseContextV2, _d: SideV2, br: BranchV2, _buyers: boolean, base: number): Verdict {
  // only menu combinations
  if ((k === 0 && !((br.leg === Leg.AsPaid && !(br.dest === Dest.RESERVED_3 || br.dest === Dest.RESERVED_5)) || (br.leg === Leg.BuyT && (br.dest === Dest.Eat || br.dest === Dest.Holders || br.dest === Dest.BudgetOrPile || br.dest === Dest.Items))))) return verdict(Reason.MENU_RULE, base + 1);
  // items require the own new collection
  if ((k === 1 && (br.dest === Dest.Items && !(s.boxType === BoxType.NEW_COLLECTION)))) return verdict(Reason.NOT_OFFERED, base + 2);
  return OK;
}

function listingKnown(ctx: ReleaseContextV2, id: bigint | number): boolean {
  return ctx.listing.kind !== 0 && BigInt(ctx.listing.id) === BigInt(id);
}

function listingTokenIs(ctx: ReleaseContextV2, id: bigint | number, token: Address): boolean {
  return listingKnown(ctx, id) && sameAddress(ctx.listing.token, token);
}

function raiseMatches(ctx: ReleaseContextV2, id: bigint | number, raise: bigint): boolean {
  return listingKnown(ctx, id) && raise === ctx.listing.raise;
}

/** Head word `i` of canonical params (Solidity `_pw`). */
function pw(p: Hex, i: number): bigint {
  return readWordAt(hexToBytes(p), BigInt(32 * i));
}

const wordAddress = (w: bigint): Address => `0x${w.toString(16).padStart(40, '0')}`;

function hasAddOn(s: BoxSpecV2Bytes, id: number): boolean {
  return s.addOns.some((a) => a.id === id);
}

// ------------------------------------------------------------------------------------------------ zod
const uintN = (bits: number) => z.number().int().min(0).max(2 ** bits - 1);
const uintBig = (bits: number) => z.bigint().min(0n).max((1n << BigInt(bits)) - 1n);
const hexBytes = z.custom<Hex>((v) => typeof v === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(v), 'hex bytes');
const bytes32 = z.custom<Hex>((v) => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v), '32 hex bytes');
const address = z.custom<Address>((v) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v), 'an address');
/** The zod schema of a BoxSpecV2 built here: the ABI types, then `validateBoxSpecV2` against `ctx`; a refusal carries Solidity`s { reason, field }. */
export function boxSpecV2Schema(ctx: ReleaseContextV2) {
  return z
    .object({
      format: uintN(16),
      version: uintN(16),
      boxType: uintN(8),
      tokenName: z.string(),
      tokenSymbol: z.string(),
      collectionName: z.string(),
      collectionSymbol: z.string(),
      description: z.string(),
      n: uintN(32),
      firstId: uintBig(256),
      pricing: z.object({ listingId: uintN(32), token: address }),
      raise: uintBig(256),
      layout: uintN(8),
      gradLayout: uintN(8),
      launchFormat: uintN(8),
      openAt: uintN(32),
      deadlineDays: uintN(16),
      buyers: z.object({ a: z.object({ leg: uintN(8), dest: uintN(8), legParams: hexBytes, destParams: hexBytes }), b: z.object({ leg: uintN(8), dest: uintN(8), legParams: hexBytes, destParams: hexBytes }), split: uintN(8), splitParams: hexBytes }),
      sellers: z.object({ a: z.object({ leg: uintN(8), dest: uintN(8), legParams: hexBytes, destParams: hexBytes }), b: z.object({ leg: uintN(8), dest: uintN(8), legParams: hexBytes, destParams: hexBytes }), split: uintN(8), splitParams: hexBytes }),
      artMode: uintN(8),
      revealRoot: bytes32,
      metadataTable: hexBytes,
      generatorHash: bytes32,
      coverSha256: bytes32,
      revealListId: bytes32,
      marketplaceOwner: address,
      creatorFeeRecipient: address,
      creatorBuy: uintBig(256),
      collectionCoverSha256: bytes32,
      addOns: z.array(z.object({ id: uintN(16), params: hexBytes })),
      contentsParams: hexBytes,
      pickFeeBps: uintN(16),
    })
    .superRefine((spec, refinement) => {
      const v = validateBoxSpecV2(spec, ctx);
      if (v.reason === Reason.OK) return;
      const field = FIELD_NAMES[v.field] ?? 'spec';
      refinement.addIssue({ code: 'custom', message: `${REASON_NAMES[v.reason] ?? 'UNKNOWN'} at ${field}`, path: [field.split('.')[0] ?? field], params: { reason: v.reason, field: v.field } });
    });
}

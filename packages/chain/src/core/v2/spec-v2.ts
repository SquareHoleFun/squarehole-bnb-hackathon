/**
 * Format 2's spec as registry v2's `BoxSpec` log carries it (ticket M1-52; SpecTypes.sol, RecipeTypes.sol), read
 * without M1-10's generated twin: the frozen struct decodes, the record's spec hash, pricing listing and raise are
 * checked, and the recipes and plug-ins are named from the frozen enums. `validate()` stays M1-10's; this decoder
 * checks nothing a spec's rules decide.
 *
 * Plug-ins (ADR-0017 § 2): a RULE is a side's `Split.PlugIn` (`RuleSplitParams`), a LEG a branch's `Leg.PlugIn`
 * (`PlugInLegParams`), a TARGET a `Convert` leg or a `Box` destination whose `how` is `TargetHow.PlugIn`; each is named
 * by its implementation and its runtime code hash.
 */
import { decodeAbiParameters, encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';
import { AddOnId, BoxType, Dest, FeeChoice, Leg } from '@squarehole/box-spec/v2';
import { boxSpecV2Parameter, PARAMS_V2 } from './abi-v2';
import { SpecRecordMismatch, type BoxRecordV2 } from './record-v2';

/**
 * Upper-case member names (`FIT_OWED`), written as the lower-case code identifiers they are: the site's wording scan
 * (apps/web/src/copy-wording.test.ts, F23) reads any upper-case literal as copy, and these are names, never copy; the
 * site words them itself (SH-V2-M1-52.md, change request 2).
 */
const upper = (names: readonly string[]): readonly string[] => Object.freeze(names.map((n) => n.toUpperCase()));

/** The frozen enums' members in order (index = wire value), as abi-v2.test.ts checks them against the Solidity text. */
export const ENUM_NAMES_V2 = Object.freeze({
  Leg: ['None', 'AsPaid', 'BuyT', 'RESERVED_3', 'RESERVED_4', 'RESERVED_5'],
  Dest: ['None', 'Eat', 'Creator', 'RESERVED_3', 'Depth', 'RESERVED_5', 'Holders', 'BudgetOrPile', 'Items', 'Module'],
  Split: ['None', 'NoSplit', 'RESERVED_2', 'RESERVED_3', 'RESERVED_4'],
  // TODO(CQ11-E): retire legacy view models and their labels for removed subsystems.
  TargetHow: ['None', 'Fixed', 'PlugIn'],
  BoxType: upper(['none', 'new_collection', 'existing', 'token_only', 'shop', 'pile']),
  ListingClass: upper(['none', 'native', 'standard', 'stable', 'stock', 'other']),
  ListingKind: upper(['none', 'listed', 'box_token']),
  HopKind: upper(['none', 'v3_pool', 'v2_pair', 'box_pool', 'fixed_rate']),
  Purpose: upper(['none', 'fit_owed', 'convert', 'royalty', 'royalty_depth', 'rebuy', 'earned', 'platform_owed']),
  Direction: upper(['none', 'forward', 'reverse']),
  BranchId: upper(['none', 'buyers_a', 'buyers_b', 'sellers_a', 'sellers_b']),
  StepWait: upper(['none', 'empty', 'below_step_min', 'at_band', 'pool_slot_taken']),
  StepFailure: upper(['none', 'average_not_ready', 'oracle_not_covering', 'depth_too_thin', 'fixed_rate_check', 'fixed_rate_implementation', 'swap_reverted', 'min_out', 'exact_change', 'delivery_reverted']),
  ChunkPart: ['None', 'Table', 'Texts'],
  FailCause: ['None', 'Deadline', 'ClosedPastCap', 'GraduationTimedOut'],
  CapKind: upper(['none', 'cap_30_days', 'humble']),
  HeldKind: upper(['none', 'curve_and_tax', 'pool_share', 'creator_branch', 'depth_branch', 'royalties', 'reserved_eat_fit_box_or_leg_branch', 'items_credits', 'holders_credits', 'budget_or_pile', 'reserved_gifts_received', 'reserved_gifts_waiting_at_giver', 'fit_share', 'platform_share', 'burn_branch', 'graduation_reserve', 'eat_price_coin', 'holders_t_pending', 'items_t_pending', 'pile_fees_pending', 'module_pending', 'shop_fees_pending', 'side_carry']),
  // RC5-C appends creator_payee (9) for non-P royalties; existing route ordinals remain stable.
  FailRoute: upper(['none', 'closing_pool', 'fit', 'stay_claimable', 'back_to_seeder', 'as_booked', 'platform', 'reserved_conversion_safe', 'locked', 'creator_payee']),
});

export type EnumNameV2 = keyof typeof ENUM_NAMES_V2;

/** Create switch names beside the wire enums. Null means deliberately outside the offered Create surface.
 * Exhaustive records and inventory tests force each new enum value to get an explicit decision. */
export const CREATE_KIND_KEYS_V2 = {
  [BoxType.NEW_COLLECTION]: 'kind.collection', [BoxType.EXISTING]: null,
  [BoxType.TOKEN_ONLY]: 'kind.token', [BoxType.SHOP]: 'kind.shop', [BoxType.PILE]: 'kind.pile',
} as const satisfies Record<(typeof BoxType)[keyof typeof BoxType], string | null>;
export const CREATE_ADDON_KEYS_V2 = {
  [AddOnId.Placeholders]: 'addon.1', [AddOnId.EditionSpecials]: 'addon.3', [AddOnId.Royalties]: 'addon.4',
  [AddOnId.CollectionMetadata]: 'addon.6', [AddOnId.CollectionList]: 'addon.7', [AddOnId.StarterSet]: 'addon.8',
  [AddOnId.HeldItemEarnings]: null, [AddOnId.HumbleCreator]: null,
} as const satisfies Record<(typeof AddOnId)[keyof typeof AddOnId], string | null>;
/** [key suffix, leg wire, destination wire]. Shop is sellers-only. */
export const CREATE_FEE_KEYS_V2 = {
  [FeeChoice.Keep]: ['keep', Leg.AsPaid, Dest.Creator],
  [FeeChoice.Burn]: ['burn', Leg.BuyT, Dest.Eat],
  [FeeChoice.Grow]: ['grow', Leg.AsPaid, Dest.Depth],
  [FeeChoice.Holders]: ['holders-p', Leg.AsPaid, Dest.Holders],
  [FeeChoice.Items]: ['items-p', Leg.AsPaid, Dest.Items],
  [FeeChoice.EatPriceCoin]: ['eat', Leg.AsPaid, Dest.Eat],
  [FeeChoice.HoldersT]: ['holders-t', Leg.BuyT, Dest.Holders],
  [FeeChoice.ItemsT]: ['items-t', Leg.BuyT, Dest.Items],
  [FeeChoice.Pile]: ['pile', Leg.AsPaid, Dest.BudgetOrPile],
  [FeeChoice.Module]: ['alchemist', Leg.AsPaid, Dest.Module],
  [FeeChoice.ShopT]: ['shop', Leg.BuyT, Dest.BudgetOrPile],
} as const satisfies Record<(typeof FeeChoice)[keyof typeof FeeChoice], readonly [string, number, number]>;

/** A wire value's member name; an unknown value reads `UNKNOWN(n)` (a bad value decodes, ADR-0017's wire rule). */
export function enumName(kind: EnumNameV2, value: number | bigint): string {
  const members: readonly string[] = ENUM_NAMES_V2[kind];
  return members[Number(value)] ?? `UNKNOWN(${value})`;
}

export interface BranchV2 {
  readonly leg: number;
  readonly dest: number;
  readonly legParams: Hex;
  readonly destParams: Hex;
}

export interface SideV2 {
  readonly a: BranchV2;
  readonly b: BranchV2;
  readonly split: number;
  readonly splitParams: Hex;
}

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
  readonly addOns: readonly { readonly id: number; readonly params: Hex }[];
  readonly contentsParams: Hex;
  readonly pickFeeBps: number;
}

export function encodeBoxSpecV2(spec: BoxSpecV2): Hex {
  return encodeAbiParameters([boxSpecV2Parameter], [spec as never]);
}

/** Decodes the `BoxSpec` bytes and checks them against the record (hash, pricing listing and token, raise). */
export function decodeBoxSpecV2(encodedSpec: Hex, record: BoxRecordV2): BoxSpecV2 {
  if (keccak256(encodedSpec).toLowerCase() !== record.specHash.toLowerCase()) throw new SpecRecordMismatch(`box ${record.boxId}: the BoxSpec bytes do not hash to the record's spec hash`);
  let spec: BoxSpecV2;
  try {
    spec = decodeAbiParameters([boxSpecV2Parameter], encodedSpec)[0] as unknown as BoxSpecV2;
  } catch (error) {
    throw new SpecRecordMismatch(`box ${record.boxId}: the BoxSpec bytes do not decode as format 2 (${error instanceof Error ? error.message : String(error)})`);
  }
  if (spec.pricing.listingId !== record.pricingListingId || spec.pricing.token.toLowerCase() !== record.q.toLowerCase()) throw new SpecRecordMismatch(`box ${record.boxId}: the spec's pricing listing or token is not the record's`);
  if (spec.raise !== record.raise) throw new SpecRecordMismatch(`box ${record.boxId}: the spec's raise is not the record's`);
  return spec;
}

export type PlugInSlot = 'RULE' | 'LEG' | 'TARGET';

export interface PlugInRef {
  readonly slot: PlugInSlot;
  readonly side: 'buyers' | 'sellers';
  /** The branch for a LEG or TARGET; null for a side's RULE. */
  readonly branch: 'a' | 'b' | null;
  readonly implementation: Address;
  readonly codeHash: Hex;
}

const decode = <T extends readonly unknown[]>(params: (typeof PARAMS_V2)[keyof typeof PARAMS_V2], data: Hex): T => decodeAbiParameters(params, data) as unknown as T;

/** Every plug-in the spec names, buyers then sellers; per side its RULE, then branch a, then b. */
export function plugInsOf(spec: BoxSpecV2): PlugInRef[] {
  const out: PlugInRef[] = [];
  for (const side of ['buyers', 'sellers'] as const) {
    const s = spec[side];
    if (s.split === 4) {
      const [implementation, codeHash] = decode<[Address, Hex]>(PARAMS_V2.ruleSplit, s.splitParams);
      out.push({ slot: 'RULE', side, branch: null, implementation, codeHash });
    }
    for (const branch of ['a', 'b'] as const) {
      const b = s[branch];
      if (b.leg === 5) {
        const [implementation, codeHash] = decode<[Address, Hex]>(PARAMS_V2.plugInLeg, b.legParams);
        out.push({ slot: 'LEG', side, branch, implementation, codeHash });
      }
      if (b.leg === 4) {
        const [how, , , implementation, codeHash] = decode<[number, number, Address, Address, Hex]>(PARAMS_V2.convertLeg, b.legParams);
        if (how === 2) out.push({ slot: 'TARGET', side, branch, implementation, codeHash });
      }
      if (b.dest === 5) {
        const [, how, , , implementation, codeHash] = decode<[number, number, number, bigint, Address, Hex]>(PARAMS_V2.boxDest, b.destParams);
        if (how === 2) out.push({ slot: 'TARGET', side, branch, implementation, codeHash });
      }
    }
  }
  return out;
}

export interface BranchViewV2 {
  readonly leg: string;
  readonly dest: string;
  /** The leg's params by name (`Convert`, `PlugIn`), else null. */
  readonly legParams: Readonly<Record<string, unknown>> | null;
  readonly destParams: Readonly<Record<string, unknown>> | null;
}

export interface SideViewV2 {
  readonly split: string;
  readonly splitParams: Readonly<Record<string, unknown>> | null;
  readonly a: BranchViewV2;
  /** Null with `NoSplit` (b all zero). */
  readonly b: BranchViewV2 | null;
}

function named(params: (typeof PARAMS_V2)[keyof typeof PARAMS_V2], data: Hex, rename: Readonly<Record<string, string>> = {}): Record<string, unknown> {
  const values = decodeAbiParameters(params, data);
  return Object.fromEntries(params.map((p, i) => [rename[p.name ?? ''] ?? p.name ?? String(i), values[i]]));
}

const IMPL = { impl: 'implementation' };

function branchView(b: BranchV2): BranchViewV2 {
  const legParams = b.leg === 4 ? named(PARAMS_V2.convertLeg, b.legParams, IMPL) : b.leg === 5 ? named(PARAMS_V2.plugInLeg, b.legParams, IMPL) : null;
  const destParams = b.dest === 8 ? named(PARAMS_V2.itemsDest, b.destParams) : b.dest === 9 ? { id: decodeAbiParameters([{ type: 'uint32' }], b.destParams)[0] } : b.dest === 5 ? named(PARAMS_V2.boxDest, b.destParams, IMPL) : b.dest === 6 ? named(PARAMS_V2.holdersDest, b.destParams) : null;
  return { leg: enumName('Leg', b.leg), dest: enumName('Dest', b.dest), legParams, destParams };
}

function sideView(s: SideV2): SideViewV2 {
  const splitParams = s.split === 2 ? named(PARAMS_V2.fixedShare, s.splitParams) : s.split === 3 ? named(PARAMS_V2.cap30Days, s.splitParams) : s.split === 4 ? named(PARAMS_V2.ruleSplit, s.splitParams, IMPL) : null;
  const bEmpty = s.b.leg === 0 && s.b.dest === 0;
  return { split: enumName('Split', s.split), splitParams, a: branchView(s.a), b: bEmpty ? null : branchView(s.b) };
}

/** Both sides' recipes, named (box-spec-v2-draft.md § 3). */
export function recipeOf(spec: BoxSpecV2): { readonly buyers: SideViewV2; readonly sellers: SideViewV2 } {
  return { buyers: sideView(spec.buyers), sellers: sideView(spec.sellers) };
}

/** Add-on 10's presets 1-5 in ETH per 30 days (box-spec-v2-draft.md § 6, F94 R18F). */
const HUMBLE_PRESET_ETH: readonly bigint[] = [0n, 1n, 4n, 8n, 16n, 32n];

/** The humble cap in wei per 30-day window, or null without add-on 10 (or with a preset outside 1-5). */
export function humbleCapEth(spec: BoxSpecV2): bigint | null {
  const addOn = spec.addOns.find((a) => a.id === 10);
  if (!addOn) return null;
  const [preset] = decodeAbiParameters(PARAMS_V2.humbleAddOn, addOn.params);
  const eth = preset >= 1 && preset <= 5 ? HUMBLE_PRESET_ETH[preset] : undefined;
  return eth === undefined ? null : eth * 10n ** 18n;
}

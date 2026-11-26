/**
 * Each fee side's kind (F70; box creation flow § 2.2): buyers' fees arrive in Q, sellers' fees in T, and each side's
 * 10/15 goes to the creator, to holders or to a burn, paid in T or Q. Everything here is built from the catalog's own
 * member data (`ENUM_MEMBERS`: kind, paidIn, buys/sells; `OFFERED_ON`) and the factory's own check (`validateBoxSpecV1`),
 * never from a copied table, so the creation page, the Overview and the box page say the same thing. What is offered
 * depends on the network (F74 U1): holder payouts in the Demo, marked pending legal review; never on mainnet.
 */
import {
  CONTEXT_V2,
  DEMO_TOKEN_ONLY,
  ENUM_MEMBERS,
  QClass,
  STRICTEST_NETWORK,
  QStream,
  Reason,
  validateBoxSpecV1,
  type EnumMemberInfo,
  type Network,
  type BoxSpecV1,
  type QAsset,
  type VersionContext,
} from '@squarehole/box-spec';
import type { Address } from '@squarehole/domain';
import type { FeeSideFacts } from './box-model';
import { offeredOn, pendingNote } from './spec-network';
import { NATIVE_SYMBOL } from '../data-source/native-coin';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export type FeeSide = 'buyers' | 'sellers';
/** The kinds a creator picks between (STREAM is box 0's per-item stream, never offered on the page). */
export type SideKind = 'creator' | 'holders' | 'burn';

const ENUM_OF: Readonly<Record<FeeSide, string>> = Object.freeze({ buyers: 'QStream', sellers: 'TStream' });
const FIELD_OF: Readonly<Record<FeeSide, string>> = Object.freeze({ buyers: 'qStream', sellers: 'tStream' });
const KIND_OF: Readonly<Record<EnumMemberInfo['kind'], FeeSideFacts['kind']>> = Object.freeze({ CREATOR: 'creator', HOLDERS: 'holders', BURN: 'burn', STREAM: 'stream' });
export const SIDE_KINDS: readonly SideKind[] = Object.freeze(['creator', 'holders', 'burn']);
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const ZERO_HASH = `0x${'0'.repeat(64)}` as const;

/** A side's members in value order. */
export const sideMembers = (side: FeeSide): readonly EnumMemberInfo[] => ENUM_MEMBERS[ENUM_OF[side]] ?? [];
export const memberOf = (side: FeeSide, value: number): EnumMemberInfo | null => sideMembers(side).find((member) => member.value === value) ?? null;
/** Whether `network` offers this value (holder payouts: the Demo only, F74 U1; mainnet, the default, is validate()'s list). */
export const isOffered = (side: FeeSide, value: number, network: Network = STRICTEST_NETWORK): boolean => offeredOn(FIELD_OF[side], value, network);
/** "Pending legal review" beside a value offered early (holder payouts), else null. */
export const sidePending = (side: FeeSide, value: number): string | null => pendingNote(ENUM_OF[side], value);
export const isCreatorValue = (side: FeeSide, value: number): boolean => memberOf(side, value)?.kind === 'CREATOR';
/** Whether either side pays the creator (then the spec names creatorFeeRecipient, and the fee cap may apply). */
export const creatorOnEitherSide = (qStream: number, tStream: number): boolean => isCreatorValue('buyers', qStream) || isCreatorValue('sellers', tStream);

/** Whether Q has a real burn (FIT or a listed box token); native ETH and plain ERC-20s do not. */
export const qBurns = (asset: QAsset | undefined): boolean => asset !== undefined && (asset.qClass === QClass.FIT || asset.qClass === QClass.BOX_T);

/**
 * What a side's 10/15 goes out in: T, Q, or FIT's buy-and-burn. A burn paid in Q burns Q only where Q has a real burn
 * (BURN_Q, and SELL_FOR_Q's proceeds with such a Q); otherwise it joins FIT's buy-and-burn.
 */
export function sideToken(side: FeeSide, member: EnumMemberInfo, burns: boolean): FeeSideFacts['token'] {
  if (member.kind !== 'BURN') return member.paidIn;
  if (member.paidIn === 'T') return 'T';
  if (side === 'buyers') return member.value === QStream.BURN_Q ? 'Q' : 'FIT';
  return burns ? 'Q' : 'FIT';
}

/** The facts of one side's value, or null when it is not a member. */
export function sideFacts(side: FeeSide, value: number, burns = false): FeeSideFacts | null {
  const member = memberOf(side, value);
  if (!member) return null;
  return Object.freeze({ kind: KIND_OF[member.kind], token: sideToken(side, member, burns), converts: member.buys ? 'buys' : member.sells ? 'sells' : null, pending: sidePending(side, value) });
}

/**
 * The token-only box the check below probes with: the Demo fixture, or on the production site (which ships no Demo
 * fixture) the same box with neutral words and placeholder hashes. Every field the factory's check reads for a fee pair
 * is the fixture's (fee-kinds.test.ts compares the two over every pair and network).
 */
export const NEUTRAL_TOKEN_ONLY: BoxSpecV1 = Object.freeze({
  version: 2,
  boxType: 3,
  tokenName: 'Plain Token',
  tokenSymbol: 'PLAIN',
  collectionName: '',
  collectionSymbol: '',
  description: 'A plain token launch with no NFTs and no vault.',
  n: 0,
  firstId: 1n,
  q: ZERO_ADDRESS,
  raise: 4_206_980_085_000_000_000n,
  layout: 1,
  gradLayout: 2,
  launchFormat: 1,
  openAt: 0,
  deadlineDays: 60,
  qStream: 5,
  tStream: 1,
  artMode: 0,
  revealRoot: ZERO_HASH,
  metadataTable: '0x',
  generatorHash: ZERO_HASH,
  coverSha256: `0x${'11'.repeat(32)}`,
  revealListId: ZERO_HASH,
  marketplaceOwner: ZERO_ADDRESS,
  creatorFeeRecipient: '0x0000000000000000000000000000000000000001',
  creatorBuy: 0n,
  collectionCoverSha256: ZERO_HASH,
  addOns: [],
});
export const PROBE_TOKEN_ONLY: BoxSpecV1 = DEMO_BUILD ? DEMO_TOKEN_ONLY : NEUTRAL_TOKEN_ONLY;

/**
 * Whether a pair of values passes the factory's own check on `network`, everything else being a valid token-only box
 * (the probe above): BP-13's pair and BURN_Q without a real burn are MENU_RULE, holder payouts NOT_OFFERED outside
 * the Demo.
 */
export function pairAllowed(qStream: number, tStream: number, asset: QAsset | undefined = CONTEXT_V2.qList[0], ctx: VersionContext = CONTEXT_V2, network: Network = STRICTEST_NETWORK, probe: BoxSpecV1 = PROBE_TOKEN_ONLY): boolean {
  const creator = creatorOnEitherSide(qStream, tStream);
  const spec = {
    ...probe,
    q: asset?.token ?? ZERO_ADDRESS,
    raise: asset?.raisePresets[0] ?? probe.raise,
    qStream,
    tStream,
    creatorFeeRecipient: creator ? probe.creatorFeeRecipient : ZERO_ADDRESS,
    creatorBuy: 0n,
    addOns: [],
  };
  return validateBoxSpecV1(spec, ctx, network).reason === Reason.OK;
}

/** One choice inside a kind: the token it pays in (or burns), and why it is off beside the other side's value. */
export interface MemberChoice {
  readonly value: number;
  readonly token: FeeSideFacts['token'];
  readonly converts: FeeSideFacts['converts'];
  /** Allowed with some value of the other side, but not with the one chosen now (BP-13). */
  readonly disabled: boolean;
}

export interface KindChoice {
  readonly kind: SideKind;
  /** The kind's choices this network offers here; none: shown off with its reason (holder payouts outside the Demo). */
  readonly members: readonly MemberChoice[];
  /** Offered early here and marked so ("Pending legal review": holder payouts in the Demo), else null. */
  readonly pending: string | null;
}

/**
 * A side's menu on `network` given the other side's value: each kind with its offered members. A member the factory
 * refuses with every value of the other side (BURN_Q with ETH) is left out; one refused only beside the other side's
 * current value is shown disabled.
 */
export function sideChoices(side: FeeSide, other: number, asset: QAsset | undefined = CONTEXT_V2.qList[0], ctx: VersionContext = CONTEXT_V2, network: Network = STRICTEST_NETWORK): KindChoice[] {
  const otherSide: FeeSide = side === 'buyers' ? 'sellers' : 'buyers';
  const partners = sideMembers(otherSide).filter((member) => isOffered(otherSide, member.value, network) && member.kind !== 'STREAM');
  const allowed = (value: number, partner: number) => (side === 'buyers' ? pairAllowed(value, partner, asset, ctx, network) : pairAllowed(partner, value, asset, ctx, network));
  const burns = qBurns(asset);
  return SIDE_KINDS.map((kind) => {
    const offered = sideMembers(side).filter((member) => KIND_OF[member.kind] === kind && isOffered(side, member.value, network));
    const members = offered
      .filter((member) => partners.some((partner) => allowed(member.value, partner.value)))
      .map((member) => ({ value: member.value, token: sideToken(side, member, burns), converts: member.buys ? ('buys' as const) : member.sells ? ('sells' as const) : null, disabled: !allowed(member.value, other) }));
    const pending = members.map((member) => sidePending(side, member.value)).find((note) => note !== null) ?? null;
    return { kind, members, pending };
  });
}

/** The value a kind starts on: its first choice that is allowed beside the other side (catalog order), or null. */
export function firstChoice(choice: KindChoice): number | null {
  return choice.members.find((member) => !member.disabled)?.value ?? null;
}

/** The pair asset's name: native ETH, else a short address (the curated list names its tokens by address). */
export const qSymbol = (q: Address | string): string => (/^0x0{40}$/i.test(q) ? NATIVE_SYMBOL : `${q.slice(0, 6)}…${q.slice(-4)}`);

/** A side's token in words: the ticker, the pair asset or FIT. */
export const tokenWord = (token: FeeSideFacts['token'], ticker: string, q: string): string => (token === 'T' ? ticker : token === 'Q' ? q : 'FIT');

/** The one flag line a sell gets (F70): "Sells KITE for ETH". A plain sentence, never a control's name. */
export const sellsLine = (ticker: string, q: string): string => `Sells ${ticker} for ${q}`;

/**
 * A side in a few words for the Overview and the box page: "Creator · ETH", "Burn · KITE", "Burn · FIT". `you`: the
 * creation page speaks to the creator ("You · ETH").
 */
export function sideWords(facts: FeeSideFacts | null, ticker: string, q: string, you = false): string {
  if (facts === null) return 'Not known';
  const kind = facts.kind === 'creator' ? (you ? 'You' : 'Creator') : facts.kind === 'holders' ? 'Holders' : facts.kind === 'burn' ? 'Burn' : 'Per item';
  return `${kind} · ${tokenWord(facts.token, ticker, q)}`;
}

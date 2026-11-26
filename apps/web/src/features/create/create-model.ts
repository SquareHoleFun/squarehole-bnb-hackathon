/**
 * The creation page's model (docs/design/box-create-flow.md § 2, F70's order): the creator's choices, the art and the
 * pictures they added, and the one BoxSpecV1 (version 2) they build. Pure and bigint-only: no React, no browser, no
 * Number for amounts. Every rule comes from packages/box-spec (constants, `checkString`, `validateBoxSpecV1`, the
 * catalog's `OFFERED` menus and fee-kind members); nothing here repeats a range by hand except the deadlines and the
 * open presets, and the tests run every menu value through validate().
 */
import { canonicalJson, rawCidV1, type Attribute, type MetadataTable } from '@squarehole/artwork';
import { boxLeaf, buildBoxTree, encodeBoxMetadataTable, packTraits, sha256Hex } from '@squarehole/artwork';
import {
  AddOnId,
  ArtMode,
  BOOTSTRAP_ETH,
  BoxType,
  CONTEXT_V2,
  CapExcess,
  FIRST_ID,
  GradLayout,
  LaunchFormat,
  Layout,
  MAX_ADD_ONS,
  MAX_OPEN_AHEAD_SECONDS,
  OFFERED,
  OFFERED_AMOUNTS,
  QStream,
  STRICTEST_NETWORK,
  RoyaltyDestination,
  TStream,
  decodeCollectionMetadataParams,
  encodeBoxSpecV1,
  encodeCollectionMetadataParams,
  encodeCreatorFeeCapParams,
  encodeEditionSpecialsParams,
  encodePlaceholdersParams,
  encodeRoyaltiesParams,
  specHash,
  type AddOnV1,
  type BoxSpecV1,
  type Network,
} from '@squarehole/box-spec';
import { isDecimalAmount, parseDecimal, type Address } from '@squarehole/domain';
import { getAddress } from 'viem';
import { NO_LINKS, type RoyaltyTo, type SiteLinks } from '../boxes/box-model';
import type { RightsRecord } from '../boxes/created-boxes';
import { creatorOnEitherSide } from '../boxes/fee-kinds';
import { cleanLinks, pageLinkOk } from '../boxes/site-links';

export type Hex = `0x${string}`;
export type StepId = 'basics' | 'contents' | 'kind' | 'raise' | 'launch' | 'overview';

export const STEPS: readonly { readonly id: StepId; readonly label: string }[] = Object.freeze([
  { id: 'basics', label: 'Basics' },
  { id: 'contents', label: 'Contents' },
  { id: 'kind', label: 'Box kind' },
  { id: 'raise', label: 'Raise' },
  // "Opening": the nav item and the feed button say Launch for the whole flow; this step sets when the box opens.
  { id: 'launch', label: 'Opening' },
  { id: 'overview', label: 'Overview' },
]);

/** v1's slugs (§ 0): a kept link or a bookmark opens the step that now holds those choices. */
export const LEGACY_STEPS: Readonly<Record<string, StepId>> = Object.freeze({ collection: 'contents', price: 'raise', fees: 'kind', review: 'overview' });

export const isStepId = (value: string | undefined): value is StepId => STEPS.some((step) => step.id === value);
export const stepIndex = (step: StepId): number => STEPS.findIndex((entry) => entry.id === step);

export const VERSION = 2;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
export const ZERO32 = `0x${'0'.repeat(64)}` as Hex;
/** The largest uint256: creatorBuy's ABI type. */
export const MAX_UINT256 = 2n ** 256n - 1n;
/** The curated pair assets of version 2 (today native ETH only; F44 P3, F61 TB1). */
export const Q_ASSETS = CONTEXT_V2.qList;
/**
 * The raise (F74 U5): one per pair asset, set by the version ("Different sizes confuse people"), never chosen. Native
 * ETH: 4.206980085 ETH, box 0's. The "ETH equivalent" for another Q is open (S12): the version context lists it.
 */
export const raiseOf = (qIndex: number): bigint => (Q_ASSETS[qIndex] ?? Q_ASSETS[0])?.raisePresets[0] ?? 0n;
/** Deadlines for others' boxes (F44 P6). */
export const DEADLINE_DAYS: readonly number[] = Object.freeze([30, 60, 90, 180]);
/**
 * Opens (BoxSpec field 15 openAt, Unix seconds UTC; DECISION-LOG F80, docs/design/open-at-clock-time.md): Now, the
 * default (founder 2026-10-04: "that is what people expect"), is openAt 0: the box opens in the block after its
 * creation block, never in it, so the bootstrap and the creator's own buy (creatorBuy) go in first, in the creation
 * block, and the launch tax starts with the next block. 5 min, 1 h and 24 h become a UTC time when the spec is built
 * (the next whole minute at least that far from the clock, `openAtOf`); "Pick a time" is an exact UTC time.
 */
export const OPEN_PRESETS: readonly { readonly id: string; readonly label: string; readonly seconds: number }[] = Object.freeze([
  { id: 'now', label: 'Now', seconds: 0 },
  { id: '5m', label: '5 min', seconds: 300 },
  { id: '1h', label: '1 h', seconds: 3_600 },
  { id: '24h', label: '24 h', seconds: 86_400 },
]);
/** A picked time must be at least this far ahead (a slow wallet or block would otherwise open the box at once). */
export const PICK_TIME_MIN_AHEAD_SECONDS = 120;
/** The factory refuses an openAt more than 14 days after the creation block (OpenAtTooFar); the page says so first. */
export const PICK_TIME_MAX_AHEAD_SECONDS = Number(MAX_OPEN_AHEAD_SECONDS);
/** Royalties add-on rates (F65), from the catalog: 0 = no add-on. */
export const ROYALTY_BPS: readonly number[] = Object.freeze([...(OFFERED['addOns.royalties.bps'] ?? [])]);
export const ROYALTY_DESTINATION: Readonly<Record<RoyaltyTo, number>> = Object.freeze({
  fees: RoyaltyDestination.FEE_HANDLING,
  creator: RoyaltyDestination.CREATOR,
  pool: RoyaltyDestination.POOL_DEPTH,
});
/** The creator-fee cap's presets (add-on 5, F74 U2), from the catalog: a fixed amount per 30 days in Q raw units; 0n = off. */
export const CAP_PRESETS: readonly bigint[] = Object.freeze([0n, ...(OFFERED_AMOUNTS['addOns.creator-fee-cap.capPerEpoch'] ?? [])]);
/** The cap's amounts are native ETH until S12 sets the other-Q ones: the add-on requires q = native ETH (zero address). */
export const capOffered = (qIndex: number): boolean => /^0x0{40}$/i.test((Q_ASSETS[qIndex] ?? Q_ASSETS[0])?.token ?? '');
/** Where fees above the cap may go, in the enum's order; which are offered depends on the network (HOLDERS: the Demo, F74 U1). */
export const CAP_EXCESS: readonly number[] = Object.freeze(Object.values(CapExcess));
/** The cap excess menu's key in `OFFERED_ON`. */
export const CAP_EXCESS_KEY = 'addOns.creator-fee-cap.excess';
/** Placeholders, royalties, the cap and the collection page take four of the add-on slots; edition specials may use the rest. */
export const MAX_SPECIALS = Number(MAX_ADD_ONS) - 4;
/** Up to 4 teasers (add-on 6, `teaserSha256s` maxItems). */
export const MAX_TEASERS = 4;
/** A neutral hidden picture for the placeholders add-on (plain SVG text, shown only through <img>). */
export const DEFAULT_HIDDEN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#111b29"/><path d="M14 26 32 18l18 8-18 8z" fill="#30415d"/><path d="M14 26v14l18 8 18-8V26M32 34v14" fill="none" stroke="#a78bfa" stroke-width="2" stroke-linejoin="round"/></svg>';
/** Demo cost row: a labelled gas price (no RPC read in the Demo). */
export const DEMO_GAS_PRICE_WEI = 1_000_000_000n;
/** About 4-5M gas for `createBox` plus about 200 gas per byte of box data (pipeline § 3.1, I). */
export const CREATE_GAS_BASE = 4_500_000n;
export const CREATE_GAS_PER_BYTE = 200n;

/** The rights confirmation (F70 step 5, § 4.2): the label, the full statement behind its (i), and its version. P: counsel words it. */
export const RIGHTS_LABEL = 'I hold the rights. No impersonation.';
export const RIGHTS_STATEMENT = 'I own or have licensed the name, logo and art of this box, and I am not pretending to be another person, project or brand.';
export const RIGHTS_STATEMENT_VERSION = 'rights-statement-draft-1';

export interface SpecialRow {
  readonly label: string;
  /** Typed text; a whole number from 1 to N. */
  readonly count: string;
}

/** A preset by its id (OPEN_PRESETS), or a picked time: `utc` is "YYYY-MM-DDTHH:MM" in UTC (the time field's value). */
export type OpenChoice = { readonly kind: 'preset'; readonly id: string } | { readonly kind: 'time'; readonly utc: string };

/** What is in the box (F70 step 2): "Token" (TOKEN_ONLY) or a new collection; null until picked. */
export type ContentsChoice = 'token' | 'collection';

/** Everything the creator chooses, by step; amounts typed as decimal text, parsed into bigint when the spec is built. */
export interface CreateForm {
  // 1 Basics
  readonly qIndex: number;
  /** The token's name and ticker (T); a new collection takes them too unless it has its own (Contents, More). */
  readonly name: string;
  readonly ticker: string;
  readonly description: string;
  readonly links: SiteLinks;
  // 2 Contents
  readonly contents: ContentsChoice | null;
  readonly separateCollection: boolean;
  readonly collectionName: string;
  readonly collectionSymbol: string;
  readonly artMode: 'open' | 'hidden';
  readonly specials: readonly SpecialRow[];
  /** Hidden art: the ticket's two lines (placeholders add-on 103 and 104). */
  readonly ticketLine: string;
  readonly hiddenLine: string;
  /**
   * Hidden art: the picture tickets and unrevealed items show (placeholders add-on 105, plain SVG text on one line).
   * The neutral DEFAULT_HIDDEN_SVG on every new draft; a loaded setup's own (SH-EX-O1: a kit's designed placeholder,
   * load-settings.ts `setupOf`), kept like the rest of its contents. No control of the page sets it.
   */
  readonly hiddenSvg: string;
  readonly royaltyBps: number;
  readonly royaltyTo: RoyaltyTo;
  /** Full-collection permanent storage (K3): optional, paid by the creator, open art only. Not part of the spec. */
  readonly storeAll: boolean;
  /** The collection page's link (add-on 6, field 603); until edited it follows the Website link (§ 2.1). */
  readonly pageLink: string;
  readonly pageLinkEdited: boolean;
  // 3 Box kind
  readonly qStream: number;
  readonly tStream: number;
  /** The creator-fee cap (add-on 5, F74 U2): a fixed amount per 30 days in Q raw units, 0n = off; where fees above it go. */
  readonly capPerEpoch: bigint;
  readonly capExcess: number;
  // 4 Raise: the target is the version's (F74 U5, `raiseOf`); only the deadline is chosen.
  readonly deadlineDays: number;
  // 5 Opening
  readonly open: OpenChoice;
  /** The creator's ETH in before the open (creatorBuy), as typed: "", "0.05". */
  readonly firstIn: string;
  /** The rights confirmation (site record, never in the spec): one state, shown on Opening and on the Overview. */
  readonly rights: boolean;
  // Overview, chain sources: the creator's address pasted when no wallet is connected.
  readonly ownerText: string;
}

export const DEFAULT_TICKET_LINE = 'Opens into one item once its number is drawn.';
export const DEFAULT_HIDDEN_LINE = 'This item is not revealed yet.';

/** The open preset a new form starts on: Now (founder 2026-10-04). */
export const DEFAULT_OPEN_PRESET = OPEN_PRESETS[0] as (typeof OPEN_PRESETS)[number];

/** The defaults (§ 2.1, P): ETH, 30 days, Burn KITE on both sides, no cap, royalty off, opens Now, open art (the raise is the version's). */
export const DEFAULT_FORM: CreateForm = Object.freeze({
  qIndex: 0,
  name: '',
  ticker: '',
  description: '',
  links: NO_LINKS,
  contents: null,
  separateCollection: false,
  collectionName: '',
  collectionSymbol: '',
  artMode: 'open',
  specials: Object.freeze([]),
  ticketLine: DEFAULT_TICKET_LINE,
  hiddenLine: DEFAULT_HIDDEN_LINE,
  hiddenSvg: DEFAULT_HIDDEN_SVG,
  royaltyBps: 0,
  royaltyTo: 'fees',
  storeAll: false,
  pageLink: '',
  pageLinkEdited: false,
  qStream: QStream.BUYBACK_BURN_T,
  tStream: TStream.BURN_T,
  capPerEpoch: 0n,
  capExcess: CapExcess.BURN,
  deadlineDays: 30,
  open: Object.freeze({ kind: 'preset', id: DEFAULT_OPEN_PRESET.id }),
  firstIn: '',
  rights: false,
  ownerText: '',
});

/** Which form fields each step owns (the probe spec resets later steps to their defaults). */
export const STEP_FIELDS: Readonly<Record<Exclude<StepId, 'overview'>, readonly (keyof CreateForm)[]>> = Object.freeze({
  basics: ['qIndex', 'name', 'ticker', 'description', 'links'],
  contents: ['contents', 'separateCollection', 'collectionName', 'collectionSymbol', 'artMode', 'specials', 'ticketLine', 'hiddenLine', 'hiddenSvg', 'royaltyBps', 'royaltyTo', 'storeAll', 'pageLink', 'pageLinkEdited'],
  kind: ['qStream', 'tStream', 'capPerEpoch', 'capExcess'],
  raise: ['deadlineDays'],
  launch: ['open', 'firstIn', 'rights'],
});

/** One item of the art: its number, the sha256 of its file as uploaded, its traits and its file size. */
export interface ArtItem {
  readonly id: number;
  readonly imageSha256: Hex;
  readonly traits: readonly Attribute[];
  readonly bytes: number;
  /**
   * R74-ART: the sha256 of the item's 3D model (`<id>.glb`, a self-contained GLB) as uploaded, and its size. Absent: no
   * model, so its leaf and reveal list commit bytes32(0), as every item did before (a 2D collection is unchanged).
   */
  readonly modelSha256?: Hex;
  readonly modelBytes?: number;
}

/** The model hash an item commits (leaf and reveal list): its GLB's sha256, or bytes32(0) without one. */
export const modelOf = (item: Pick<ArtItem, 'modelSha256'>): Hex => item.modelSha256 ?? ZERO32;

/** Whether the art carries 3D models (art-files `readArt` takes a model for every item or for none). */
export const artHasModels = (art: Pick<ArtState, 'items'> | null): boolean => art !== null && art.items.some((item) => item.modelSha256 !== undefined);

/** The art as read (ids 1..N), one salt per item (32 CSPRNG bytes, chosen when the art was read), a few thumbnails. */
export interface ArtState {
  readonly items: readonly ArtItem[];
  readonly salts: readonly Hex[];
  readonly thumbs: readonly string[];
  readonly totalBytes: number;
  /** Problems found while reading, each naming the file or item id; the art is unusable while any remain. */
  readonly problems: readonly string[];
  /**
   * SH-AI-PLAN: the art came with a plan (art-plan.ts), so this page dealt the numbers at random; no file name chose
   * them. Absent: the pictures were named 1..N.
   */
  readonly planned?: boolean;
}

/**
 * A processed picture (the logo, the banner, a teaser): sha256 of the stored bytes, a small data-URL thumbnail, the
 * stored size and the stored bytes themselves (base64). The browser's re-encoding cannot be repeated byte for byte, so
 * the bytes the spec commits to are kept and go into the downloaded BoxSpec.
 */
export interface CoverState {
  readonly sha256: Hex;
  readonly url: string | null;
  readonly bytes: number;
  readonly data: string;
}

export type PictureState = CoverState;

/** The collection page's pictures (add-on 6, F71 (2)): a banner and up to 4 teasers, processed like the logo. */
export interface PageState {
  readonly banner: PictureState | null;
  readonly teasers: readonly PictureState[];
}

export const EMPTY_PAGE: PageState = Object.freeze({ banner: null, teasers: Object.freeze([]) });

/** What the art commits to: the trait table's types and values, each item's packed traits, the root and the list id. */
export interface ArtCommitment {
  readonly traitTypes: MetadataTable['traitTypes'];
  readonly packed: readonly bigint[];
  readonly revealRoot: Hex;
  /** sha256 of the canonical reveal list (open art publishes it; P, S13 fixes the stored id). */
  readonly revealListId: Hex;
  readonly n: number;
}

/** How the table orders its types and values: by first appearance (items in id order), or sorted (SH-AI-PLAN). */
export type TableOrder = 'first-seen' | 'sorted';
const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Trait types, and each one's values, in code-point order: hidden art's table (also Load settings' re-sort of an older file). */
export const sortedTraitTypes = (types: readonly { readonly name: string; readonly values: readonly string[] }[]): { name: string; values: string[] }[] =>
  types.map((type) => ({ name: type.name, values: [...type.values].sort(byCodePoint) })).sort((a, b) => byCodePoint(a.name, b.name));

/**
 * The trait table's types and values, and each item's indices. 'first-seen' lists them in order of first appearance,
 * items in id order: open art's table, as it always was. 'sorted' lists both in code-point order, so the table (public
 * at creation) says nothing about which id holds which traits: every hidden art's table (`commitArt`), its numbers
 * being secret until each reveal.
 */
export function traitTable(items: readonly ArtItem[], order: TableOrder = 'first-seen'): { traitTypes: { name: string; values: string[] }[]; packed: bigint[] } {
  let types: { name: string; values: string[] }[] = [];
  let index = new Map<string, number>();
  for (const item of items) {
    for (const trait of item.traits) {
      let t = index.get(trait.trait);
      if (t === undefined) {
        t = types.length;
        index.set(trait.trait, t);
        types.push({ name: trait.trait, values: [] });
      }
      const type = types[t] as { values: string[] };
      if (!type.values.includes(trait.value)) type.values.push(trait.value);
    }
  }
  if (order === 'sorted') {
    types = sortedTraitTypes(types);
    index = new Map(types.map((type, t) => [type.name, t]));
  }
  const packed = items.map((item) => {
    const indices = types.map(() => 0);
    for (const trait of item.traits) {
      const t = index.get(trait.trait) as number;
      indices[t] = (types[t]?.values.indexOf(trait.value) ?? -1) + 1;
    }
    // More than 16 types or 255 values is refused when the art is read; packTraits throws if one slips through.
    return types.length <= 16 && indices.every((v) => v <= 255) ? packTraits(indices) : 0n;
  });
  return { traitTypes: types, packed };
}

/**
 * The commitment format a saved reveal file is bound to (SH-AI-PLAN fix round 2): 2 since fix round 1 sorted hidden
 * art's table. Format 1 (first-appearance tables) stored only a bare "saved", which is never trusted again.
 */
export const COMMITMENT_FORMAT = 2;

/** "The reveal file was saved", for exactly one commitment: its format and its reveal root. */
export interface RevealAck {
  readonly format: number;
  readonly root: Hex;
}

/** The acknowledgement for a reveal file built from `commitment` (create-model `revealFile`). */
export const revealAckFor = (commitment: ArtCommitment): RevealAck => ({ format: COMMITMENT_FORMAT, root: commitment.revealRoot });

/**
 * Whether the reveal file saved (`ack`) is this commitment's: the same format and the same root. Any other root (the
 * table's order, new salts, other art) needs a new file before Create; a draft with no binding has none saved.
 */
export function revealSavedFor(ack: RevealAck | null, commitment: ArtCommitment | null): boolean {
  return ack !== null && commitment !== null && ack.format === COMMITMENT_FORMAT && ack.root.toLowerCase() === commitment.revealRoot.toLowerCase();
}

/**
 * The canonical reveal list: what proves each item against the root (published for open art, kept for hidden). All six
 * leaf fields; an item's model hash is its GLB's (R74-ART), bytes32(0) without one, as are the avatars.
 */
export function revealList(art: ArtState, packed: readonly bigint[]) {
  return {
    format: 'squarehole.box-reveal-list/1',
    n: String(art.items.length),
    items: art.items.map((item, i) => ({
      id: String(item.id),
      traitsPacked: String(packed[i] ?? 0n),
      imageSha256: item.imageSha256,
      avatarSha256: ZERO32,
      modelSha256: modelOf(item),
      salt: art.salts[i] ?? ZERO32,
    })),
  };
}

/**
 * The commitment of usable art (ids 1..N, a salt each, no problems), or null. The art mode sets the table's order
 * (SH-AI-PLAN fix round 1, on every path): hidden art's table is sorted, so the table, public at creation, never tells
 * which id holds what, whether the numbers came from file names or a plan; open art's keeps its first-appearance order,
 * byte for byte as before. Any other mode is refused, so no caller falls back to an unsorted hidden table. R74-ART: each
 * leaf commits its item's model hash (`modelOf`), as the reveal list does; art without models commits zero, as before.
 */
export function commitArt(art: ArtState | null, artMode: CreateForm['artMode']): ArtCommitment | null {
  if (artMode !== 'open' && artMode !== 'hidden') throw new TypeError('commitArt: the art mode must be open or hidden');
  if (!art || art.problems.length > 0 || art.items.length === 0 || art.salts.length !== art.items.length) return null;
  const n = art.items.length;
  if (art.items.some((item, i) => item.id !== i + 1)) return null;
  const { traitTypes, packed } = traitTable(art.items, artMode === 'hidden' ? 'sorted' : 'first-seen');
  if (traitTypes.length > 16 || traitTypes.some((type) => type.values.length > 255)) return null;
  const leaves = art.items.map((item, i) =>
    boxLeaf({ id: item.id, traitsPacked: packed[i] ?? 0n, imageSha256: item.imageSha256, avatarSha256: ZERO32, modelSha256: modelOf(item), salt: art.salts[i] ?? ZERO32 }, n),
  );
  const root = buildBoxTree(leaves, n).root;
  const listId = sha256Hex(new TextEncoder().encode(canonicalJson(revealList(art, packed))));
  return { traitTypes, packed, revealRoot: root, revealListId: listId, n };
}

/** The metadata table bytes (description and trait types), or null when they break the table's rules. */
export function metadataTableHex(description: string, traitTypes: MetadataTable['traitTypes']): Hex | null {
  try {
    const bytes = encodeBoxMetadataTable({ description, traitTypes });
    return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return null;
  }
}

/** A decimal ETH amount typed by the creator as raw wei (bigint), or null when it is not a plain decimal. */
export function parseEthText(text: string, decimals = 18): bigint | null {
  const trimmed = text.trim();
  if (trimmed === '') return 0n;
  const normal = trimmed.startsWith('.') ? `0${trimmed}` : trimmed;
  if (!isDecimalAmount(normal)) return null;
  const { units, scale } = parseDecimal(normal);
  if (scale > decimals) return null;
  return units * 10n ** BigInt(decimals - scale);
}

const UTC_MINUTE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
/** The largest uint32: openAt's ABI type. */
const MAX_UINT32 = 0xffff_ffff;

/** A picked time ("YYYY-MM-DDTHH:MM", UTC) in ms, or NaN when it is not a date and time that exists. */
export function pickedUtcMs(utc: string): number {
  const m = UTC_MINUTE.exec(utc.trim());
  if (!m) return Number.NaN;
  const [, y, mo, d, h, mi, se] = m.map(Number) as [number, number, number, number, number, number, number];
  const ms = Date.UTC(y, mo - 1, d, h, mi, Number.isNaN(se) ? 0 : se);
  const back = new Date(ms);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d && back.getUTCHours() === h && back.getUTCMinutes() === mi ? ms : Number.NaN;
}

/** The time field's value for `ms` ("YYYY-MM-DDTHH:MM", UTC). */
export function utcFieldValue(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}

/** The next whole UTC minute at or after `seconds` (Unix seconds). */
const ceilMinute = (seconds: number): number => Math.ceil(seconds / 60) * 60;

/**
 * The spec's openAt (Unix seconds, UTC): 0 for Now; a later preset as the next whole minute at least that far from
 * `nowMs`; a picked time as given, at least 1 (an unreadable time or one before 1970 is refused by validate(), never
 * read as Now) and at most uint32's maximum, so a far-off year still encodes (the page refuses it first).
 */
export function openAtOf(open: OpenChoice, nowMs: number): number {
  if (open.kind === 'preset') {
    const preset = OPEN_PRESETS.find((entry) => entry.id === open.id) ?? DEFAULT_OPEN_PRESET;
    return preset.seconds === 0 ? 0 : ceilMinute(Math.floor(nowMs / 1000) + preset.seconds);
  }
  const ms = pickedUtcMs(open.utc);
  if (!Number.isFinite(ms)) return 1;
  return Math.min(Math.max(1, Math.floor(ms / 1000)), MAX_UINT32);
}

/** How far a picked time is from `nowMs`, in seconds (NaN when unreadable); a preset's own distance. */
export function openAheadSeconds(open: OpenChoice, nowMs: number): number {
  if (open.kind === 'preset') return (OPEN_PRESETS.find((entry) => entry.id === open.id) ?? DEFAULT_OPEN_PRESET).seconds;
  return Math.floor((pickedUtcMs(open.utc) - nowMs) / 1000);
}

/** The spec's creatorBuy: the typed ETH as wei (0 when unreadable), held inside uint256 so a huge number still encodes. */
export function specCreatorBuy(text: string): bigint {
  const wei = parseEthText(text) ?? 0n;
  return wei > MAX_UINT256 ? MAX_UINT256 : wei;
}

/** The placeholders add-on's name and ticker from the collection's (within 32 and 11 bytes). */
export function ticketNames(name: string, ticker: string): { name: string; symbol: string } {
  return { name: `${name.slice(0, 25).trim()} ticket`.trim(), symbol: `${ticker.slice(0, 9)}-T` };
}

/** The whole number a special-series row names, or null (typed text, never a JS number for amounts: this is a count). */
export function parseCount(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[1-9][0-9]{0,8}$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}

/** Why a pasted owner cannot be used. */
export type OwnerProblem = 'not-an-address' | 'checksum';

/**
 * A pasted owner: 0x and 40 hex digits; in mixed case it must be its own EIP-55 checksum, so a one-letter typo is
 * caught rather than "corrected". Empty text: no address, no problem.
 */
export function readPastedOwner(text: string): { readonly address: Address | null; readonly problem: OwnerProblem | null } {
  const trimmed = text.trim();
  if (trimmed === '') return { address: null, problem: null };
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return { address: null, problem: 'not-an-address' };
  const checksummed = getAddress(trimmed.toLowerCase()) as Address;
  const hex = trimmed.slice(2);
  const mixed = hex !== hex.toLowerCase() && hex !== hex.toUpperCase();
  return mixed && checksummed !== trimmed ? { address: null, problem: 'checksum' } : { address: checksummed, problem: null };
}

/**
 * The spec's owner (also the fee and royalty recipient). Demo: the connected persona. Chain sources: the pasted text
 * when there is any (never silently the wallet instead: the file would name a different address than the one on
 * screen), else the connected account. One spelling: EIP-55 of the lower-case address (a Demo persona's mixed case
 * is not a checksum).
 */
export function chooseOwner(demo: boolean, connected: Address | null, ownerText: string): { readonly owner: Address | null; readonly problem: OwnerProblem | null } {
  const fromWallet = connected ? (getAddress(connected.toLowerCase()) as Address) : null;
  if (demo || ownerText.trim() === '') return { owner: fromWallet, problem: null };
  const pasted = readPastedOwner(ownerText);
  return { owner: pasted.address, problem: pasted.problem };
}

/** The collection page's link: as typed once edited, else the Website link when it passes the URL rule (§ 2.1, 603). */
export function effectivePageLink(form: Pick<CreateForm, 'pageLink' | 'pageLinkEdited' | 'links'>): string {
  if (form.pageLinkEdited) return form.pageLink.trim();
  const website = form.links.website.trim();
  return website !== '' && pageLinkOk(website) ? website : '';
}

export interface BuildInput {
  readonly form: CreateForm;
  readonly art: ArtState | null;
  readonly commitment: ArtCommitment | null;
  /** The logo (field 23): the token's and the card's picture. */
  readonly cover: CoverState | null;
  /** A new collection's own cover (field 28, F74 U3): its contractURI image, a separate upload; none for "Token". */
  readonly collectionCover?: CoverState | null;
  /** The collection page's banner and teasers (add-on 6). */
  readonly page?: PageState;
  /** The creator's address (owner, payouts): connected or pasted; null leaves the zero address (validate names it). */
  readonly owner: Address | null;
  readonly nowMs: number;
}

/** The collection's own name and ticker: the token's, unless More gives it its own. */
export const collectionNames = (form: CreateForm): { name: string; symbol: string } =>
  form.separateCollection ? { name: form.collectionName, symbol: form.collectionSymbol } : { name: form.name, symbol: form.ticker };

/**
 * The spec these choices build. "Token" zeroes every collection field (§ 3.1: 5, 6, 8, 19-22, 24, 25) and
 * carries no collection add-on; a new collection builds as v1 did plus the cap and the collection page. Missing pieces
 * are left at zero (no logo, no art, no owner) so that validate() names them; text that is not a plain number leaves
 * its amount at 0 and is reported by the form's own checks. Always encodable: every number stays inside its ABI type,
 * so the cost, the hash and the preview never throw.
 */
export function buildSpec({ form, art, commitment, cover, collectionCover = null, page = EMPTY_PAGE, owner, nowMs }: BuildInput): BoxSpecV1 {
  const q = Q_ASSETS[form.qIndex] ?? Q_ASSETS[0];
  const token = form.contents === 'token';
  const hidden = form.artMode === 'hidden';
  const ownerAddress = owner ?? ZERO_ADDRESS;
  const creator = creatorOnEitherSide(form.qStream, form.tStream);
  // One payout wallet (F72 (3), core v1): royalties to "You" are paid to the fee payout address.
  const royaltyToCreator = !token && form.royaltyBps !== 0 && form.royaltyTo === 'creator';
  const collection = collectionNames(form);
  const addOns: AddOnV1[] = [];
  if (!token && hidden) {
    const ticket = ticketNames(collection.name, collection.symbol);
    addOns.push({
      id: AddOnId.Placeholders,
      params: encodePlaceholdersParams({
        placeholderName: ticket.name,
        placeholderSymbol: ticket.symbol,
        placeholderDescription: form.ticketLine,
        hiddenDescription: form.hiddenLine,
        hiddenSvg: form.hiddenSvg,
      }),
    });
  }
  if (!token) {
    for (const row of form.specials) {
      addOns.push({ id: AddOnId.EditionSpecials, params: encodeEditionSpecialsParams({ label: row.label, count: Math.min(parseCount(row.count) ?? 0, 0xffff_ffff) }) });
    }
    if (form.royaltyBps !== 0) {
      const destination = ROYALTY_DESTINATION[form.royaltyTo];
      addOns.push({
        id: AddOnId.Royalties,
        params: encodeRoyaltiesParams({ bps: form.royaltyBps, destination }),
      });
    }
  }
  // The cap only while a side pays the creator (§ 2.2: switching both sides away drops it; one spec, one meaning).
  if (creator && form.capPerEpoch !== 0n && capOffered(form.qIndex)) addOns.push({ id: AddOnId.CreatorFeeCap, params: encodeCreatorFeeCapParams({ capPerEpoch: form.capPerEpoch, excess: form.capExcess }) });
  const link = effectivePageLink(form);
  if (!token && (page.banner !== null || page.teasers.length > 0 || link !== '')) {
    addOns.push({
      id: AddOnId.CollectionMetadata,
      params: encodeCollectionMetadataParams({ bannerSha256: page.banner?.sha256 ?? ZERO32, teaserSha256s: page.teasers.map((teaser) => teaser.sha256), externalLink: link }),
    });
  }
  const table = token ? '0x' : (commitment ? metadataTableHex(form.description, commitment.traitTypes) : metadataTableHex(form.description, [])) ?? '0x';
  return {
    version: VERSION,
    boxType: token ? BoxType.TOKEN_ONLY : BoxType.NEW_COLLECTION,
    tokenName: form.name,
    tokenSymbol: form.ticker,
    collectionName: token ? '' : collection.name,
    collectionSymbol: token ? '' : collection.symbol,
    description: form.description,
    n: token ? 0 : (commitment?.n ?? art?.items.length ?? 0),
    firstId: FIRST_ID,
    q: q?.token ?? ZERO_ADDRESS,
    raise: raiseOf(form.qIndex),
    layout: Layout.CURVE_V1,
    gradLayout: GradLayout.ASK_FULL_BID_SENTINEL,
    launchFormat: LaunchFormat.CURVE,
    openAt: openAtOf(form.open, nowMs),
    deadlineDays: form.deadlineDays,
    qStream: form.qStream,
    tStream: form.tStream,
    artMode: token ? 0 : hidden ? ArtMode.HIDDEN : ArtMode.OPEN,
    revealRoot: token ? ZERO32 : (commitment?.revealRoot ?? ZERO32),
    metadataTable: table,
    generatorHash: ZERO32,
    coverSha256: cover?.sha256 ?? ZERO32,
    revealListId: !token && !hidden && commitment ? commitment.revealListId : ZERO32,
    marketplaceOwner: token ? ZERO_ADDRESS : ownerAddress,
    creatorFeeRecipient: creator || royaltyToCreator ? ownerAddress : ZERO_ADDRESS,
    creatorBuy: specCreatorBuy(form.firstIn),
    // F74 U3: the collection's own cover, its own upload (no "same as logo"); zero without a collection.
    collectionCoverSha256: token ? ZERO32 : (collectionCover?.sha256 ?? ZERO32),
    addOns,
  };
}

/** The form with every field after `step` back at its default: the probe a step's Next checks. */
export function probeForm(form: CreateForm, step: StepId): CreateForm {
  if (step === 'overview') return form;
  const keep = new Set<keyof CreateForm>();
  for (const entry of STEPS) {
    if (entry.id === 'overview') break;
    for (const field of STEP_FIELDS[entry.id]) keep.add(field);
    if (entry.id === step) break;
  }
  const next: Record<string, unknown> = { ...DEFAULT_FORM };
  for (const field of keep) next[field] = form[field];
  next.ownerText = form.ownerText;
  return next as unknown as CreateForm;
}

/** Bytes of the encoded spec (the box data a creation stores). */
export const encodedBytes = (spec: BoxSpecV1): bigint => BigInt((encodeBoxSpecV1(spec).length - 2) / 2);

/** Cost in wei: gas for `createBox` at `gasPriceWei`, the bootstrap (burned) and the creator's ETH in. ETH only. */
export function costEstimate(spec: BoxSpecV1, gasPriceWei: bigint = DEMO_GAS_PRICE_WEI): { gas: bigint; totalWei: bigint } {
  const gas = CREATE_GAS_BASE + CREATE_GAS_PER_BYTE * encodedBytes(spec);
  return { gas, totalWei: gas * gasPriceWei + BOOTSTRAP_ETH + spec.creatorBuy };
}

/** The spec in wire form with bigints as decimal strings (JSON has no bigint). */
export function specToJson(spec: BoxSpecV1): Record<string, unknown> {
  return Object.fromEntries(Object.entries(spec).map(([key, value]) => [key, typeof value === 'bigint' ? value.toString() : value]));
}

/**
 * The collection's contractURI JSON (ERC-7572; F71 (2) "the flow produces it now", § 4.3): name, symbol, description,
 * the collection cover (field 28, F74 U3) as `ipfs://` + its raw CIDv1, and banner_image and external_link from add-on 6 when set. Null for a
 * token-only box (no collection). Teasers are not in it: ERC-7572 has no field for them.
 */
export function contractUri(spec: BoxSpecV1): Record<string, string> | null {
  if (spec.boxType === BoxType.TOKEN_ONLY) return null;
  const body: Record<string, string> = { name: spec.collectionName, symbol: spec.collectionSymbol, description: spec.description, image: `ipfs://${rawCidV1(spec.collectionCoverSha256)}` };
  const addOn = spec.addOns.find((entry) => entry.id === AddOnId.CollectionMetadata);
  if (addOn) {
    try {
      const params = decodeCollectionMetadataParams(addOn.params);
      if (params.bannerSha256 !== ZERO32) body.banner_image = `ipfs://${rawCidV1(params.bannerSha256)}`;
      if (params.externalLink !== '') body.external_link = params.externalLink;
    } catch {
      // A malformed add-on is named by validate(); the JSON shows what it can.
    }
  }
  return body;
}

/** The rights record the Create (or Download) press makes (§ 4.2): kept with the site record, never in the spec. */
export function rightsRecord(hash: Hex, creator: Address, nowMs: number): RightsRecord {
  return Object.freeze({ specHash: hash, creator, statement: RIGHTS_STATEMENT_VERSION, confirmedAt: new Date(nowMs).toISOString() });
}

/** What the spec commits to besides itself, and the site record, so a file kept for later can still be used. */
export interface SpecFileParts {
  /** When the spec was built: a picked open time is stored as a delay in blocks counted from this moment. */
  readonly builtAtMs: number;
  /** The processed logo: `coverSha256` is the sha256 of exactly these bytes. */
  readonly cover: CoverState | null;
  /** The processed collection cover: `collectionCoverSha256` is the sha256 of exactly these bytes (a new collection only). */
  readonly collectionCover?: CoverState | null;
  /** The network the spec was checked for (F74 U1): `box-spec:check` checks the file for it unless `--network` is given. */
  readonly network?: Network;
  /** The collection page's banner and teasers: their hashes are in add-on 6. */
  readonly page?: PageState;
  /** Open art: the canonical reveal list, published at creation; `revealListId` is the sha256 of its canonical JSON. */
  readonly revealList: ReturnType<typeof revealList> | null;
  /** The site record (§ 4): links, the rights confirmation, the storage choice. */
  readonly links?: SiteLinks;
  readonly rights?: RightsRecord | null;
  readonly storeAll?: boolean;
}

const picture = (state: PictureState) => ({ sha256: state.sha256, base64: state.data });

/**
 * The "Download BoxSpec" file (§ 4.3): the version context and the network it was checked for, the spec in wire form,
 * its ABI encoding and its hash, what the spec commits to (the logo's, the collection cover's, banner's and teasers'
 * bytes, and for open art the public reveal list), the collection's contractURI JSON and the site record. Hidden art's
 * reveal list stays in the separate reveal file: its salts are secret until the reveal.
 */
export function boxSpecFile(spec: BoxSpecV1, parts: SpecFileParts): { readonly name: string; readonly text: string; readonly hash: Hex } {
  const hash = specHash(spec);
  const page = parts.page ?? EMPTY_PAGE;
  const token = spec.boxType === BoxType.TOKEN_ONLY;
  const body = {
    format: 'squarehole.boxspec/1',
    context: 'v2',
    network: parts.network ?? STRICTEST_NETWORK,
    specHash: hash,
    encoded: encodeBoxSpecV1(spec),
    spec: specToJson(spec),
    builtAt: new Date(parts.builtAtMs).toISOString(),
    cover: parts.cover ? picture(parts.cover) : null,
    collectionCover: !token && parts.collectionCover ? picture(parts.collectionCover) : null,
    banner: !token && page.banner ? picture(page.banner) : null,
    teasers: token ? [] : page.teasers.map(picture),
    revealList: parts.revealList,
    contractURI: contractUri(spec),
    site: {
      links: cleanLinks(parts.links ?? NO_LINKS),
      rights: parts.rights ?? null,
      storage: !token && parts.storeAll && spec.artMode === ArtMode.OPEN ? 'all-art' : 'pictures',
    },
  };
  const slug = spec.tokenSymbol.replace(/[^A-Za-z0-9]+/g, '').toLowerCase() || 'box';
  return { name: `${slug}-boxspec-v1.json`, text: `${JSON.stringify(body, null, 2)}\n`, hash };
}

/** The hidden-art reveal file: every item's number, traits, art hash and salt. Items reveal only with it. */
export function revealFile(spec: BoxSpecV1, art: ArtState, commitment: ArtCommitment): { readonly name: string; readonly text: string } {
  const body = { ...revealList(art, commitment.packed), revealRoot: commitment.revealRoot, collection: spec.collectionName, traitTypes: commitment.traitTypes };
  const slug = spec.collectionSymbol.replace(/[^A-Za-z0-9]+/g, '').toLowerCase() || 'box';
  return { name: `${slug}-reveal-file.json`, text: `${JSON.stringify(body, null, 2)}\n` };
}

/**
 * One path from a BoxSpec to a box (launch pipeline v1 § 3.9; box creation flow § 6): `recordFromSpec` builds the
 * `BoxRecord` the feed, the box page and the wallet box read, from the spec's own fields only. The creation page's Demo
 * boxes go through it today, the registry's `BoxSpec` events will tomorrow, so a factory box needs no per-box code.
 *
 * Amounts stay raw bigint (Q and T); text comes from the spec's validated strings (printable ASCII, no quotes).
 */
import {
  AddOnId,
  ArtMode,
  BoxType,
  CapExcess,
  RoyaltyDestination,
  boxCurve,
  curveBuyOut,
  decodeCollectionMetadataParams,
  decodeCreatorFeeCapParams,
  decodeEditionSpecialsParams,
  decodePlaceholdersParams,
  decodeRoyaltiesParams,
  issuanceBps,
  tIsCurrency0,
  CONTEXT_V2,
  FEE_SHARE_DENOMINATOR,
  FEE_SHARE_DEPTH,
  FEE_SHARE_FIT,
  type BoxSpecV1,
} from '@squarehole/box-spec';
import { formatTokenAmount, type Address } from '@squarehole/domain';
import { TESTNET } from '@squarehole/chain/write/wallet';
import { hexToBytes } from 'viem';
import { approxDuration } from './box-figure';
import { formatBoxId } from './box-id';
import { NO_LINKS, type BoxRecord, type RoyaltyTo, type SiteLinks, type SpecBoxFacts } from './box-model';
import { qBurns, sideFacts } from './fee-kinds';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

/**
 * Seconds per block on the build's test network (Ethereum: 12; BNB Chain testnet: 0.45, SH-258): Now (openAt 0) opens in
 * the block after the creation block, about this much later.
 */
export const BLOCK_SECONDS: number = TESTNET.blockTimeMs / 1000;

/**
 * When a spec box opens (ms), for its "Opens in" figure: its openAt when that is after the creation, else the next block
 * (about 12 s after the creation; Now, or a time the creation reached). `createdAtMs` null: counted from `nowMs`.
 */
export function specOpensAtMs(openAt: number, createdAtMs: number | null, nowMs: number): number {
  const created = createdAtMs ?? nowMs;
  return openAt * 1000 > created ? openAt * 1000 : created + BLOCK_SECONDS * 1000;
}

const ROYALTY_TO: ReadonlyMap<number, RoyaltyTo> = new Map([
  [RoyaltyDestination.FEE_HANDLING, 'fees'],
  [RoyaltyDestination.CREATOR, 'creator'],
  [RoyaltyDestination.POOL_DEPTH, 'pool'],
]);

/** "1", "4.2", "0.05": a raw ETH amount as a short decimal (no grouping), truncated to 4 decimals. */
export function ethText(raw: bigint, digits = 4): string {
  return formatTokenAmount(raw, 18, { maxFractionDigits: digits }).replace(/,/g, '');
}

/** "4.206980085": a raw ETH amount with every digit it has (the raise is stated exactly, as box 0's; F74 U5). */
export const ethExact = (raw: bigint): string => ethText(raw, 18);

/** "13%" or "13.2%" from basis points (truncated, never rounded up). */
export function bpsText(bps: bigint): string {
  const whole = bps / 100n;
  const tenth = (bps % 100n) / 10n;
  return whole >= 10n || tenth === 0n ? `${whole}%` : `${whole}.${tenth}%`;
}

export interface MetadataTableView {
  readonly description: string;
  readonly traitTypes: readonly { readonly name: string; readonly values: readonly string[] }[];
}

/** Reads a metadata table v1 (packages/artwork `encodeMetadataTable`); null when the bytes are not one. */
export function decodeMetadataTable(hex: `0x${string}`): MetadataTableView | null {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(hex);
  } catch {
    return null;
  }
  const ascii = new TextDecoder('ascii');
  let at = 0;
  const take = (length: number): Uint8Array | null => {
    if (at + length > bytes.length) return null;
    const out = bytes.subarray(at, at + length);
    at += length;
    return out;
  };
  const byte = (): number | null => (at < bytes.length ? (bytes[at++] as number) : null);
  if (byte() !== 1) return null;
  const hi = byte();
  const lo = byte();
  if (hi === null || lo === null) return null;
  const description = take((hi << 8) | lo);
  const typeCount = byte();
  if (description === null || typeCount === null || typeCount > 16) return null;
  const traitTypes: { name: string; values: string[] }[] = [];
  for (let t = 0; t < typeCount; t++) {
    const nameLength = byte();
    const name = nameLength === null ? null : take(nameLength);
    const valueCount = byte();
    if (name === null || valueCount === null) return null;
    const values: string[] = [];
    for (let v = 0; v < valueCount; v++) {
      const length = byte();
      const value = length === null ? null : take(length);
      if (value === null) return null;
      values.push(ascii.decode(value));
    }
    traitTypes.push({ name: ascii.decode(name), values });
  }
  return at === bytes.length ? { description: ascii.decode(description), traitTypes } : null;
}

function royaltyOf(spec: BoxSpecV1): { bps: number; to: RoyaltyTo | null } {
  const addOn = spec.addOns.find((entry) => entry.id === AddOnId.Royalties);
  if (!addOn) return { bps: 0, to: null };
  try {
    const params = decodeRoyaltiesParams(addOn.params);
    return { bps: params.bps, to: params.bps === 0 ? null : (ROYALTY_TO.get(params.destination) ?? null) };
  } catch {
    return { bps: 0, to: null };
  }
}

/** The placeholders add-on's hidden picture as a data URL for <img> (never inlined into the page), or null. */
function sealedUrlOf(spec: BoxSpecV1): string | null {
  const addOn = spec.addOns.find((entry) => entry.id === AddOnId.Placeholders);
  if (!addOn) return null;
  try {
    const svg = decodePlaceholdersParams(addOn.params).hiddenSvg;
    return `data:image/svg+xml;base64,${btoa(svg)}`;
  } catch {
    return null;
  }
}

function specialsOf(spec: BoxSpecV1): { label: string; count: bigint }[] {
  return spec.addOns.flatMap((entry) => {
    if (entry.id !== AddOnId.EditionSpecials) return [];
    try {
      const params = decodeEditionSpecialsParams(entry.params);
      return [{ label: params.label, count: BigInt(params.count) }];
    } catch {
      return [];
    }
  });
}

/** The T the creator buy comes to, from the spec's own raise and pair (null when the layout cannot be built). */
function firstTokens(spec: BoxSpecV1, token: Address): { raw: bigint; bps: bigint } | null {
  if (spec.creatorBuy === 0n) return { raw: 0n, bps: 0n };
  try {
    const raw = curveBuyOut(boxCurve(spec.raise, tIsCurrency0(token, spec.q)), spec.creatorBuy);
    return { raw, bps: issuanceBps(raw) };
  } catch {
    return null;
  }
}

const CAP_EXCESS_TO: ReadonlyMap<number, 'burn' | 'pool' | 'holders'> = new Map([
  [CapExcess.BURN, 'burn'],
  [CapExcess.POOL_DEPTH, 'pool'],
  [CapExcess.HOLDERS, 'holders'],
]);

/** The creator-fee cap (add-on 5, F74 U2): a fixed amount per 30 days in Q raw units and where the excess goes; 0n = none. */
function capOf(spec: BoxSpecV1): { raw: bigint; excess: 'burn' | 'pool' | 'holders' | null } {
  const addOn = spec.addOns.find((entry) => entry.id === AddOnId.CreatorFeeCap);
  if (!addOn) return { raw: 0n, excess: null };
  try {
    const params = decodeCreatorFeeCapParams(addOn.params);
    return { raw: params.capPerEpoch, excess: CAP_EXCESS_TO.get(params.excess) ?? null };
  } catch {
    return { raw: 0n, excess: null };
  }
}

/** The collection page (add-on 6): how many teasers the spec names, and its external link; none without the add-on. */
function pageOf(spec: BoxSpecV1): { teasers: number; link: string | null; banner: boolean } {
  const addOn = spec.addOns.find((entry) => entry.id === AddOnId.CollectionMetadata);
  if (!addOn) return { teasers: 0, link: null, banner: false };
  try {
    const params = decodeCollectionMetadataParams(addOn.params);
    return { teasers: params.teaserSha256s.length, link: params.externalLink === '' ? null : params.externalLink, banner: !/^0x0{64}$/.test(params.bannerSha256) };
  } catch {
    return { teasers: 0, link: null, banner: false };
  }
}

/**
 * The fixed part of the fee set-up (About's Set-up row): the shares no creator picks. Each side's 10/15, the cap and the
 * royalty have their own rows above it, so the sentence never repeats them.
 */
export function setupLine(): string {
  return `Of each 1% fee: ${FEE_SHARE_FIT}/${FEE_SHARE_DENOMINATOR} burns FIT · ${FEE_SHARE_DEPTH}/${FEE_SHARE_DENOMINATOR} into this box’s pool`;
}

/** The first sentence of the description (up to 140 characters), or null. */
function firstSentence(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const end = trimmed.search(/[.!?](\s|$)/);
  const sentence = end === -1 ? trimmed : trimmed.slice(0, end + 1);
  return sentence.length > 140 ? `${sentence.slice(0, 139)}…` : sentence;
}

export interface SpecRecordMeta {
  readonly chainId: number;
  readonly networkLabel: string;
  /** The box's token address (Demo: `demoTokenFor`). */
  readonly token: Address;
  readonly demo: boolean;
  /** Feed order for "New": higher is newer. */
  readonly order: number;
  readonly coverUrl: string | null;
  /** A new collection's own cover (field 28) as a data URL, when this page has it. */
  readonly collectionCoverUrl?: string | null;
  readonly thumbs: readonly string[];
  /** When the box was created (ms since the epoch), for the open countdown; null when not known. */
  readonly createdAtMs: number | null;
  readonly nowMs: number;
  /** The site record (not in the spec): the banner and teaser pictures shown here, the links, who created the box. */
  readonly bannerUrl?: string | null;
  readonly teaserUrls?: readonly string[];
  readonly links?: SiteLinks;
  readonly creator?: Address | null;
}

/** A fake, recognisable, deterministic Demo token address: `0xde00c` + 35 hex digits of the spec hash. */
export function demoTokenFor(hash: `0x${string}`): Address {
  return `0xde00c${hash.slice(2, 37).toLowerCase()}` as Address;
}

const ZERO_ADDRESS = /^0x0{40}$/i;
const nonZero = (address: Address): Address | null => (ZERO_ADDRESS.test(address) ? null : address);

/**
 * The box record of a spec (validated by the caller against its version context). Before graduation a spec box is
 * Upcoming with "Opens in ~1 h" counting from its creation; a Demo box past that time says "Demo · not trading". A
 * token-only box (F70 "Nothing") is the same record with no items: kind "token", N = 0, no art.
 */
export function recordFromSpec(spec: BoxSpecV1, hash: `0x${string}`, meta: SpecRecordMeta): BoxRecord {
  const token = spec.boxType === BoxType.TOKEN_ONLY;
  const royalty = royaltyOf(spec);
  const cap = capOf(spec);
  const page = pageOf(spec);
  const table = token ? null : decodeMetadataTable(spec.metadataTable);
  const tokens = firstTokens(spec, meta.token);
  const artMode = token ? 'none' : spec.artMode === ArtMode.HIDDEN ? 'hidden' : 'open';
  const burns = qBurns(CONTEXT_V2.qList.find((asset) => asset.token.toLowerCase() === spec.q.toLowerCase()));
  const buyers = sideFacts('buyers', spec.qStream, burns);
  const sellers = sideFacts('sellers', spec.tStream, burns);
  const left = BigInt(Math.max(0, Math.floor((specOpensAtMs(spec.openAt, meta.createdAtMs, meta.nowMs) - meta.nowMs) / 1000)));
  const facts: SpecBoxFacts = Object.freeze({
    specHash: hash,
    owner: spec.marketplaceOwner,
    creator: meta.creator ?? nonZero(spec.marketplaceOwner) ?? nonZero(spec.creatorFeeRecipient),
    firstInRaw: spec.creatorBuy,
    firstTokensRaw: tokens?.raw ?? null,
    firstTokensBps: tokens?.bps ?? null,
    raiseRaw: spec.raise,
    deadlineDays: spec.deadlineDays,
    openAt: spec.openAt,
    buyers,
    sellers,
    capRaw: cap.raw,
    capExcess: cap.excess,
    royaltyBps: royalty.bps,
    royaltyTo: royalty.to,
    artMode,
    coverUrl: meta.coverUrl,
    collectionCoverUrl: token ? null : (meta.collectionCoverUrl ?? null),
    thumbs: Object.freeze(artMode === 'open' ? [...meta.thumbs] : []),
    sealedUrl: sealedUrlOf(spec),
    specials: Object.freeze(specialsOf(spec)),
    traitTypes: Object.freeze((table?.traitTypes ?? []).map((type) => ({ name: type.name, values: type.values.length }))),
    bannerUrl: page.banner ? (meta.bannerUrl ?? null) : null,
    teaserCount: page.teasers,
    teaserUrls: Object.freeze((meta.teaserUrls ?? []).slice(0, page.teasers)),
    externalLink: page.link,
    links: meta.links ?? NO_LINKS,
  });
  const name = spec.collectionName || spec.tokenName;
  return Object.freeze({
    id: formatBoxId(meta.chainId, meta.token),
    chainId: meta.chainId,
    networkLabel: meta.networkLabel,
    kind: token ? 'token' : spec.boxType === BoxType.EXISTING ? 'existing' : 'new',
    name,
    ticker: spec.tokenSymbol,
    pairAsset: 'ETH',
    pairDecimals: 18,
    token: meta.token,
    vault: null,
    itemCount: BigInt(spec.n),
    itemNoun: 'items',
    demo: meta.demo,
    featured: false,
    rehearsal: false,
    order: meta.order,
    market: null,
    demoState: 'upcoming',
    demoFigures: Object.freeze({
      opensIn: approxDuration(left),
      target: ethExact(spec.raise),
      volume24h: '0',
      reserved: 0n,
      outside: 0n,
      deadlineDays: spec.deadlineDays,
      ...(DEMO_BUILD && left === 0n && meta.demo ? { upcomingText: 'Not trading' } : {}),
    }),
    art: null,
    line: firstSentence(spec.description) ?? (token ? 'A plain token launch.' : artMode === 'open' ? 'Art shown openly.' : 'Hidden until drawn.'),
    setup: setupLine(),
    // Holder payouts on either side (the Demo only, F74 U1): holders claim; nothing is built for it yet (S14).
    claims: buyers?.kind === 'holders' || sellers?.kind === 'holders' ? 'holders' : 'none',
    spec: facts,
    row: null,
  });
}

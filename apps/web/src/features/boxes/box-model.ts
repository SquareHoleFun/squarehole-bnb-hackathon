import type { V2Snapshot, V2Source } from '../core/v2/indexer-v2';
import type { SetBoxData, SetFeedWire } from '@squarehole/chain/core/set-v2';
import type { SetSource } from '../set/set-build';
/**
 * The box interface model (docs/design/box-concept/BOX-INTERFACE-v0.2.md § 2; F46: "one uniform box interface, from
 * token launching to graduated ones"). Pure data, no React: a box is a record (identity, kind, names, N, the Demo flag),
 * a state (one of six), one figure for its card, and three counters (Conversion, Claims, Market).
 *
 * Amounts are bigint in logic and decimal strings in fixtures (CLAUDE.md). Identity always comes from addresses, never
 * from names (market-names.ts).
 */
import type { HourlyCandleV2 } from '../core/v2/stats-v2';
import type { BoxRow } from '@squarehole/chain';
import type { Address } from '@squarehole/domain';
import type { BoxV2Facts } from '../core/v2/box-v2';
import type { BoxPictures } from './box-pictures';
import type { FitMarketTarget } from '../fit-pair/fit-target';

/** The six states of a box (BOX-INTERFACE § 3). The Misfits can never be "failed": they have no deadline (F1/F4). */
export type BoxState = 'upcoming' | 'window' | 'bonding' | 'graduating' | 'graduated' | 'failed';

export const BOX_STATES: readonly BoxState[] = Object.freeze(['upcoming', 'window', 'bonding', 'graduating', 'graduated', 'failed']);

export const STATE_LABELS: Readonly<Record<BoxState, string>> = Object.freeze({
  upcoming: 'Upcoming',
  window: 'Launch window',
  bonding: 'Bonding',
  graduating: 'Graduating',
  graduated: 'Graduated',
  failed: 'Failed',
});

/**
 * Genesis: the Misfits set-up; new: a new collection with new art; existing: NFTs that already exist; token: a plain
 * token launch with no items and no vault (F70 "Nothing", BoxType TOKEN_ONLY).
 */
export type BoxKind = 'genesis' | 'new' | 'existing' | 'token';

export const KIND_LABELS: Readonly<Record<BoxKind, string>> = Object.freeze({
  genesis: 'Genesis box',
  new: 'New collection',
  existing: 'Existing NFTs',
  token: 'Token',
});

/**
 * The pair asset a box's curve raises (Q), as its symbol: ETH or USDC for the Demo boxes, a row's own Q for a chain box
 * (BC-086: from the row, with its own decimals in `pairDecimals`). Values (FDV, volume) are only compared within one
 * asset, never converted.
 */
export type PairAsset = string;
/** The Demo boxes' pair assets. */
export type DemoPairAsset = 'ETH' | 'USDC';

/**
 * A box known from its core v1 registry row (S10a): every fact about it comes from the row (BC-086). `network` says
 * which source it was read from; links are built from it, never from the chain id alone (a local twin uses Sepolia's).
 */
export interface RowRef {
  readonly row: BoxRow;
  readonly network: 'local' | 'sepolia' | 'demo';
}

/** A Demo box's numbers, as decimal strings in the pair asset (never JS numbers for amounts). */
export interface DemoBoxFigures {
  /** Upcoming: "~2 h". */
  readonly opensIn?: string;
  /** Bonding / failed: progress in basis points (0..10,000), and the retained and target amounts in Q. */
  readonly progressBps?: number;
  readonly retained?: string;
  readonly target: string;
  /** Graduated: the FDV (price × total supply) and the price (Q per 1M tokens), decimal strings in Q. */
  readonly mcap?: string;
  readonly price?: string;
  /** 24h volume in Q (Demo boxes carry it; chain boxes do not yet). */
  readonly volume24h: string;
  /** Placeholders taken during the curve. */
  readonly reserved: bigint;
  /** Items outside the vault after graduation. */
  readonly outside: bigint;
  /** Deadline in days from the open (others' boxes; the Misfits have none). */
  readonly deadlineDays: number;
  /** Upcoming without a countdown (a Demo box past its open time, nothing trades): the card's words instead. */
  readonly upcomingText?: string;
}

/** The covers and art keys a Demo box uses (packages/design art registry ids). */
export interface DemoBoxArt {
  readonly cover: string;
  readonly sealed: string;
  /** Toy Trains: its revealed items are toy blocks drawn in SVG (Demo only). */
  readonly toyBlocks: boolean;
}

/**
 * One fee side's 10/15 as the spec says (F70; box creation flow § 2.2): who gets it, the token it goes out in (or is
 * burned as), and whether getting there converts (into T: a buy; into Q: a sell, flagged on every page that shows it).
 */
export interface FeeSideFacts {
  readonly kind: 'creator' | 'holders' | 'burn' | 'stream';
  /** T: the box's token; Q: the pair asset; FIT: FIT's buy-and-burn. */
  readonly token: 'T' | 'Q' | 'FIT';
  readonly converts: 'buys' | 'sells' | null;
  /** Offered early and marked so (a holder payout in the Demo: "Pending legal review", F74 U1), else null. */
  readonly pending: string | null;
}

/** A box's site links (F70 step 1): site metadata, never in the spec; empty text = none. */
export interface SiteLinks {
  readonly website: string;
  readonly x: string;
  readonly telegram: string;
}

export const NO_LINKS: SiteLinks = Object.freeze({ website: '', x: '', telegram: '' });

/** Where the royalties add-on sends a royalty (F65, F68). */
export type RoyaltyTo = 'fees' | 'creator' | 'pool';

/**
 * What a box's BoxSpec says, for a box built from one (`recordFromSpec`; launch pipeline v1 § 3.9: the registry's
 * `BoxSpec` event feeds the same function, so factory boxes need no per-box code). Amounts are raw bigint in Q or T.
 */
export interface SpecBoxFacts {
  /** keccak256(abi.encode(spec)). */
  readonly specHash: `0x${string}`;
  /** marketplaceOwner: the collection's owner (zero for a token-only box). */
  readonly owner: Address;
  /** Who created the box: the site record's creator, else the owner, else the fee recipient; null when none is known. */
  readonly creator: Address | null;
  /** The creator buy before the open, Q raw (0 = none; F61 O2). */
  readonly firstInRaw: bigint;
  /** The T it comes to (an estimate, `curveBuyOut`), raw; null when it cannot be computed. */
  readonly firstTokensRaw: bigint | null;
  /** That T as basis points of the issuance, truncated; null with `firstTokensRaw`. */
  readonly firstTokensBps: bigint | null;
  readonly raiseRaw: bigint;
  readonly deadlineDays: number;
  /** When trading opens (BoxSpec field 15, Unix seconds UTC): 0 = Now, the block after the creation block. */
  readonly openAt: number;
  /** Buyers' fees (in Q) and sellers' fees (in T); null when the value is not a known member. */
  readonly buyers: FeeSideFacts | null;
  readonly sellers: FeeSideFacts | null;
  /** The creator-fee cap (add-on 5, F74 U2): a fixed amount per 30 days in Q raw units, 0n = none; where fees above it go. */
  readonly capRaw: bigint;
  readonly capExcess: 'burn' | 'pool' | 'holders' | null;
  /** 0 = no royalties add-on. */
  readonly royaltyBps: number;
  readonly royaltyTo: RoyaltyTo | null;
  /** 'none': a token-only box (no items). */
  readonly artMode: 'open' | 'hidden' | 'none';
  /** The cover (the logo, field 23) as a data URL (Demo: a thumbnail kept in this tab), shown only through <img>; null = none here. */
  readonly coverUrl: string | null;
  /** A new collection's own cover (field 28, F74 U3: its contractURI image) as a data URL; null = none here or no collection. */
  readonly collectionCoverUrl: string | null;
  /** A few item pictures (open art), data URLs, shown only through <img>. */
  readonly thumbs: readonly string[];
  /** Hidden art: the placeholders add-on's picture as an SVG data URL, shown only through <img> (BC-095); else null. */
  readonly sealedUrl: string | null;
  /** Edition specials (add-on 3): named series and their counts. */
  readonly specials: readonly { readonly label: string; readonly count: bigint }[];
  /** The metadata table's trait types and how many values each has. */
  readonly traitTypes: readonly { readonly name: string; readonly values: number }[];
  /** The collection page (add-on 6, F71 (2)): the banner as a data URL, how many teasers the spec names, and their pictures here. */
  readonly bannerUrl: string | null;
  readonly teaserCount: number;
  readonly teaserUrls: readonly string[];
  /** contractURI's external_link (https only), or null. */
  readonly externalLink: string | null;
  /** The site record's links (not in the spec). */
  readonly links: SiteLinks;
}

/** One box as the feed and the box page read it. */
export interface BoxRecord {
  /** `<chainId>-<token address, lowercase>` (box-id.ts). */
  readonly id: string;
  readonly chainId: number;
  readonly networkLabel: string;
  readonly kind: BoxKind;
  /** "The Misfits", "Rehearsal Collection", "Paper Kites". */
  readonly name: string;
  /** "FIT", "RHT2", "KITE". */
  readonly ticker: string;
  readonly pairAsset: PairAsset;
  /** Decimals of the pair asset's raw unit (18 for ETH; a row's Q's own). */
  readonly pairDecimals: number;
  readonly token: Address;
  readonly vault: Address | null;
  /** N: items in the box. Read from the data, never hard-coded. */
  readonly itemCount: bigint;
  /** "Misfits" / "items" / "kites". */
  readonly itemNoun: string;
  /** Mock data: carries the Demo tape everywhere. */
  readonly demo: boolean;
  /** Platform placement: the Misfits launch, pinned first. Never a rehearsal. */
  readonly featured: boolean;
  /** A rehearsal record (neutral names): "Rehearsal · test set". */
  readonly rehearsal: boolean;
  /** Feed order for "New": higher is newer. */
  readonly order: number;
  /** A launch box: the market the live data comes from. */
  readonly market: FitMarketTarget | null;
  /** A Demo box: its fixed state and figures. */
  readonly demoState: BoxState | null;
  readonly demoFigures: DemoBoxFigures | null;
  readonly art: DemoBoxArt | null;
  /** One line about the box (Demo boxes; the Misfits' comes from misfits-content.ts). */
  readonly line: string | null;
  /** The fee set-up in one sentence (About). */
  readonly setup: string;
  /** Who claims fees: per item while it is outside (the Misfits' planned stream), token holders, or nobody. */
  readonly claims: 'per-item' | 'holders' | 'none';
  /** A box built from a BoxSpec (the creation page's Demo boxes, later the factory's): what its spec says. */
  readonly spec: SpecBoxFacts | null;
  /**
   * A chain box's committed pictures (SH-V2-FE11, box-pictures.ts): its logo and box picture by SHA-256 and the
   * gateways to fetch them from; shown only once verified. Absent or null: none committed or none known here.
   */
  readonly pictures?: BoxPictures | null;
  /** A core v1 box: its registry row (S10a); null for the Demo boxes and the v2 rehearsal. */
  readonly row: RowRef | null;
  /** A core v2 box (M1-53-b): what its page reads (the Demo's for now; the indexer's from wave 2). */
  readonly v2?: BoxV2Facts;
  /** `read`: the feed read the snapshot came from, in the order reads start (LINKS-WEB fix round 2); null when unknown. */
  readonly v2Chain?: { readonly source: V2Source | null; readonly snapshot: V2Snapshot | null; readonly read?: number | null };
  /**
   * An existing-NFTs add-on box (SH-EXISTING-NFTS-E08C, features/set): the add-on's source and the indexer's row as of
   * `asOf`. Its page re-reads the box on chain before any action names its vault or collection.
   */
  readonly set?: { readonly source: SetSource; readonly box: SetBoxData; readonly asOf: SetFeedWire['asOf'] };
}

/**
 * A v1 rehearsal record's "Rehearsal · test set" (the first box's set-up, the add-on's sets). SH-224 phase 4: never for a
 * core v2 box, whose local records carry the flag only for being local (record-v2.ts); its page says none either.
 */
export const rehearsalShown = (record: Pick<BoxRecord, 'rehearsal' | 'v2Chain'>): boolean => record.rehearsal && !record.v2Chain;

/** The one figure a card shows for its state (BOX-INTERFACE § 3), and a progress bar in basis points when it has one. */
export interface BoxFigure {
  readonly text: string;
  readonly barBps: number | null;
}

/** What a feed card needs once the state is known. `state` null: unreadable, shown as "Unavailable", never guessed. */
export interface BoxSummary {
  readonly record: BoxRecord;
  readonly state: BoxState | null;
  readonly figure: BoxFigure;
  /** The FDV in Q, raw (18 decimals for ETH, 6 for USDC), for the sort; null when not known or not shown. */
  readonly mcapRaw: bigint | null;
  /** Progress in basis points, for the sort; null when not known. */
  readonly progressBps: number | null;
  /** 24h volume in Q, raw; null when the source does not carry it. */
  readonly volumeRaw: bigint | null;
  /**
   * Honesty words the card always shows when its live data is not current (BOX-INTERFACE § 6 "Never hidden: Demo,
   * Stale"; § 8): "Stale · since block B" or "Unverified"; null when the data is current or the box has no live data.
   */
  readonly notice: string | null;
  /**
   * SH-TA-12, SH-TA-29: a chain box's short numbers under its figure (label, value: "Price", "0.0020649"), a dash for
   * one the source does not have; absent for a box without them (the Demo's, a closed v2 box).
   */
  readonly cells?: readonly (readonly [label: string, value: string])[];
  /** SH-TA-29: a v2 box's hourly candles, drawn as the card's price line. */
  readonly spark?: readonly HourlyCandleV2[];
}

/** Decimals of each pair asset's raw unit. */
export const PAIR_DECIMALS: Readonly<Record<DemoPairAsset, number>> = Object.freeze({ ETH: 18, USDC: 6 });

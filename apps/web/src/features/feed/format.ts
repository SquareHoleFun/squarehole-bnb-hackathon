/**
 * Row/pin presentation model (SH-005). Money stays a decimal string until `formatUsdCompact` (bigint inside, truncates,
 * never overstates); an unavailable metric stays `null` and is rendered as "Not available", never "$0" (FEED-06).
 * Ages are measured against the snapshot `asOf` that is passed in, never the wall clock (ADR-0003 "Clock").
 */
import {
  canonicalPairId,
  formatAge,
  formatUsdCompact,
  isAddress,
  matchSearch,
  pairRoute,
  parseIsoTimestamp,
  type AssetKind,
  type ExternalLinkProvider,
  type Lifecycle,
  type PairRecord,
  type RewardSide,
  type RouteState,
  type SearchMatch,
} from '@squarehole/domain';
import { routeSummary } from '@squarehole/links';
import type { ChainMarketView } from './chain-markets';
import { isShowcasePair } from './showcase';

/** The root ticker is unset (D06); the demo fixture carries this placeholder. */
export const UNSET_SYMBOL = 'UNSET-DEMO';

export interface PairView {
  /** Canonical lowercase pair id (data-pair-id). */
  readonly pairId: string;
  /** Internal detail route; never an external URL. */
  readonly href: string;
  readonly name: string;
  readonly symbol: string;
  readonly symbolUnset: boolean;
  readonly type: AssetKind;
  readonly typeLabel: string;
  readonly lifecycleLabel: string;
  readonly quoteSymbol: string;
  readonly rewardSide: RewardSide;
  readonly rewardSymbol: string;
  readonly rewardText: string;
  readonly marketCap: string | null;
  readonly turnover24h: string | null;
  readonly holders: string | null;
  readonly age: string | null;
  readonly launchedAt: string;
  readonly route: RouteState;
  readonly showcase: boolean;
  /** Why this row matched the current search (null without a search). */
  readonly matchKind: SearchMatch | null;
  /** Visible tag for an address match ("Quote address", …); null for name/symbol matches and no search. */
  readonly matchLabel: string | null;
  /** Chain data sources: quote-denominated figures from the chain read model (null for demo data or while reading). */
  readonly chain: ChainMarketView | null;
}

const TYPE_LABELS: Readonly<Record<AssetKind, string>> = { token: 'Token', nft_collection: 'NFT collection' };
const LIFECYCLE_LABELS: Readonly<Record<Lifecycle, string>> = {
  curve: 'Bonding curve',
  graduating: 'Graduating',
  amm: 'AMM',
  unlaunched: 'Not launched',
};

export function displaySymbol(symbol: string): string {
  return symbol === UNSET_SYMBOL ? 'Ticker not set' : symbol;
}

function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Holder count (a bounded integer, not money). Null or invalid → null (unavailable). */
export function formatHolders(holders: number | null): string | null {
  return holders !== null && Number.isSafeInteger(holders) && holders >= 0 ? groupDigits(holders) : null;
}

export function formatPairCount(count: number): string {
  return `${groupDigits(count)} ${count === 1 ? 'pair' : 'pairs'}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (value: number): string => String(value).padStart(2, '0');

/** "25 Sep 2026, 12:00 UTC" (UTC, no locale data), or null for a malformed timestamp. */
export function formatAsOf(iso: string): string | null {
  let epochMs: number;
  try {
    epochMs = parseIsoTimestamp(iso);
  } catch {
    return null;
  }
  const date = new Date(epochMs);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())} UTC`;
}

function safeAge(launchedAt: string, asOf: string): string | null {
  try {
    return formatAge(launchedAt, asOf);
  } catch {
    return null;
  }
}

function rewardSymbolOf(pair: PairRecord): string {
  if (pair.rewardSide === 'Q') return displaySymbol(pair.quote.symbol);
  return pair.token.symbol === UNSET_SYMBOL ? 'its own token' : pair.token.symbol;
}

export interface PairViewContext {
  /** Snapshot time used as "now" for ages. */
  readonly asOf: string;
  readonly links: ExternalLinkProvider;
  /** The search on screen, if any: address matches are labelled (FEED-04). */
  readonly query?: string;
  /** Chain data sources: quote-denominated figures by canonical pair id (see chain-markets.ts). */
  readonly markets?: ReadonlyMap<string, ChainMarketView>;
}

/** Address match kinds get a visible tag; a name or ticker text match does not (03-FEED match-type labels). */
const MATCH_LABELS: Readonly<Record<SearchMatch, string | null>> = {
  token: 'Token address',
  quote: 'Quote address',
  mirror: 'NFT mirror address',
  pair: 'Pair id',
  name: null,
  symbol: null,
};

export function toPairView(pair: PairRecord, { asOf, links, query = '', markets }: PairViewContext): PairView {
  const rewardSymbol = rewardSymbolOf(pair);
  const matchKind = matchSearch(pair, query);
  const pairId = canonicalPairId(pair.pairId);
  return {
    pairId,
    href: pairRoute(pair),
    name: pair.name,
    symbol: displaySymbol(pair.symbol),
    symbolUnset: pair.symbol === UNSET_SYMBOL,
    type: pair.type,
    typeLabel: TYPE_LABELS[pair.type],
    lifecycleLabel: LIFECYCLE_LABELS[pair.lifecycle],
    quoteSymbol: displaySymbol(pair.quote.symbol),
    rewardSide: pair.rewardSide,
    rewardSymbol,
    rewardText: `Fee share in ${rewardSymbol}`,
    marketCap: pair.marketCapUsd === null ? null : formatUsdCompact(pair.marketCapUsd),
    turnover24h: pair.turnover24hUsd === null ? null : formatUsdCompact(pair.turnover24hUsd),
    holders: formatHolders(pair.holders),
    age: safeAge(pair.launchedAt, asOf),
    launchedAt: pair.launchedAt,
    route: routeSummary(links.destinations(pair)),
    showcase: isShowcasePair(pair.pairId),
    matchKind,
    matchLabel: matchKind === null ? null : MATCH_LABELS[matchKind],
    chain: markets?.get(pairId) ?? null,
  };
}

/** Results-bar wording per match kind; `subject` names the matched asset where the row knows it. */
const ADDRESS_MATCH_TEXT: Readonly<Record<SearchMatch, { text: string; subject?: (view: PairView) => string }>> = {
  quote: { text: 'paired with this quote address', subject: (view) => view.quoteSymbol },
  token: { text: 'with this token address', subject: (view) => view.symbol },
  mirror: { text: 'with this NFT mirror address', subject: (view) => view.name },
  pair: { text: 'with this pair id', subject: (view) => view.name },
  name: { text: 'only by name or ticker text' },
  symbol: { text: 'only by name or ticker text' },
};
const MATCH_ORDER: readonly SearchMatch[] = ['quote', 'token', 'mirror', 'pair', 'name'];

/**
 * For an address search, says how the loaded rows matched ("5 pairs paired with this quote address (AAPLx-DEMO)"), so a
 * pair whose name merely contains the address is told apart from a genuine address match. Null for a text search.
 */
export function describeAddressMatches(rows: readonly PairView[], query: string): string | null {
  if (!isAddress(query.trim()) || rows.length === 0) return null;
  const parts: string[] = [];
  for (const kind of MATCH_ORDER) {
    const matching = rows.filter((view) => view.matchKind === kind || (kind === 'name' && view.matchKind === 'symbol'));
    const first = matching[0];
    if (!first) continue;
    const { text, subject } = ADDRESS_MATCH_TEXT[kind];
    const shared = subject && matching.every((view) => subject(view) === subject(first)) ? ` (${subject(first)})` : '';
    parts.push(`${formatPairCount(matching.length)} ${text}${shared}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

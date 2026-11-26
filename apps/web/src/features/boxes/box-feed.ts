/**
 * The box feed's selection (BOX-INTERFACE § 3): one search over names, tickers and addresses, state chips with counts,
 * and four sorts. The Featured box (platform placement) is always first. The FDV (the `mcap` sort: price × total supply)
 * and 24h volume are in each box's own price coin, so they are sorted within each coin (ETH first, then USDC; one group
 * per chain and coin address, priceCoinKey), never converted; 24h volume is only offered when every listed box has it,
 * like the pair feed's sort honesty.
 */
import type { BoxState, BoxSummary } from './box-model';
import type { BoxSort, BoxStateFilter } from './box-feed-params';

/** "0x" and four hex digits or more: a prefix of the address. */
const ADDRESS_PREFIX = /^0x[0-9a-f]{4,40}$/;
/** Four hex digits or more without "0x": any part of the address ("f17e", the last four digits a card shows). */
const ADDRESS_PART = /^[0-9a-f]{4,40}$/;
/** The short form the page shows, "0x0000…f17e" (or with three dots): its start and its end. */
const ADDRESS_SHORT = /^(0x[0-9a-f]{2,38})(?:…|\.\.\.)([0-9a-f]{2,38})$/;

function matchesAddress(address: string, q: string): boolean {
  const a = address.toLowerCase();
  if (ADDRESS_PREFIX.test(q)) return a.startsWith(q);
  if (ADDRESS_PART.test(q)) return a.slice(2).includes(q);
  const short = ADDRESS_SHORT.exec(q);
  return short !== null && a.startsWith(short[1] ?? '') && a.endsWith(short[2] ?? '');
}

/** Name, ticker, or the token or vault address: a prefix, any part from four hex digits on, or the short form. */
export function matchesQuery(summary: BoxSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  const { record } = summary;
  if (record.name.toLowerCase().includes(q) || record.ticker.toLowerCase().includes(q)) return true;
  return [record.token, record.vault].some((address) => address !== null && matchesAddress(address, q));
}

/** A full address that is no box's token or vault: offered as a wallet ("View only"). */
export function walletQuery(summaries: readonly BoxSummary[], query: string): string | null {
  const q = query.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(q)) return null;
  const isBox = summaries.some(({ record }) => record.token.toLowerCase() === q || record.vault?.toLowerCase() === q);
  return isBox ? null : q;
}

export type StateCounts = Readonly<Record<BoxStateFilter, number>>;

export function stateCounts(summaries: readonly BoxSummary[]): StateCounts {
  const counts: Record<BoxStateFilter, number> = { all: summaries.length, upcoming: 0, window: 0, bonding: 0, graduating: 0, graduated: 0, failed: 0 };
  for (const { state } of summaries) if (state !== null) counts[state] += 1;
  return counts;
}

export function filterSummaries(summaries: readonly BoxSummary[], state: BoxStateFilter, query: string): BoxSummary[] {
  return summaries.filter((summary) => (state === 'all' || summary.state === state) && matchesQuery(summary, query));
}

/** Whether a sort can be honest for these boxes, and why not. */
export function sortAvailability(summaries: readonly BoxSummary[], sort: BoxSort): string | null {
  if (sort === 'volume' && summaries.some((summary) => summary.volumeRaw === null)) return 'Not every box has a 24h volume yet';
  return null;
}

const NATIVE = '0x0000000000000000000000000000000000000000';

/**
 * A box's price coin: its chain id and the coin's address (a v2 box's `record.q`, a v1 row's Q token; the zero address
 * is native ETH), lowercase. Two coins with the same label ("P") are still two coins with their own decimals, so raw
 * amounts are only compared within one key. A box without an address (a Demo box) is native ETH when its pair asset is
 * ETH, else keyed by its pair asset's symbol.
 */
export function priceCoinKey(record: BoxSummary['record']): string {
  const address = record.v2Chain?.snapshot?.record.q ?? record.row?.row.qAsset.token ?? null;
  const coin = address !== null ? address.toLowerCase() : record.pairAsset === 'ETH' ? NATIVE : record.pairAsset;
  return `${record.chainId}:${coin}`;
}

/** Whether a box is priced in the chain's own coin: its price coin's address is the zero address (a Demo box: "ETH"). */
export function nativePriced(record: BoxSummary['record']): boolean {
  const address = record.v2Chain?.snapshot?.record.q ?? record.row?.row.qAsset.token ?? null;
  return address !== null ? BigInt(address) === 0n : record.pairAsset === 'ETH';
}

/** Whether market caps or volumes in more than one price coin are listed (then the note says "within each asset"). */
export function mixedAssets(summaries: readonly BoxSummary[]): boolean {
  return new Set(summaries.map((summary) => priceCoinKey(summary.record))).size > 1;
}

const ASSET_ORDER: ReadonlyMap<string, number> = new Map([
  ['ETH', 0],
  ['USDC', 1],
]);
const later = (state: BoxState | null) => state === 'upcoming' || state === null;

/** "Progress" ranks running curves by their fill, then the upcoming ones, then the ended ones (graduated, failed). */
function progressRank(summary: BoxSummary): number {
  switch (summary.state) {
    case 'graduating':
      return 10_001;
    case 'window':
    case 'bonding':
      return summary.progressBps ?? 0;
    case 'upcoming':
      return -1;
    default:
      return -2;
  }
}

/** Descending bigint with nulls last. */
function byBigintDesc(a: bigint | null, b: bigint | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a > b ? -1 : 1;
}

export function sortSummaries(summaries: readonly BoxSummary[], sort: BoxSort): BoxSummary[] {
  const effective: BoxSort = sortAvailability(summaries, sort) === null ? sort : 'new';
  // SH-300: decided once for the whole list. With one release this is false and every sort is exactly main's.
  const byCreationOrder = effective === 'new' && summaries.some(twoReleases);
  return [...summaries].sort((a, b) => {
    if (a.record.featured !== b.record.featured) return a.record.featured ? -1 : 1;
    if (effective === 'progress') {
      const diff = progressRank(b) - progressRank(a);
      if (diff !== 0) return diff;
    } else if (effective === 'mcap' || effective === 'volume') {
      if (later(a.state) !== later(b.state)) return later(a.state) ? 1 : -1;
      const asset = (ASSET_ORDER.get(a.record.pairAsset) ?? 9) - (ASSET_ORDER.get(b.record.pairAsset) ?? 9);
      if (asset !== 0) return asset;
      // Then one group per price coin (chain and address), in a fixed order; raw amounts compared only inside it.
      const ka = priceCoinKey(a.record);
      const kb = priceCoinKey(b.record);
      if (ka !== kb) return ka < kb ? -1 : 1;
      const diff = effective === 'mcap' ? byBigintDesc(a.mcapRaw, b.mcapRaw) : byBigintDesc(a.volumeRaw, b.volumeRaw);
      if (diff !== 0) return diff;
    }
    const order = b.record.order - a.record.order;
    if (order !== 0) return order;
    return byCreationOrder ? byCreation(a, b) : 0;
  });
}

/** Whether the box's deployment lists more than one v2 release (SH-300). */
const twoReleases = (s: BoxSummary): boolean => (s.record.v2Chain?.source?.manifest.releases.length ?? 0) > 1;

/**
 * SH-300, the New order only, and only where the list holds a box of a deployment with two releases: v2 boxes in the
 * order they were created (their `order` is 0). The indexer adds the boxes of each log batch release by release
 * (packages/indexer/src/core/chain-indexer.ts:505), so after a catch-up one release could follow the other wholesale.
 * The keys: the creation block, ascending (as one release's feed reads), a box without one (not a v2 box) after every
 * v2 box; then the box's identity (chain, then token address), so the order is total and never the feed's.
 */
function byCreation(a: BoxSummary, b: BoxSummary): number {
  const ka = a.record.v2Chain?.snapshot?.record.creationBlock;
  const kb = b.record.v2Chain?.snapshot?.record.creationBlock;
  if (ka !== kb) {
    if (ka === undefined) return 1;
    if (kb === undefined) return -1;
    return ka < kb ? -1 : 1;
  }
  if (a.record.chainId !== b.record.chainId) return a.record.chainId - b.record.chainId;
  const ta = a.record.token.toLowerCase();
  const tb = b.record.token.toLowerCase();
  return ta === tb ? 0 : ta < tb ? -1 : 1;
}

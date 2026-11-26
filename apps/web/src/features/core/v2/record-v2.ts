import type { BoxRecord, BoxState, BoxSummary } from '../../boxes/box-model';
import { formatBoxId } from '../../boxes/box-id';
import { picturesOf } from '../../boxes/box-pictures';
import { rolesOfV2 } from '../../../../../../packages/chain/src/core/v2';
import { checkingV2, type V2Snapshot, type V2Source } from './indexer-v2';
import { closingPricePerMillionV2, NO_FIGURE, raiseShownV2, statFiguresV2 } from './stats-v2';
import { candlesOfV2, cardStatsV2, priceShownV2 } from './StatsV2';
import { coinLabelV2 } from './price-coin';
import { DATA_LABELS } from '../../data-source/data-source';
/**
 * `read`: the feed read the snapshot came from (`readFeedV2`), null when unknown. `coinSymbol`: the price coin's own
 * symbol once read (price-coin.ts); the record names its price coin by it, by "ETH" for the native coin, and by the
 * coin's short address while the symbol is unknown, never "P" (SH-BOX-LIFE-VIEW § 3).
 */
export function recordV2(snapshot: V2Snapshot, source: V2Source, read: number | null = null, coinSymbol: string | null = null): BoxRecord {
  const { spec, record, token } = snapshot;
  const coin = coinLabelV2(record.q, coinSymbol);
  return {
    id: formatBoxId(source.manifest.chainId, token), chainId: source.manifest.chainId, networkLabel: source.network === 'local' ? 'Local chain' : DATA_LABELS.sepolia, kind: spec.boxType === 3 ? 'token' : 'new',
    name: spec.collectionName || spec.tokenName, ticker: spec.tokenSymbol, pairAsset: coin, pairDecimals: snapshot.decimals, token,
    vault: rolesOfV2(record).contracts.vault, itemCount: BigInt(spec.n), itemNoun: 'items', demo: false, featured: false, rehearsal: source.network === 'local', order: 0,
    market: null, demoState: null, demoFigures: null, art: null, line: spec.description || null, setup: `1% of every trade: in ${coin} on buys, in ${spec.tokenSymbol} on sales`, claims: 'none', spec: null, row: null,
    // Its committed logo and collection cover (the logo stands in for a token, shop or pile box), checked before shown;
    // where the source keeps them on Arweave, looked up there too, the indexer's copy first (SH-ARWEAVE-PICTURES-WEB).
    pictures: picturesOf(spec.coverSha256, spec.collectionCoverSha256, source.art ?? [], source.arweave === true ? { copies: snapshot.pictureCopies ?? null } : null),
    v2Chain: { source, snapshot, read },
  };
}
/** BoxOpenSet can precede a scheduled opening. Use chain time, never the browser clock. */
export function phaseV2(view: V2Snapshot): BoxState {
  return view.failed ? 'failed' : view.graduated ? 'graduated' : view.closedAt > 0n ? 'graduating'
    : view.gate.open && view.timestamp >= view.gate.effectiveOpenAt ? 'bonding' : 'upcoming';
}
/**
 * A v2 card's figure: a closed box's claim price; on the curve the raise progress with its bar (SH-TA-29: "62.0% ·
 * 0.26 / 0.42 ETH"), before any statistics the raise; a graduated box's market cap. The sort reads the market cap,
 * the progress and the 24 h volume from the indexer's statistics (null when unknown, never zero).
 */
export function summaryV2(record: BoxRecord, view: V2Snapshot, stale: boolean): BoxSummary {
  const state = phaseV2(view);
  const closing = view.closing;
  // A closed box's claim price per 1M coins, short like every price on the card (SH-BOX-LIFE-VIEW).
  const price = closing ? closingPricePerMillionV2(closing.pot, closing.tLeft, view.decimals) : null;
  const stats = view.failed ? null : view.statistics ?? null;
  const f = statFiguresV2(stats, view.decimals, priceShownV2(view));
  const symbol = record.pairAsset;
  const figure = view.failed ? { text: price === null ? 'Closed' : `${price} ${symbol} per 1M ${record.ticker}`, barBps: null }
    : view.graduated ? { text: f.marketCap === NO_FIGURE ? 'Graduated' : `Mcap ${f.marketCap} ${symbol}`, barBps: null }
    : f.progress !== null && state === 'bonding' ? { text: `${f.progress} · ${f.raised ?? ''} ${symbol}`, barBps: f.progressBps }
    : { text: `Raise ${raiseShownV2(view.record.raise, view.decimals)} ${symbol}`, barBps: null };
  const mcapRaw = stats && priceShownV2(view) ? stats.marketCapP : null;
  const cells = cardStatsV2(view);
  // The price line follows the price: none for a refuted box or without statistics.
  const spark = candlesOfV2(view);
  return { record, state, figure, mcapRaw, progressBps: view.graduated ? 10_000 : stats?.raiseProgress ? Number(stats.raiseProgress.progressBps) : null, volumeRaw: stats ? stats.volume24hP : null,
    ...(cells ? { cells, ...(spark ? { spark } : {}) } : {}),
    // A new box is not audited until the indexer's next audit (every 32 blocks): "Checking", not "Unverified".
    notice: stale || view.stale ? 'Stale' : checkingV2(view) ? 'Checking' : !view.verified ? 'Unverified' : null };
}

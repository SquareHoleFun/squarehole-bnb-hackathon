/**
 * The one figure per state on a box card (BOX-INTERFACE § 3), bigint in logic:
 * - Upcoming: "Opens in ~2 h" (from the window's ETA, block time; blocks when there is none);
 * - Launch window: "Tax 84.25% · 22 blocks" (the next block's tax, rounded UP: a charge is never understated);
 * - Bonding: "62.0% · 2.6112 / 4.206980085 ETH" with a bar (ETH kept by the curve net of sells, truncated to 4
 *   decimals, the Token tab's precision; the one raise exactly, F74 U5);
 * - Graduating: "Target reached" with a full bar (not graduated, BOX-SYSTEM § 4.1);
 * - Graduated: "FDV 41.8 ETH" = pool price × total supply S (supply basis `total_supply`, packages/domain core
 *   metrics). S includes the FIT locked in the vault's escrow, so by the DEX Screener / CoinGecko convention it is a
 *   fully diluted value, not a circulating market cap (that would be price × (S − E), once the feed reads E);
 * - Failed (Demo boxes only): "Refunds open".
 *
 * A figure built from the pool price is never shown when the page hides that price (unverified or unavailable data):
 * the FDV is then "not available". Stale or unverified data puts its words on the card (`notice`).
 */
import { formatTokenAmount, parseDecimal } from '@squarehole/domain';
import { blocks, ethDecimal, formatBlock, formatBps, formatTaxPips, raiseDecimal } from '../fit-pair/fit-format';
import { failedWords } from '../core/v2/v2-words';
import { FIT_ISSUANCE_RAW, type FitMarketTarget } from '../fit-pair/fit-target';
import type { LiveView } from '../fit-pair/live-controller';
import type { LiveData } from '../fit-pair/live-model';
import type { BoxFigure, BoxRecord, BoxState, BoxSummary } from './box-model';

export const UNAVAILABLE_FIGURE: BoxFigure = Object.freeze({ text: 'Unavailable', barBps: null });

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * "18:00 UTC", or "5 Oct, 18:00 UTC" when it is not on the same UTC day as `nowMs` (an opening time, a window's end;
 * minutes, the seconds dropped).
 */
export function utcTime(ms: number, nowMs: number): string {
  const at = new Date(ms);
  const now = new Date(nowMs);
  const time = `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')} UTC`;
  const sameDay = at.getUTCFullYear() === now.getUTCFullYear() && at.getUTCMonth() === now.getUTCMonth() && at.getUTCDate() === now.getUTCDate();
  return sameDay ? time : `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}, ${time}`;
}

/** "~45 min", "~2 h", "~3 d" for a positive number of seconds (truncated: an ETA is an estimate, never a promise). */
export function approxDuration(seconds: bigint): string {
  if (seconds < 60n) return '<1 min';
  if (seconds < 3_600n) return `~${seconds / 60n} min`;
  if (seconds < 172_800n) return `~${seconds / 3_600n} h`;
  return `~${seconds / 86_400n} d`;
}

/** decimal × 10^decimals as a raw bigint, truncated ("6200.5", 6 → 6_200_500_000n). */
export function decimalToRaw(decimal: string, decimals: number): bigint {
  const { units, scale } = parseDecimal(decimal);
  return scale <= decimals ? units * 10n ** BigInt(decimals - scale) : units / 10n ** BigInt(scale - decimals);
}

/** ETH per token (a decimal string) × a raw supply = the market cap in wei, truncated. */
export function marketCapWei(priceEthPerToken: string, supplyRaw: bigint): bigint | null {
  try {
    const { units, scale } = parseDecimal(priceEthPerToken);
    return (supplyRaw * units) / 10n ** BigInt(scale);
  } catch {
    return null;
  }
}

/** The pair asset of a box: its symbol and its raw unit's decimals (a row's own Q, BC-083). */
export type PairOf = Pick<BoxRecord, 'pairAsset' | 'pairDecimals'>;

/** A raise in the pair asset with every digit it has: "4.206980085" (F74 U5: the one raise, stated exactly). */
export const raiseText = (raw: bigint, pair: PairOf): string => formatTokenAmount(raw, pair.pairDecimals, { maxFractionDigits: pair.pairDecimals });

/** A raw amount in the pair asset, short: "2.61", "6,200", "18.4" (whole units for a stable asset). */
export function formatPair(raw: bigint, pair: PairOf, digits = 2): string {
  return formatTokenAmount(raw, pair.pairDecimals, { maxFractionDigits: pair.pairDecimals >= 18 ? digits : 0 });
}

/** S from the live data: the one-time issuance less what was burned; null when the source does not know. */
export function supplyFromLive(live: LiveData | null): bigint | null {
  const burned = live?.state.burnedRaw ?? null;
  return burned === null || burned > FIT_ISSUANCE_RAW ? null : FIT_ISSUANCE_RAW - burned;
}

/** How current a launch box's live data is (the page's `LiveView`). */
export type SummaryFreshness = Pick<LiveView, 'freshness' | 'staleSinceBlock'>;

/** Whether the pool price may be shown (the page hides it for unverified or unavailable data). */
export const priceTrusted = (view: Pick<LiveView, 'freshness'> | null): boolean => view === null || (view.freshness !== 'unverified' && view.freshness !== 'unavailable');

/** The card's honesty words for stale or unverified data, or null. */
export function freshnessNotice(view: SummaryFreshness | null): string | null {
  if (view === null) return null;
  if (view.freshness === 'stale') return view.staleSinceBlock === null ? 'Stale' : `Stale · since block ${formatBlock(view.staleSinceBlock)}`;
  if (view.freshness === 'unverified') return 'Unverified';
  return null;
}

/** The figure, the progress and the FDV of a launch box, from its live data and how current it is. */
export function launchSummary(record: BoxRecord, state: BoxState | null, live: LiveData | null, target: FitMarketTarget, view: SummaryFreshness | null = null): BoxSummary {
  const none = { record, state, figure: UNAVAILABLE_FIGURE, mcapRaw: null, progressBps: null, volumeRaw: null, notice: freshnessNotice(view) };
  if (state === null || live === null) return none;
  const figures = live.confirmed.figures;
  const w = live.window;
  switch (state) {
    case 'upcoming': {
      const eta = w.etaOpenUnix;
      const text = eta !== null && eta > live.head.timestamp ? `Opens in ${approxDuration(eta - live.head.timestamp)}` : `Opens in ${blocks(w.blocksToOpen + 1n)}`;
      return { ...none, figure: { text, barBps: null }, progressBps: 0 };
    }
    case 'window':
      return { ...none, figure: { text: `Tax ${formatTaxPips(w.nextBlockTaxPips)} · ${blocks(w.blocksToClose)}`, barBps: figures.fillBps }, progressBps: figures.fillBps };
    case 'bonding':
      return {
        ...none,
        figure: { text: `${formatBps(figures.fillBps)} · ${ethDecimal(figures.retainedWei)} / ${raiseDecimal(target.curve.targetWei)} ETH`, barBps: figures.fillBps },
        progressBps: figures.fillBps,
      };
    case 'graduating':
      return { ...none, figure: { text: 'Target reached', barBps: 10_000 }, progressBps: 10_000 };
    case 'graduated': {
      const supply = supplyFromLive(live);
      const fdv = supply === null || !priceTrusted(view) ? null : marketCapWei(live.state.figures.priceEthPerToken, supply);
      return { ...none, figure: { text: fdv === null ? 'FDV not available' : `FDV ${ethDecimal(fdv, 2)} ETH`, barBps: null }, mcapRaw: fdv, progressBps: 10_000 };
    }
    default:
      return none;
  }
}

/** The figure of a Demo box, from its fixed Demo numbers. */
export function demoSummary(record: BoxRecord): BoxSummary {
  const f = record.demoFigures;
  const state = record.demoState;
  const asset = record.pairAsset;
  const decimals = record.pairDecimals;
  const base = { record, state, figure: UNAVAILABLE_FIGURE, mcapRaw: null, progressBps: null, volumeRaw: f ? decimalToRaw(f.volume24h, decimals) : null, notice: null };
  if (f === null || state === null) return base;
  const target = decimalToRaw(f.target, decimals);
  switch (state) {
    case 'upcoming':
      return { ...base, figure: { text: f.upcomingText ?? `Opens in ${f.opensIn ?? 'a while'}`, barBps: null }, progressBps: 0 };
    case 'bonding': {
      const bps = f.progressBps ?? 0;
      const retained = decimalToRaw(f.retained ?? '0', decimals);
      // What the curve holds to 4 decimals (ETH), as a launch box's card; the one raise exactly, "4.206980085" (F74 U5).
      const digits = asset === 'ETH' ? 4 : 2;
      return { ...base, figure: { text: `${formatBps(bps)} · ${formatPair(retained, record, digits)} / ${raiseText(target, record)} ${asset}`, barBps: bps }, progressBps: bps };
    }
    case 'graduated': {
      const mcap = decimalToRaw(f.mcap ?? '0', decimals);
      return { ...base, figure: { text: `FDV ${formatPair(mcap, record, 1)} ${asset}`, barBps: null }, mcapRaw: mcap, progressBps: 10_000 };
    }
    case 'failed':
      return { ...base, figure: { text: failedWords(record.v2 !== undefined).figure, barBps: null }, progressBps: f.progressBps ?? null };
    default:
      return base;
  }
}

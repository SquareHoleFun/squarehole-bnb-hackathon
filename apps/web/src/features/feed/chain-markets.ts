/**
 * Quote-denominated market figures for chain data sources (SH-C; 03-FEED "No price coverage means quote-asset amounts
 * may be displayed, but cross-asset USD sorting must treat the metric as unavailable").
 *
 * No USD source is adopted for test chains (ADR-0012 §6), so every USD field of a chain `PairRecord` is null and the
 * feed ranks by launch time. What the chain does know exactly lives in the chain read model (`readMarket`): the pool
 * mid price in Q per T, market cap and FDV in Q, 24h turnover in Q. These are shown next to the (unavailable) USD
 * figures, always with the quote symbol, truncated (never rounded up), and never sorted across different quote assets.
 */
import type { ChainPairMarket } from '@squarehole/chain';
import { canonicalPairId, formatTokenAmount, isRawAmount, type DecimalAmount, type Provenance } from '@squarehole/domain';
import { useQueries } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useChainRuntime } from '../data-source/data-source-context';
import { displaySymbol } from './format';

/**
 * Chain sources re-read their queries this often (and treat older answers as stale), so a page left open re-checks the
 * chain and re-applies the stale rules (an RPC outage, Sepolia's 15 minutes). The demo fixtures never change.
 */
export const CHAIN_REFRESH_MS = 60_000;

export interface ChainMarketView {
  /** "0.00000000146811 WETH" per displayed T (pool mid price, not an execution quote); null when unavailable. */
  readonly price: string | null;
  /** Market cap in Q on the ledger's eligible supply ("0.264784 WETH"); null when unavailable. */
  readonly marketCap: string | null;
  /** FDV in Q on the current supply; labelled FDV wherever it is shown. */
  readonly fdv: string | null;
  /** 24h canonical-pool turnover in Q. */
  readonly turnover: string | null;
  readonly quoteSymbol: string;
  readonly block: string;
  /** Provenance state of the figures (the snapshot they come from): `stale` or `partial` is shown, never hidden. */
  readonly state: Provenance['state'];
}

/** Digits kept after the first significant digit of a price (truncated). */
export const PRICE_SIGNIFICANT_DIGITS = 6;

/** A non-negative decimal string truncated to `digits` significant digits ("0.00000000146811"). Never rounds up. */
export function truncateSignificant(value: DecimalAmount, digits: number): string {
  const [whole = '0', fraction = ''] = value.split('.');
  const trimmedWhole = whole.replace(/^0+(?=\d)/, '');
  if (trimmedWhole !== '0') {
    const keepFraction = Math.max(0, digits - trimmedWhole.length);
    const frac = fraction.slice(0, keepFraction).replace(/0+$/, '');
    return frac === '' ? trimmedWhole : `${trimmedWhole}.${frac}`;
  }
  const firstSignificant = fraction.search(/[1-9]/);
  if (firstSignificant < 0) return '0';
  const frac = fraction.slice(0, firstSignificant + digits).replace(/0+$/, '');
  return `0.${frac}`;
}

const DIGITS = 6;
const COMPACT_FROM_WHOLE = 1_000_000n;

function groupWhole(value: string): string {
  const [whole = '0', fraction] = value.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/**
 * A quote-denominated figure for a fixed-width feed cell (SH-C review): at most 6 decimals AND at most 6 significant
 * digits, grouped ("1,071.61", "545.789", "0.101187", "<0.000001"); from one million whole units the compact form
 * ("1.2M"). Always truncated, never rounded up; the pair page shows the longer figure. Short enough to stay on one line
 * (it is never broken inside the number).
 */
export function formatQuoteFigure(raw: string, decimals: number): string {
  if (BigInt(raw) >= COMPACT_FROM_WHOLE * 10n ** BigInt(decimals)) return formatTokenAmount(raw, decimals, { compact: true });
  const six = formatTokenAmount(raw, decimals, { maxFractionDigits: DIGITS });
  if (six === '0' || six.startsWith('<')) return six;
  return groupWhole(truncateSignificant(six.replaceAll(',', ''), DIGITS));
}

function rawInQ(raw: string, decimals: number, symbol: string): string | null {
  return isRawAmount(raw) ? `${formatQuoteFigure(raw, decimals)} ${symbol}` : null;
}

export function chainMarketView(market: ChainPairMarket): ChainMarketView {
  const quoteSymbol = displaySymbol(market.quote.symbol);
  const { decimals } = market.quote;
  return Object.freeze({
    price: market.priceQPerT.available ? `${truncateSignificant(market.priceQPerT.display, PRICE_SIGNIFICANT_DIGITS)} ${quoteSymbol}` : null,
    marketCap: market.marketCapQRaw.available ? rawInQ(market.marketCapQRaw.value, decimals, quoteSymbol) : null,
    fdv: market.fdvQRaw.available ? rawInQ(market.fdvQRaw.value, decimals, quoteSymbol) : null,
    turnover: market.turnover24hQ.available ? rawInQ(market.turnover24hQ.totalRaw, decimals, quoteSymbol) : null,
    quoteSymbol,
    block: market.block.number,
    state: market.provenance.state,
  });
}

const EMPTY: ReadonlyMap<string, ChainMarketView> = new Map();

/**
 * Chain market views of the given pairs (canonical id → view), read from the SAME held snapshot as the feed rows
 * (`snapshotId`), so the header's block and the figures never mix blocks. Empty for the demo fixtures. Re-read every
 * `CHAIN_REFRESH_MS` so a stale snapshot (RPC outage, Sepolia's 15 minutes) is re-evaluated while the page is open.
 */
export function useChainMarkets(pairIds: readonly string[], snapshotId: string | null): ReadonlyMap<string, ChainMarketView> {
  const runtime = useChainRuntime();
  const ids = useMemo(() => (runtime === null ? [] : [...new Set(pairIds.map((id) => canonicalPairId(id)))].sort()), [pairIds, runtime]);
  const combine = useCallback(
    (results: readonly { data?: ChainMarketView | null }[]): ReadonlyMap<string, ChainMarketView> => {
      if (ids.length === 0) return EMPTY;
      const out = new Map<string, ChainMarketView>();
      results.forEach((result, index) => {
        const id = ids[index];
        if (id !== undefined && result.data) out.set(id, result.data);
      });
      return out;
    },
    [ids],
  );
  return useQueries({
    queries: ids.map((pairId) => ({
      queryKey: ['chain-market', snapshotId, pairId],
      queryFn: async ({ signal }: { signal: AbortSignal }): Promise<ChainMarketView | null> => {
        if (runtime === null || snapshotId === null) throw new Error('No chain data source');
        const market = await runtime.providers.feed.readMarket(pairId as `${number}:0x${string}`, { snapshotId, signal });
        return market === null ? null : chainMarketView(market);
      },
      enabled: runtime !== null && snapshotId !== null,
      staleTime: CHAIN_REFRESH_MS,
      refetchInterval: CHAIN_REFRESH_MS,
    })),
    combine,
  });
}

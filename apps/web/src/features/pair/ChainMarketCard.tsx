import type { ChainPairMarket } from '@squarehole/chain';
import { formatTokenAmount, type PairId, type PairRecord } from '@squarehole/domain';
import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { Loader } from '../brand';
import { useChainRuntime, useDataSource } from '../data-source';
import { CHAIN_REFRESH_MS, PRICE_SIGNIFICANT_DIGITS, truncateSignificant } from '../feed/chain-markets';
import { SnapshotNotices } from '../feed/FeedStates';
import { selectNotices } from '../feed/feed-state';
import { displaySymbol } from '../feed/format';

const DIGITS = 6;

function amount(raw: string, decimals: number, symbol: string): string {
  return `${formatTokenAmount(raw, decimals, { maxFractionDigits: DIGITS })} ${symbol}`;
}

/**
 * Chain data sources only (SH-C): what the chain knows exactly about this pair at one block, in its quote asset: pool
 * mid price, market cap on the reward ledger's eligible supply, FDV on the current supply (labelled FDV), 24h canonical
 * pool turnover with the protocol-generated share, the supply concepts with the burn reconciliation, and the
 * disclosures of the pair's quote. Nothing is priced in USD: no USD source is adopted for test chains (ADR-0012 §6).
 */
export function ChainMarketCard({ pair }: { pair: PairRecord }) {
  const source = useDataSource();
  const runtime = useChainRuntime();
  const titleId = useId();
  const market = useQuery({
    queryKey: ['chain-market-detail', pair.pairId],
    enabled: runtime !== null,
    queryFn: ({ signal }) => {
      if (runtime === null) throw new Error('No chain data source');
      return runtime.providers.feed.readMarket(pair.pairId as PairId, { signal });
    },
    // Re-read while the page is open: a stale snapshot (RPC outage, Sepolia's 15 minutes) is re-evaluated and shown.
    staleTime: CHAIN_REFRESH_MS,
    refetchInterval: CHAIN_REFRESH_MS,
  });
  if (source.chain === null) return null;
  return (
    <section className="sh-detail-card sh-chain-market" aria-labelledby={titleId} data-testid="chain-market">
      <h2 id={titleId} className="sh-detail-card__title">
        On-chain market ({source.dataLabel})
      </h2>
      {market.isError ? (
        <p role="alert">The chain figures could not be read right now. Nothing is shown as zero in their place.</p>
      ) : market.data === undefined ? (
        <p role="status" className="sh-loader-line">
          <Loader size="inline" decorative />
          Reading the pool and supply at the snapshot block…
        </p>
      ) : market.data === null ? (
        <p>This pair is not in the current chain snapshot yet.</p>
      ) : (
        <MarketFacts market={market.data} pair={pair} />
      )}
    </section>
  );
}

function MarketFacts({ market, pair }: { market: ChainPairMarket; pair: PairRecord }) {
  const q = displaySymbol(market.quote.symbol);
  const t = displaySymbol(pair.symbol);
  const qd = market.quote.decimals;
  const unavailable = (reason: string) => <span className="sh-na">Not available: {reason}</span>;
  return (
    <>
      {/* The figures' own provenance, when it differs from the page's record (another snapshot, or it went stale). */}
      <div data-market-state={market.provenance.state}>
        {market.provenance.state === pair.provenance.state && market.block.number === pair.provenance.blockNumber ? null : (
          <SnapshotNotices notices={selectNotices(market.provenance)} />
        )}
      </div>
      <dl className="sh-chain-market__facts">
        <div data-fact="price">
          <dt>Price (pool mid price)</dt>
          <dd>
            {market.priceQPerT.available ? (
              <span className="sh-numeric">
                {truncateSignificant(market.priceQPerT.display, PRICE_SIGNIFICANT_DIGITS)} {q} per {t}
              </span>
            ) : (
              unavailable(market.priceQPerT.reason)
            )}
          </dd>
        </div>
        <div data-fact="market-cap">
          <dt>Market cap (eligible supply)</dt>
          <dd>{market.marketCapQRaw.available ? <span className="sh-numeric">{amount(market.marketCapQRaw.value, qd, q)}</span> : unavailable(market.marketCapQRaw.reason)}</dd>
        </div>
        <div data-fact="fdv">
          <dt>FDV (current supply)</dt>
          <dd>{market.fdvQRaw.available ? <span className="sh-numeric">{amount(market.fdvQRaw.value, qd, q)}</span> : unavailable(market.fdvQRaw.reason)}</dd>
        </div>
        <div data-fact="turnover">
          <dt>24h turnover (canonical pool)</dt>
          <dd>
            {market.turnover24hQ.available ? (
              <span className="sh-numeric">
                {amount(market.turnover24hQ.totalRaw, qd, q)} · {market.turnover24hQ.swaps} swaps · protocol share{' '}
                {amount(market.turnover24hQ.protocolRaw, qd, q)}
              </span>
            ) : (
              unavailable(market.turnover24hQ.reason)
            )}
          </dd>
        </div>
        <div data-fact="supply">
          <dt>Supply now / at launch</dt>
          <dd className="sh-numeric">
            {formatTokenAmount(market.supply.currentRaw, 18, { maxFractionDigits: DIGITS })} / {formatTokenAmount(market.supply.initialRaw, 18, { maxFractionDigits: DIGITS })} {t}
          </dd>
        </div>
        <div data-fact="burned">
          <dt>Burned fee {t}</dt>
          <dd>
            <span className="sh-numeric">{amount(market.supply.burnedRaw, 18, t)}</span>{' '}
            {market.supply.burnReconciled ? '(reconciled with the fee collector)' : '(does not reconcile with the fee collector yet)'}
          </dd>
        </div>
        <div data-fact="holders">
          <dt>Holders (positive eligible balances)</dt>
          <dd>{market.holders.available ? <span className="sh-numeric">{market.holders.count}</span> : unavailable(market.holders.reason)}</dd>
        </div>
        <div data-fact="block">
          <dt>Read at block</dt>
          <dd className="sh-numeric">
            {market.block.number} · {market.poolStateSource === 'state_view' ? 'StateView' : 'PoolManager storage'}
          </dd>
        </div>
      </dl>
      <p className="sh-chain-note">
        The mid price is not an execution quote and excludes the pool’s {market.lpFeePips / 10_000}% LP fee. USD:{' '}
        {market.usd.priceUsd === null ? (market.usd.reason ?? 'not available') : market.usd.priceUsd}.
      </p>
      {market.soldOut ? <p className="sh-chain-note">The pool range is sold out: conversions to {t} are unavailable (the labelled payout in {q} applies).</p> : null}
      {market.disclosures.length > 0 ? (
        <ul className="sh-chain-market__disclosures" aria-label="Disclosures">
          {market.disclosures.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

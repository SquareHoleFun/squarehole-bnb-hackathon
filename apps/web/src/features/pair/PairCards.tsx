import { CastCharacter } from '@squarehole/design';
import type { PairDetail, PairRecord, Provenance } from '@squarehole/domain';
import { Link } from 'react-router';
import { useDataSource } from '../data-source';
import { displaySymbol, formatAsOf } from '../feed/format';
import { PairClaim } from '../rewards/PairClaim';
import { AmountText } from './AmountText';
import { FlameIcon } from './pair-icons';
import { activityRows, amountSymbol, fractionModel, isWrapperQuote, payoutText, rewardRows, supplyRows } from './pair-model';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;


function asOfText(provenance: Provenance): string {
  const when = formatAsOf(provenance.asOf) ?? provenance.asOf;
  return provenance.blockNumber ? `${when} · block ${provenance.blockNumber}` : when;
}

/** Supply concepts shown separately (FEED-07, 05 "Burn mechanics"), plus the fungible ↔ NFT relationship. */
export function SupplyCard({ pair, detail }: { pair: PairRecord; detail: PairDetail }) {
  const rows = supplyRows(detail, pair, !(useDataSource().isDemo && DEMO_BUILD));
  const fractions = fractionModel(detail, pair);
  return (
    <section className="sh-detail-card sh-supply" aria-labelledby="supply-title">
      <div className="sh-detail-card__head">
        <h2 id="supply-title" className="sh-detail-card__title">
          Supply
        </h2>
        <p className="sh-muted">Separate figures; none of them is added to another.</p>
      </div>
      <dl className="sh-supply__list">
        {rows.map((row) => (
          <div key={row.id} className="sh-supply__row" data-supply={row.id}>
            <dt>
              {row.id === 'burned' ? <FlameIcon /> : null}
              {row.label}
            </dt>
            <dd className="sh-supply__value">
              <AmountText value={row.value} />
            </dd>
            <dd className="sh-supply__basis">{row.basis}</dd>
          </div>
        ))}
      </dl>
      {fractions ? (
        <aside className="sh-fractions" aria-labelledby="fractions-title">
          <CastCharacter id="collector" size={56} caption={false} className="sh-fractions__art" />
          <div className="sh-fractions__body">
            <h3 id="fractions-title" className="sh-detail-card__subtitle">
              How NFTs and {fractions.symbol} relate
            </h3>
            <p>
              <strong className="sh-numeric">
                1 NFT = {fractions.perNft} {fractions.symbol}
              </strong>
              . There is one balance: each whole NFT’s worth of {fractions.symbol} you hold shows up as one NFT, and the
              rest stays a fractional balance. A balance of {fractions.example.balance} {fractions.symbol} is{' '}
              {fractions.example.whole} NFTs plus {fractions.example.fraction} {fractions.symbol} not yet a whole NFT. NFTs
              and {fractions.symbol} are the same units, so they are never counted twice.
            </p>
            <p>A balance below a whole NFT is not an NFT, and no balance lets you choose a rare one.</p>
            <p className="sh-muted">The Collector would like it noted that it is not a shape.</p>
          </div>
        </aside>
      ) : null}
    </section>
  );
}

/**
 * Holder fee-share card (01-PRODUCT; F23 wording): payout asset, paid/credited per asset (never summed), last update,
 * then the claim entry: "Claim on the Claims page" without a wallet, or the connected demo account's claim on this pair (same flow as `/rewards`).
 */
export function RewardsCard({ pair, detail }: { pair: PairRecord; detail: PairDetail }) {
  const rows = rewardRows(detail, pair);
  return (
    <section className="sh-detail-card sh-rewards" aria-labelledby="rewards-title">
      <h2 id="rewards-title" className="sh-detail-card__title">
        Holder fee share
      </h2>
      <p className="sh-rewards__payout">{payoutText(pair)}</p>
      <p className="sh-muted">
        Part of each fee is credited to every holder of {amountSymbol(pair.token.symbol)}, whichever asset it is paid in.
        Totals stay in each asset’s own units and are never added together. No yield is predicted.
      </p>
      <ul className="sh-rewards__list" aria-label="Holder fee share per asset">
        {rows.map((row) => (
          <li key={row.symbol} className="sh-rewards__row">
            <p className="sh-rewards__asset">{row.symbol}</p>
            <p className="sh-rewards__role">{row.role}</p>
            <dl className="sh-rewards__figures">
              <div>
                <dt>Paid out</dt>
                <dd>
                  <AmountText value={row.paid} />
                </dd>
              </div>
              <div>
                <dt>Credited, unclaimed</dt>
                <dd>
                  <AmountText value={row.accrued} />
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
      <p className="sh-rewards__asof">Last update: {asOfText(detail.provenance)}</p>
      <PairClaim pair={pair} />
    </section>
  );
}

/** Demo activity. No transaction hashes, so no explorer links are invented (FEED-09, EXT-08). */
export function ActivityCard({ detail }: { detail: PairDetail }) {
  const rows = activityRows(detail);
  const source = useDataSource();
  return (
    <section className="sh-detail-card sh-activity" aria-labelledby="activity-title">
      <div className="sh-detail-card__head">
        <h2 id="activity-title" className="sh-detail-card__title">
          Activity
        </h2>
        <p className="sh-muted">
          {(DEMO_BUILD && source.isDemo)
            ? 'Newest first. These rows have no transaction hash, so there are no explorer links.'
            : source.id === 'local'
              ? 'Newest first, from the chain’s event logs. A local chain has no public explorer, so there are no explorer links.'
              : 'Newest first, from the chain’s event logs.'}
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="sh-muted">No activity in this snapshot.</p>
      ) : (
        <ol className="sh-activity__list" aria-label="Pair activity">
          {rows.map((row) => (
            <li key={row.key} className="sh-activity__row" data-activity={row.kind}>
              <span className="sh-activity__kind">{row.label}</span>
              <span className="sh-activity__amounts sh-numeric">{row.amounts}</span>
              <span className="sh-activity__when">
                <time dateTime={row.at}>{row.when}</time> · block {row.block}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Description (untrusted text), the paired asset's meaning and where the data comes from. */
export function AboutCard({ pair, detail }: { pair: PairRecord; detail: PairDetail }) {
  const quote = displaySymbol(pair.quote.symbol);
  return (
    <section className="sh-detail-card sh-about" aria-labelledby="about-title">
      <h2 id="about-title" className="sh-detail-card__title">
        About {pair.name}
      </h2>
      <p className="sh-about__description">{detail.description}</p>
      {isWrapperQuote(pair) ? (
        <p className="sh-about__note">
          {quote} is a stock-linked wrapper. Amounts paid in {quote} are wrapper shares, whose underlying asset is{' '}
          <code>{pair.quote.underlyingAddress}</code>. Being paired with it does not mean {pair.name} is backed by,
          redeemable for or endorsed by the stock’s issuer.
        </p>
      ) : null}
      <dl className="sh-about__source">
        <div>
          <dt>Data</dt>
          <dd>{detail.provenance.source}</dd>
        </div>
        <div>
          <dt>As of</dt>
          <dd>{asOfText(detail.provenance)}</dd>
        </div>
      </dl>
      <p>
        <Link to="/about/risks">How data sources and external routes work</Link>
      </p>
    </section>
  );
}

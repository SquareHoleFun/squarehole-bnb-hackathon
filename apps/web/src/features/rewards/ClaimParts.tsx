import type { ClaimView, ConvertibleEstimate, DirectSourceFallback, PairRecord, Position } from '@squarehole/domain';
import { useId } from 'react';
import { Amount, exactAmount, formatAmount, formatDecimal, formatInteger } from '../accounts';
import { displaySymbol, formatAsOf } from '../feed/format';
import { explainReason } from '../tx';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

/** Current holding in a pair: a position, none, still reading, or unavailable (a failed read is never a zero). */
export type Holding = Position | null | 'pending' | 'unavailable';

/** The account's current balance in this pair; zero is stated plainly, and credited amounts survive it (ECO-05). */
export function HoldingLine({ pair, position }: { pair: PairRecord; position: Holding }) {
  if (position === 'pending') return <p className="sh-claim__holding">Reading your current balance…</p>;
  if (position === 'unavailable') return <p className="sh-claim__holding">Current balance unavailable.</p>;
  if (position === null) {
    return (
      <p className="sh-claim__holding" data-holding="none">
        You hold no {displaySymbol(pair.symbol)} now. Amounts credited while you held it stay claimable by you; a later
        holder does not get them.
      </p>
    );
  }
  return (
    <p className="sh-claim__holding" data-holding="some">
      You hold <Amount raw={position.balanceRaw} asset={pair.token} /> now.
    </p>
  );
}

/** Claimable, claimed, credited and pending harvest as separate figures, each in the Q asset it is credited in (03-FEED). */
export function ClaimFigures({ claim, pair }: { claim: ClaimView; pair: PairRecord }) {
  const q = pair.quote;
  return (
    <dl className="sh-claim__figures">
      <div className="sh-claim__figure sh-claim__figure--primary" data-figure="claimable">
        <dt>Claimable now</dt>
        <dd>
          <Amount raw={claim.claimableQRaw} asset={q} />
        </dd>
      </div>
      <div className="sh-claim__figure" data-figure="claimed">
        <dt>Already claimed</dt>
        <dd>
          <Amount raw={claim.claimedQRaw} asset={q} />
        </dd>
      </div>
      <div className="sh-claim__figure" data-figure="earned">
        <dt>Credited in total</dt>
        <dd>
          <Amount raw={claim.earnedQRaw} asset={q} />
        </dd>
      </div>
      <div className="sh-claim__figure" data-figure="pending">
        <dt>
          Pending harvest <span className="sh-claim__qualifier">not claimable</span>
        </dt>
        <dd>
          <Amount raw={claim.pendingHarvestQRaw} asset={q} />
        </dd>
      </div>
    </dl>
  );
}

/** The R=T conversion quote: read-only estimate, computed minimum and deadline. Nothing here is editable (ECO-07). */
export function ConversionEstimate({ estimate, pair }: { estimate: ConvertibleEstimate; pair: PairRecord }) {
  const headingId = useId();
  const token = displaySymbol(pair.token.symbol);
  const quote = displaySymbol(pair.quote.symbol);
  const tolerance = `${formatDecimal(String(estimate.toleranceBps / 100))}%`;
  const demoQuote = DEMO_BUILD && estimate.source === 'demo_quote';
  const quoteSource =
    estimate.source === 'v4_quoter_eth_call' ? 'V4Quoter eth_call' : !DEMO_BUILD || estimate.source === 'converter_eth_call' ? 'eth_call of this conversion' : 'snapshot quote';
  return (
    <section className="sh-claim__estimate" aria-labelledby={headingId} data-testid="conversion-estimate">
      <p className="sh-claim__subhead">
        <span id={headingId}>Conversion estimate</span> <span className="sh-chip">Read-only · {quoteSource}</span>
      </p>
      <dl className="sh-claim__terms">
        <div>
          <dt>Estimated payout</dt>
          <dd>
            <span>
              ≈ <Amount raw={estimate.payoutRaw} asset={pair.token} />
            </span>
          </dd>
        </div>
        <div>
          <dt>Minimum you sign</dt>
          <dd>
            <Amount raw={estimate.minPayoutRaw} asset={pair.token} />
            <span className="sh-claim__note">
              {tolerance} below the estimate: a fixed tolerance, not a setting{demoQuote ? '' : '; the minimum you sign is re-quoted by an eth_call when you start the claim'}
            </span>
          </dd>
        </div>
        <div>
          <dt>Rate</dt>
          <dd>
            <span className="sh-numeric">
              {formatDecimal(estimate.tPerQ)} {token} per {quote}
            </span>
            <span className="sh-claim__note">
              quoted at block <span className="sh-numeric">{formatInteger(estimate.asOfBlock)}</span>
            </span>
          </dd>
        </div>
        <div>
          <dt>Deadline</dt>
          <dd>
            <time dateTime={estimate.deadline}>{formatAsOf(estimate.deadline) ?? estimate.deadline}</time>
            <span className="sh-claim__note">sign before this, or the request is cancelled</span>
          </dd>
        </div>
      </dl>
      <p className="sh-claim__fineprint">
        The conversion settles your whole claimable {quote} when the claim executes. If it cannot pay at least the minimum
        by the deadline, the transaction reverts and your claim stays intact.
      </p>
    </section>
  );
}

/**
 * No current quote, so no conversion can start. `expired`: the demo's one quote passed its deadline on the demo clock.
 * `lapsed`: a request saw the deadline pass before it was signed (e.g. the "quote deadline passes" demo scenario), so
 * the quote it was built on is treated as stale here too until the estimate is refreshed.
 */
export function NeedsQuote({ cause, onRefresh }: { cause: 'expired' | 'lapsed'; onRefresh: () => void }) {
  return (
    <div className="sh-account-notice" data-tone="warning" data-testid="needs-quote" data-quote-cause={cause}>
      <span className="sh-account-notice__mark" aria-hidden="true" />
      <div className="sh-account-notice__body">
        {cause === 'expired' ? (
          <p>
            <strong>No current quote.</strong> The last quote passed its deadline, so its estimate and minimum no longer
            apply. Your claim is unchanged.
            {DEMO_BUILD ? ' The snapshot has one fixed quote that expires 20 minutes into a visit (12:20 UTC snapshot time); reloading the page restarts the clock.' : null}
          </p>
        ) : (
          <p>
            <strong>No current quote.</strong> The quote deadline passed before the request was signed, so its estimate and
            minimum no longer apply. Nothing was signed and your claim is unchanged. Refresh the estimate to read a current
            quote.
          </p>
        )}
        <p>
          <button type="button" className="sh-button" onClick={onRefresh}>
            Refresh the estimate
          </button>
        </p>
      </div>
    </div>
  );
}

/** After a timeout, an unknown status or a replacement: re-read before a second request can start. */
export function NeedsReread({ onReread }: { onReread: () => void }) {
  return (
    <div className="sh-account-notice" data-tone="warning" data-testid="needs-reread">
      <span className="sh-account-notice__mark" aria-hidden="true" />
      <div className="sh-account-notice__body">
        <p>
          <strong>Waiting for the earlier request’s result.</strong> It may still be included. Re-read your claims before
          claiming again: if it was included after all, this claim is already settled and a second request would only be
          refused.
        </p>
        <p>
          <button type="button" className="sh-button" onClick={onReread}>
            Re-read my claims
          </button>
        </p>
      </div>
    </div>
  );
}

/** Published emergency terms (05-ECONOMICS): shown only when the conversion is unavailable, always labelled. */
export function EmergencySettlement({ fallback, pair }: { fallback: DirectSourceFallback; pair: PairRecord }) {
  const headingId = useId();
  const token = displaySymbol(pair.token.symbol);
  const quote = displaySymbol(fallback.payoutAsset.symbol);
  return (
    <section className="sh-claim__fallback" aria-labelledby={headingId} data-testid="emergency-settlement">
      <p className="sh-claim__subhead">
        <span id={headingId}>Emergency settlement: {quote} paid directly</span>{' '}
        <span className="sh-chip sh-chip--pending">Fallback</span>
      </p>
      <p>
        The conversion to {token} is unavailable right now. The published emergency terms let you claim your credited {quote}{' '}
        directly instead. This is not the normal payout: you receive {quote}, not {token}. Your entitlement is unchanged,
        and you can also wait until the conversion is available again.
      </p>
      <dl className="sh-claim__terms">
        <div>
          <dt>Paid directly</dt>
          <dd>
            <Amount raw={fallback.payoutRaw} asset={fallback.payoutAsset} />
          </dd>
        </div>
      </dl>
    </section>
  );
}

/** Settled and reverted attempts, oldest first. A reverted attempt consumed nothing (ECO-07). */
export function ClaimHistory({ claim, pair }: { claim: ClaimView; pair: PairRecord }) {
  if (claim.history.length === 0) return null;
  return (
    <details className="sh-claim__history">
      <summary>
        Claim history <span className="sh-numeric">({claim.history.length})</span>
      </summary>
      <ol className="sh-claim__history-list">
        {claim.history.map((entry, index) => (
          <li key={`${entry.block}-${index}`} data-outcome={entry.outcome}>
            <span className="sh-claim__history-when">
              <time dateTime={entry.at}>{formatAsOf(entry.at) ?? entry.at}</time> · block{' '}
              <span className="sh-numeric">{formatInteger(entry.block)}</span>
            </span>
            {entry.outcome === 'settled' ? (
              <span>
                Settled {formatAmount(entry.qConsumedRaw, pair.quote)}, paid {formatAmount(entry.payoutRaw, entry.payoutAsset)}
              </span>
            ) : (
              <span>
                Reverted: nothing was consumed or paid
                {entry.reason ? ` (${explainReason(entry.reason)})` : ''}
              </span>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Every digit of the figures above (display values truncate and never overstate), with the current quote if any. */
export function ExactFigures({ claim, pair, estimate }: { claim: ClaimView; pair: PairRecord; estimate: ConvertibleEstimate | null }) {
  const rows: [string, string][] = [
    ['Claimable now', exactAmount(claim.claimableQRaw, pair.quote)],
    ['Already claimed', exactAmount(claim.claimedQRaw, pair.quote)],
    ['Credited in total', exactAmount(claim.earnedQRaw, pair.quote)],
    ['Pending harvest', exactAmount(claim.pendingHarvestQRaw, pair.quote)],
  ];
  // Only a current quote (a stale one is not an estimate).
  if (estimate) {
    rows.push(['Estimated payout', exactAmount(estimate.payoutRaw, pair.token)]);
    rows.push(['Minimum you sign', exactAmount(estimate.minPayoutRaw, pair.token)]);
  }
  return (
    <details className="sh-claim__exact">
      <summary>Exact figures</summary>
      <dl className="sh-claim__exact-list">
        {rows.map(([term, value]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd className="sh-numeric">{value}</dd>
          </div>
        ))}
        <div>
          <dt>Read at block</dt>
          <dd className="sh-numeric">{formatInteger(claim.asOfBlock)}</dd>
        </div>
      </dl>
    </details>
  );
}

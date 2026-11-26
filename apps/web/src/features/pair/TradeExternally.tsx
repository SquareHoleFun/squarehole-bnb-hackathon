import type { ExternalDestination, ExternalLinkProvider, FeeTerms, PairRecord, RouteState } from '@squarehole/domain';
import { renderableHref } from '@squarehole/links';
import { useDataSource } from '../data-source';
import { RouteReadyIcon, UnverifiedIcon } from '../feed/feed-icons';
import { displaySymbol } from '../feed/format';
import { CopyButton } from './CopyButton';
import { amountSymbol, feeTermsText, networkLabel } from './pair-model';
import { ExternalIcon, InfoIcon } from './pair-icons';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

const KIND_LABELS: Readonly<Record<ExternalDestination['kind'], string>> = {
  execution: 'Execution venue',
  discovery: 'Market information',
  explorer: 'Contracts on a block explorer',
};

const STATE_TEXT: Readonly<Record<RouteState, string>> = {
  unverified: 'Route unverified',
  unavailable: 'Route unavailable',
  available: 'Route verified',
};

function Destination({ destination, pair }: { destination: ExternalDestination; pair: PairRecord }) {
  // Render boundary (EXT-02/03/08): a link only for an available, allowlisted, identity-matching destination.
  const link = renderableHref(destination, pair);
  const kind = KIND_LABELS[destination.kind];
  return (
    <li className="sh-destination" data-kind={destination.kind} data-route={link ? 'available' : destination.state}>
      <span className="sh-destination__icon">
        <ExternalIcon />
      </span>
      <div className="sh-destination__body">
        <p className="sh-destination__title">
          {link ? (
            <a href={link.href} target="_blank" rel="noopener noreferrer" className="sh-destination__link">
              Open {destination.provider}
              <span className="sh-visually-hidden"> ({kind}, opens {link.host} in a new tab)</span>
            </a>
          ) : (
            <span className="sh-destination__provider">{destination.provider}</span>
          )}
          <span className="sh-destination__kind">{kind}</span>
        </p>
        {link ? <p className="sh-destination__host">{link.host}</p> : null}
        <p className="sh-route" data-route={link ? 'available' : destination.state}>
          {link ? <RouteReadyIcon /> : <UnverifiedIcon />}
          {link ? STATE_TEXT.available : STATE_TEXT[destination.state === 'available' ? 'unverified' : destination.state]}
        </p>
        {!link ? <p className="sh-destination__reason">{destination.reason ?? 'Not verified.'}</p> : null}
      </div>
    </li>
  );
}

interface TradeExternallyProps {
  pair: PairRecord;
  links: ExternalLinkProvider;
  feeTerms: FeeTerms;
  /** NFT collections get the "before you trade externally" notice (01-PRODUCT). */
  nftNotice: boolean;
}

/**
 * Replaces the reference image's trade panel (REFERENCE_OVERRIDES): destinations from the link provider, the exact
 * identity to check at any venue, and the fee policy. No amount field, no swap, no wallet request (EXT-01, EXT-04).
 */
export function TradeExternally({ pair, links, feeTerms, nftNotice }: TradeExternallyProps) {
  const demo = useDataSource().isDemo && DEMO_BUILD;
  const destinations = links.destinations(pair);
  const tSymbol = amountSymbol(pair.token.symbol);
  const qSymbol = displaySymbol(pair.quote.symbol);
  return (
    <section className="sh-detail-card sh-trade" aria-labelledby="trade-title">
      <h2 id="trade-title" className="sh-detail-card__title">
        Trade externally
      </h2>
      <p className="sh-detail-card__lede">
        Square Hole has no trade form. Trading only happens on external venues, and a destination becomes a link only
        after a recorded test shows the route works for this exact pair.
      </p>
      <ul className="sh-destinations" aria-label="External destinations">
        {destinations.map((destination) => (
          <Destination key={destination.kind} destination={destination} pair={pair} />
        ))}
      </ul>

      <h3 className="sh-detail-card__subtitle">Exact identity to check at any venue</h3>
      <dl className="sh-identity">
        <div>
          <dt>Network</dt>
          <dd>
            {networkLabel(pair.chainId, !demo)} <span className="sh-muted">(chain id {pair.chainId})</span>
          </dd>
        </div>
        <div>
          <dt>{tSymbol} token (T)</dt>
          <dd className="sh-identity__address">
            <code>{pair.token.address}</code>
            <CopyButton value={pair.token.address} label={`Copy ${tSymbol} (T) address`} />
          </dd>
        </div>
        <div>
          <dt>{qSymbol} (Q)</dt>
          <dd className="sh-identity__address">
            <code>{pair.quote.address}</code>
            <CopyButton value={pair.quote.address} label={`Copy ${qSymbol} (Q) address`} />
          </dd>
        </div>
        <div>
          <dt>Pool</dt>
          <dd className="sh-muted">
            {demo ? 'Not in this snapshot.' : 'The pool is identified by its id in the registry record, not shown here.'} A pool is never guessed
            from the token addresses.
          </dd>
        </div>
      </dl>

      <p className="sh-fee-terms">
        <span className="sh-fee-terms__label">Fee terms</span>
        <span>{feeTermsText(feeTerms)}</span>
      </p>

      {nftNotice ? (
        <aside className="sh-notice-card" aria-labelledby="before-trade-title">
          <InfoIcon />
          <div>
            <h3 id="before-trade-title" className="sh-notice-card__title">
              Before you trade externally
            </h3>
            <p>
              Your NFTs follow your {tSymbol} balance. When a trade or transfer takes it below a whole number of NFT
              units, an NFT leaves your wallet, and it may not be the one you would pick. Protecting a chosen NFT is not
              available in this app yet.
            </p>
          </div>
        </aside>
      ) : null}
    </section>
  );
}

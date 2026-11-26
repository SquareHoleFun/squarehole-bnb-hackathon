import { PairAvatar } from '@squarehole/design';
import { pairRoute, type ExternalLinkProvider, type PairRecord, type Position } from '@squarehole/domain';
import { routeSummary } from '@squarehole/links';
import { useId } from 'react';
import { Link } from 'react-router';
import { Amount } from '../accounts';
import { useDataSource } from '../data-source';
import { displaySymbol } from '../feed/format';
import { RouteStatus } from '../feed/pair-parts';
import { toPositionView } from './portfolio-model';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

interface PositionCardProps {
  readonly position: Position;
  readonly pair: PairRecord;
  readonly links: ExternalLinkProvider;
}

/**
 * One economic balance, shown once, with its whole-collectible representation beneath (01-PRODUCT Portfolio). Links go
 * to the read-only pair detail and this pair's claims; the external route status is shown, never a trade control.
 */
export function PositionCard({ position, pair, links }: PositionCardProps) {
  const titleId = useId();
  const source = useDataSource();
  const view = toPositionView(position, pair);
  const symbol = displaySymbol(pair.token.symbol);
  return (
    <article className="sh-position sh-panel" aria-labelledby={titleId} data-pair-id={pair.pairId}>
      <div className="sh-position__header">
        <PairAvatar pairId={pair.pairId} size={56} decorative />
        <div className="sh-position__identity">
          <h3 id={titleId} className="sh-position__title">
            {pair.name} <span className="sh-position__symbol">{displaySymbol(pair.symbol)}</span>
          </h3>
          <p className="sh-position__meta">
            <span className="sh-type-badge" data-type={pair.type}>
              {pair.type === 'nft_collection' ? 'NFT collection' : 'Token'}
            </span>
            <span>Paired with {displaySymbol(pair.quote.symbol)}</span>
          </p>
        </div>
      </div>

      <dl className="sh-position__figures">
        <div className="sh-position__balance" data-figure="balance">
          <dt>Balance</dt>
          <dd>
            <Amount raw={position.balanceRaw} asset={pair.token} />
          </dd>
        </div>
        {view.nft ? (
          <div className="sh-position__nft" data-figure="representation">
            <dt>Held as</dt>
            <dd>
              <span>
                <span className="sh-numeric">{view.nft.wholeText}</span>
                {view.nft.fractionText ? (
                  <>
                    {' + '}
                    <span className="sh-numeric">{view.nft.fractionText}</span>, not yet a whole NFT
                  </>
                ) : null}
              </span>
              <span className="sh-position__note">
                The same {symbol} as the balance above, not extra. {view.nft.unitText}.
              </span>
            </dd>
          </div>
        ) : (
          <div className="sh-position__nft" data-figure="representation">
            <dt>Held as</dt>
            <dd>Tokens only (no NFT representation)</dd>
          </div>
        )}
        {view.nft ? (
          <div data-figure="nft-ids">
            <dt>NFT ids</dt>
            <dd>
              {view.nft.ids.length > 0 ? (
                <ul className="sh-position__ids" aria-label={`${pair.name} NFT ids`}>
                  {view.nft.ids.map((id) => (
                    <li key={id} className="sh-numeric">
                      {id}
                    </li>
                  ))}
                </ul>
              ) : (
                <span>None listed</span>
              )}
              {view.nft.unlistedWhole > 0n ? (
                <span className="sh-position__note">
                  {view.nft.unlistedWhole.toString()} whole {view.nft.unlistedWhole === 1n ? 'unit has' : 'units have'} no id
                  listed {DEMO_BUILD && source.isDemo ? 'in this snapshot (for example, NFTs from a claim, or an account that skips NFTs)' : 'by the collection (for example, an account that skips NFTs)'}.
                </span>
              ) : null}
            </dd>
          </div>
        ) : null}
        {DEMO_BUILD && source.isDemo ? (
          <div data-figure="demo-value">
            <dt>Value</dt>
            <dd>
              {view.demoValue ? (
                <>
                  <span className="sh-numeric">≈ {view.demoValue.value}</span>
                  <span className="sh-position__note">
                    at the snapshot price of {view.demoValue.price} per {symbol}; not a quote
                  </span>
                </>
              ) : (
                <span className="sh-na">No price in the snapshot</span>
              )}
            </dd>
          </div>
        ) : (
          <div data-figure="value">
            <dt>Value</dt>
            <dd>
              <span className="sh-na">No USD value: no USD source is adopted for test chains</span>
            </dd>
          </div>
        )}
      </dl>

      <div className="sh-position__actions">
        <Link to={pairRoute(pair)} className="sh-view-link" aria-label={`Pair detail: ${pair.name}`}>
          Pair detail
        </Link>
        <Link to={`/rewards?pair=${encodeURIComponent(pair.pairId)}`} className="sh-view-link" aria-label={`Claims for ${pair.name}`}>
          Claims
        </Link>
        <RouteStatus route={routeSummary(links.destinations(pair))} />
      </div>
    </article>
  );
}

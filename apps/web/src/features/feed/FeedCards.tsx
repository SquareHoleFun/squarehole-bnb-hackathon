import { PairAvatar } from '@squarehole/design';
import type { Ref } from 'react';
import { Link } from 'react-router';
import type { PairView } from './format';
import { RESULTS_LABEL } from './FeedTable';
import { Age, ChainPriceLine, MarketFigure, MatchTag, PairingLine, RewardLine, RouteStatus, ShowcaseNote, TypeBadge } from './pair-parts';

interface FeedCardsProps {
  rows: readonly PairView[];
  busy: boolean;
  loading: boolean;
  resultsRef?: Ref<HTMLElement>;
}

function Card({ view }: { view: PairView }) {
  return (
    <li className="sh-card" data-pair-id={view.pairId}>
      <div className="sh-card__head">
        <PairAvatar pairId={view.pairId} size={44} decorative className="sh-card__avatar" />
        <div className="sh-card__title">
          <p className="sh-project__title">
            {/* The name link stretches over the whole card, so the card is one large tap target. */}
            <Link to={view.href} className="sh-project__name sh-card__link">
              {view.name}
            </Link>
            <span className="sh-project__symbol">{view.symbol}</span>
          </p>
          <p className="sh-project__meta">
            <TypeBadge view={view} />
            <span className="sh-project__lifecycle">{view.lifecycleLabel}</span>
          </p>
        </div>
      </div>
      <p className="sh-card__badges">
        <PairingLine view={view} />
        <RewardLine view={view} />
        <ChainPriceLine view={view} />
      </p>
      <dl className="sh-card__metrics">
        <div>
          <dt>Market cap</dt>
          <dd>
            <MarketFigure usd={view.marketCap} q={view.chain?.marketCap} />
          </dd>
        </div>
        <div>
          <dt>24h turnover</dt>
          <dd>
            <MarketFigure usd={view.turnover24h} q={view.chain?.turnover} />
          </dd>
        </div>
        <div>
          <dt>Age</dt>
          <dd>
            <Age view={view} />
          </dd>
        </div>
      </dl>
      <p className="sh-card__foot">
        <RouteStatus route={view.route} />
        {view.showcase ? <ShowcaseNote /> : null}
        <MatchTag view={view} />
      </p>
    </li>
  );
}

function SkeletonCard() {
  return (
    <li className="sh-card sh-card--skeleton" aria-hidden="true">
      <div className="sh-card__head">
        <span className="sh-skeleton sh-skeleton--avatar" />
        <span className="sh-skeleton sh-skeleton--text" />
      </div>
      <span className="sh-skeleton sh-skeleton--wide" />
      <span className="sh-skeleton sh-skeleton--wide" />
    </li>
  );
}

/** Narrow results column (< TABLE_MIN_WIDTH): full-width cards, never a sideways-scrolling table (02-DESIGN). */
export function FeedCards({ rows, busy, loading, resultsRef }: FeedCardsProps) {
  return (
    <ul
      ref={resultsRef as Ref<HTMLUListElement>}
      className="sh-cards"
      aria-label={RESULTS_LABEL}
      aria-busy={busy || loading}
      tabIndex={-1}
      data-dimmed={busy && !loading ? 'true' : undefined}
    >
      {loading ? Array.from({ length: 4 }, (_, index) => <SkeletonCard key={index} />) : rows.map((view) => <Card key={view.pairId} view={view} />)}
    </ul>
  );
}

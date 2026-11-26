import { PairAvatar } from '@squarehole/design';
import type { FeedSort } from '@squarehole/domain';
import type { Ref } from 'react';
import { Link } from 'react-router';
import { ArrowRightIcon, SortArrowIcon } from './feed-icons';
import type { PairView } from './format';
import { Age, ChainPriceLine, MarketFigure, MatchTag, Metric, PairingLine, RewardLine, RouteStatus, ShowcaseNote, TypeBadge } from './pair-parts';

export const RESULTS_LABEL = 'Launched pairs';
const SKELETON_ROWS = 8;

interface ResultsProps {
  rows: readonly PairView[];
  sort: FeedSort;
  busy: boolean;
  loading: boolean;
  resultsRef?: Ref<HTMLElement>;
}

function SortHeader({ label, active, direction }: { label: string; active: boolean; direction: 'down' | 'up' }) {
  return (
    <span className="sh-th">
      {label}
      {active ? <SortArrowIcon direction={direction} /> : null}
    </span>
  );
}

function Row({ view }: { view: PairView }) {
  return (
    <tr className="sh-row" data-pair-id={view.pairId}>
      <td className="sh-row__project">
        <div className="sh-project">
          <PairAvatar pairId={view.pairId} size={40} decorative className="sh-project__avatar" />
          <div className="sh-project__text">
            <p className="sh-project__title">
              <Link to={view.href} className="sh-project__name">
                {view.name}
              </Link>
              <span className="sh-project__symbol">{view.symbol}</span>
            </p>
            <p className="sh-project__meta">
              <TypeBadge view={view} />
              {view.showcase ? <ShowcaseNote /> : null}
            </p>
          </div>
        </div>
      </td>
      <td className="sh-row__pair">
        <span className="sh-row__pairline">
          <PairingLine view={view} />
          <span className="sh-project__lifecycle">{view.lifecycleLabel}</span>
        </span>
        <RewardLine view={view} />
        <ChainPriceLine view={view} />
        <MatchTag view={view} />
      </td>
      <td className="sh-num">
        <MarketFigure usd={view.marketCap} q={view.chain?.marketCap} />
      </td>
      <td className="sh-num">
        <MarketFigure usd={view.turnover24h} q={view.chain?.turnover} />
      </td>
      <td className="sh-num sh-col-holders">
        <Metric value={view.holders} />
      </td>
      <td className="sh-num">
        <Age view={view} />
      </td>
      <td className="sh-row__action">
        <div className="sh-action">
          <Link to={view.href} className="sh-view-link" aria-label={`View ${view.name} details`}>
            View
            <ArrowRightIcon />
          </Link>
          <RouteStatus route={view.route} />
        </div>
      </td>
    </tr>
  );
}

function SkeletonRow() {
  return (
    <tr className="sh-row sh-row--skeleton" aria-hidden="true">
      <td className="sh-row__project">
        <div className="sh-project">
          <span className="sh-skeleton sh-skeleton--avatar" />
          <span className="sh-skeleton sh-skeleton--text" />
        </div>
      </td>
      <td>
        <span className="sh-skeleton sh-skeleton--text" />
        <span className="sh-skeleton sh-skeleton--line" />
      </td>
      <td className="sh-num">
        <span className="sh-skeleton sh-skeleton--num" />
      </td>
      <td className="sh-num">
        <span className="sh-skeleton sh-skeleton--num" />
      </td>
      <td className="sh-num sh-col-holders">
        <span className="sh-skeleton sh-skeleton--num" />
      </td>
      <td className="sh-num">
        <span className="sh-skeleton sh-skeleton--num" />
      </td>
      <td className="sh-row__action">
        <div className="sh-action">
          <span className="sh-skeleton sh-skeleton--button" />
          <span className="sh-skeleton sh-skeleton--route" />
        </div>
      </td>
    </tr>
  );
}

/**
 * Wide results column (≥ TABLE_MIN_WIDTH, see FeedPage): one semantic table with fixed column widths, so columns
 * never shift between sorts or result sets. The sticky header stays inside the page scroller.
 */
export function FeedTable({ rows, sort, busy, loading, resultsRef }: ResultsProps) {
  return (
    <table
      ref={resultsRef as Ref<HTMLTableElement>}
      className="sh-table"
      aria-label={RESULTS_LABEL}
      aria-busy={busy || loading}
      tabIndex={-1}
      data-dimmed={busy && !loading ? 'true' : undefined}
    >
      <thead>
        <tr>
          <th scope="col" className="sh-col-project">
            Project
          </th>
          <th scope="col" className="sh-col-pair">
            Pair &amp; fee share
          </th>
          <th scope="col" className="sh-num sh-col-cap" aria-sort={sort === 'market_cap' ? 'descending' : undefined}>
            <SortHeader label="Market cap" active={sort === 'market_cap'} direction="down" />
          </th>
          <th scope="col" className="sh-num sh-col-turnover" aria-sort={sort === 'turnover' ? 'descending' : undefined}>
            <SortHeader label="24h turnover" active={sort === 'turnover'} direction="down" />
          </th>
          <th scope="col" className="sh-num sh-col-holders">
            Holders
          </th>
          <th scope="col" className="sh-num sh-col-age" aria-sort={sort === 'new' ? 'ascending' : undefined}>
            <SortHeader label="Age" active={sort === 'new'} direction="up" />
          </th>
          <th scope="col" className="sh-row__action sh-col-action">
            <span className="sh-visually-hidden">Details and route</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {loading
          ? Array.from({ length: SKELETON_ROWS }, (_, index) => <SkeletonRow key={index} />)
          : rows.map((view) => <Row key={view.pairId} view={view} />)}
      </tbody>
    </table>
  );
}

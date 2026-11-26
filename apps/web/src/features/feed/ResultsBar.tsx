import type { FeedSort } from '@squarehole/domain';
import { RefreshIcon } from './feed-icons';
import type { ResultsKind } from './feed-state';
import { formatAsOf, formatPairCount } from './format';

const SORT_TEXT: Readonly<Record<FeedSort, string>> = {
  market_cap: 'By market cap, highest first',
  new: 'Newest launches first',
  turnover: 'By 24h turnover, highest first',
};

/** A USD sort on a chain source without USD figures: the rows are in launch order, and the bar says so. */
const NO_USD_TEXT: Readonly<Record<Exclude<FeedSort, 'new'>, string>> = {
  market_cap: 'No USD market cap on this test chain: ordered by launch time, newest first',
  turnover: 'No USD turnover on this test chain: ordered by launch time, newest first',
};

interface ResultsBarProps {
  kind: ResultsKind;
  totalMatches: number;
  sort: FeedSort;
  /** The chosen USD sort has no USD figures to rank by (chain sources): the rows are in launch order. */
  usdUnavailable?: boolean;
  /** How an address search matched ("5 pairs paired with this quote address (AAPLx-DEMO)"), or null. */
  matchSummary: string | null;
  update: { available: boolean; asOf: string | null; apply: () => void };
}

function countText(kind: ResultsKind, totalMatches: number): string {
  if (kind === 'loading') return 'Loading pairs…';
  if (kind === 'unavailable') return 'Pairs unavailable';
  return formatPairCount(totalMatches);
}

/** Organic result count (the page's one live status), sort description and the "ranking updated" affordance. */
export function ResultsBar({ kind, totalMatches, sort, usdUnavailable = false, matchSummary, update }: ResultsBarProps) {
  const updatedAt = update.asOf ? formatAsOf(update.asOf) : null;
  return (
    <div className="sh-results-bar">
      <p className="sh-results-bar__count" role="status">
        {countText(kind, totalMatches)}
      </p>
      <p className="sh-results-bar__sort" data-usd-ranking={sort === 'new' ? undefined : usdUnavailable ? 'unavailable' : 'ranked'}>
        {sort !== 'new' && usdUnavailable ? (
          NO_USD_TEXT[sort]
        ) : (
          <>
            {SORT_TEXT[sort]}
            {sort === 'new' ? null : <span className="sh-results-bar__nulls"> · unavailable figures last</span>}
          </>
        )}
      </p>
      {matchSummary ? <p className="sh-results-bar__match">{matchSummary}</p> : null}
      {/* Polite live region that is always present, so the offer is announced when it appears (the count stays the
          page's one status). */}
      <div className="sh-update" aria-live="polite">
        {update.available ? (
          <>
            <span className="sh-update__text">Ranking updated{updatedAt ? ` at ${updatedAt.split(', ')[1] ?? updatedAt}` : ''}.</span>
            <button type="button" className="sh-button sh-button--accent sh-update__button" onClick={update.apply}>
              <RefreshIcon />
              Show updated ranking
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

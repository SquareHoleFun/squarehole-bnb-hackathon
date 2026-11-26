import { CastCharacter } from '@squarehole/design';
import { Link } from 'react-router';
import { RefreshIcon, WarningIcon } from './feed-icons';
import type { FeedNotices } from './feed-state';
import { formatAsOf } from './format';

interface NoMatchProps {
  query: string;
  filtersActive: boolean;
  onClearSearch: () => void;
  onResetFilters: () => void;
}

/** Empty search/filter result (SH-007). The joke is about shapes, never about money. */
export function NoMatch({ query, filtersActive, onClearSearch, onResetFilters }: NoMatchProps) {
  return (
    <div className="sh-empty sh-panel">
      <CastCharacter id="sorter" size={84} caption={false} className="sh-empty__art" />
      <div className="sh-empty__body">
        <h2 className="sh-empty__title">No pairs match</h2>
        <p>
          {query ? (
            <>
              Nothing has a name, ticker or address matching <q className="sh-empty__query">{query}</q>
              {filtersActive ? ' with these filters.' : '.'}
            </>
          ) : (
            'Nothing launched fits these filters.'
          )}{' '}
          The Sorter checked the square hole anyway.
        </p>
        <p className="sh-empty__actions">
          {query ? (
            <button type="button" className="sh-button" onClick={onClearSearch}>
              Clear search
            </button>
          ) : null}
          {filtersActive ? (
            <button type="button" className="sh-button" onClick={onResetFilters}>
              Reset filters
            </button>
          ) : null}
        </p>
      </div>
    </div>
  );
}

export function NoLaunches() {
  return (
    <div className="sh-empty sh-panel">
      <CastCharacter id="sorter" size={84} caption={false} className="sh-empty__art" />
      <div className="sh-empty__body">
        <h2 className="sh-empty__title">No launches yet</h2>
        <p>Only the platform is here so far. Launched tokens and NFT collections will be listed as they arrive.</p>
        <p className="sh-empty__joke">Where will they all go? That’s right. The square hole.</p>
        <p className="sh-empty__actions">
          <Link to="/create" className="sh-button">
            Launch a box
          </Link>
        </p>
      </div>
    </div>
  );
}

export function FeedUnavailable({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  return (
    <div className="sh-alert sh-panel" role="alert">
      <WarningIcon />
      <div className="sh-alert__body">
        <h2 className="sh-alert__title">Feed unavailable</h2>
        <p>The feed can’t be read right now. Nothing is shown as empty or zero in its place.</p>
        <p className="sh-empty__actions">
          <button type="button" className="sh-button" onClick={onRetry} disabled={retrying} aria-busy={retrying}>
            <RefreshIcon />
            Try again
          </button>
        </p>
      </div>
    </div>
  );
}

/** Stale / partial snapshot notices (FEED-06). Plain text, not live regions: the result count is the one status. */
export function SnapshotNotices({ notices }: { notices: FeedNotices }) {
  if (!notices.stale && !notices.partial) return null;
  return (
    <div className="sh-notices">
      {notices.stale ? (
        <p className="sh-notice" data-notice="stale">
          <WarningIcon />
          <span>
            <strong>Stale data</strong> · last updated <time dateTime={notices.stale.asOf}>{formatAsOf(notices.stale.asOf)}</time>
            {notices.stale.blockNumber ? ` (block ${notices.stale.blockNumber})` : ''}. Figures may have moved, and later launches
            are missing.
          </span>
        </p>
      ) : null}
      {notices.partial ? (
        <p className="sh-notice" data-notice="partial">
          <WarningIcon />
          <span>
            <strong>Partial coverage</strong> · some markets are not indexed yet. Missing figures show “—” and sort last; they
            are never counted as zero.
          </span>
        </p>
      ) : null}
    </div>
  );
}

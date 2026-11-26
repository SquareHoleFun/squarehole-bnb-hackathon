import type { AssetIdentity } from '@squarehole/domain';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { SearchIcon } from '../../shell/icons';
import { FEED_SEARCH_ID } from '../../shell/search-focus';
import { MAX_QUERY_LENGTH, normaliseQuery } from '../../shell/search-url';
import { isRewardAddress, type FeedUrlState, type LifecycleFilter } from './feed-params';

/** Typing updates `?q=` (history replace) after this pause. */
export const SEARCH_DEBOUNCE_MS = 150;

export type FeedChange = (patch: Partial<FeedUrlState>, options: { replace: boolean }) => void;

const TYPE_GROUP_NAME = 'feed-type';

/**
 * Focuses the first filter control (the "All" asset type), which is always on the page. Used when the control that
 * was activated is about to unmount ("Reset filters"), so keyboard focus never falls back to the document.
 */
export function focusFirstFilter(): boolean {
  const input = document.querySelector<HTMLInputElement>(`input[name="${TYPE_GROUP_NAME}"][value="all"]`);
  if (!input) return false;
  input.focus();
  return true;
}

interface FeedControlsProps {
  /** Effective (sanitised) URL state. */
  state: FeedUrlState;
  /** Reward assets of the snapshot on screen (whole snapshot, not the page). */
  rewardAssets: readonly AssetIdentity[];
  onChange: FeedChange;
  /** Identity of the current history entry (react-router `location`); a new value means a navigation happened. */
  revision: unknown;
}

const SORT_OPTIONS = [
  { value: 'market_cap', label: 'Market cap' },
  { value: 'new', label: 'New' },
  { value: 'turnover', label: 'Turnover (24h)' },
] as const;

const TYPE_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'token', label: 'Tokens' },
  { value: 'nft_collection', label: 'NFT collections' },
] as const;

const LIFECYCLE_OPTIONS: readonly { value: LifecycleFilter; label: string }[] = [
  { value: 'all', label: 'Any lifecycle' },
  { value: 'curve', label: 'Bonding curve' },
  { value: 'graduating', label: 'Graduating' },
  { value: 'amm', label: 'AMM' },
];

interface SegmentedProps<T extends string> {
  name: string;
  label: string;
  options: readonly { readonly value: T; readonly label: string }[];
  value: T;
  onSelect: (value: T) => void;
}

/** Native radios (arrow keys move and select) styled as a segmented control. */
function Segmented<T extends string>({ name, label, options, value, onSelect }: SegmentedProps<T>) {
  return (
    <div role="radiogroup" aria-label={label} className="sh-segmented">
      {options.map((option) => (
        <label key={option.value} className="sh-segmented__option">
          <input
            className="sh-segmented__input"
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onSelect(option.value)}
          />
          <span className="sh-segmented__text">{option.label}</span>
        </label>
      ))}
    </div>
  );
}

/**
 * The feed's controls bar (SH-006): the one search field, the sort group, the type group and the fee-share and
 * lifecycle filters. It owns no query state: every change is reported and lands in the URL.
 */
export function FeedControls({ state, rewardAssets, onChange, revision }: FeedControlsProps) {
  const [text, setText] = useState(state.q);
  // `query`: last URL query seen; `committed`: last query this field wrote; `generation` counts external changes.
  const [seen, setSeen] = useState({ query: state.q, committed: state.q, generation: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef({ onChange, query: state.q });

  // Follow the URL (Back/Forward, "Clear search") unless the change is the echo of this field's own commit, so a
  // trailing space or a keystroke typed after a commit is never overwritten.
  if (state.q !== seen.query) {
    const echo = state.q === seen.committed;
    setSeen({ query: state.q, committed: echo ? seen.committed : state.q, generation: seen.generation + (echo ? 0 : 1) });
    if (!echo) setText(state.q);
  }

  useEffect(() => {
    latest.current = { onChange, query: state.q };
  });

  // An external change of the query (and unmounting) cancels a commit that was still waiting.
  useEffect(() => () => clearTimeout(timer.current), [seen.generation]);

  function commit(raw: string) {
    clearTimeout(timer.current);
    const query = normaliseQuery(raw);
    if (query === latest.current.query) return;
    setSeen((current) => ({ ...current, committed: query }));
    latest.current.onChange({ q: query }, { replace: true });
  }

  function onType(value: string) {
    setText(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => commit(value), SEARCH_DEBOUNCE_MS);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    commit(text);
  }

  // A choice is shown at once: the URL change it causes commits in a router transition, and a controlled radio or
  // select would otherwise snap back until then. Any navigation (the choice landing, Back, Forward) supersedes it,
  // even one that returns to the same URL before React rendered the intermediate entry.
  const [chosen, setChosen] = useState<{ revision: unknown; patch: Partial<FeedUrlState> } | null>(null);
  if (chosen !== null && chosen.revision !== revision) setChosen(null);
  const shown: FeedUrlState = chosen !== null && chosen.revision === revision ? { ...state, ...chosen.patch } : state;

  const push = (patch: Partial<FeedUrlState>) => {
    setChosen((current) => ({ revision, patch: { ...(current !== null && current.revision === revision ? current.patch : {}), ...patch } }));
    onChange(patch, { replace: false });
  };
  const rewardListed = !isRewardAddress(shown.reward) || rewardAssets.some((a) => a.address.toLowerCase() === shown.reward);

  return (
    <div className="sh-feed-controls">
      {/* Search and sort share the first row; the filters wrap to their own row when the bar is narrow. */}
      <div className="sh-feed-controls__query">
        {/* Explicit role: the <search> element's implicit role is not yet exposed by every browser/AT combination. */}
        <search className="sh-feed-search" role="search">
          <form className="sh-feed-search__form" action="/" method="get" onSubmit={onSubmit}>
            <label htmlFor={FEED_SEARCH_ID} className="sh-visually-hidden">
              Search pairs
            </label>
            <span className="sh-feed-search__icon" aria-hidden="true">
              <SearchIcon />
            </span>
            <input
              id={FEED_SEARCH_ID}
              className="sh-feed-search__input"
              type="search"
              name="q"
              value={text}
              onChange={(event) => onType(event.target.value)}
              maxLength={MAX_QUERY_LENGTH}
              placeholder="Name, ticker, address"
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="search"
            />
          </form>
        </search>

        <Segmented name="feed-sort" label="Sort by" options={SORT_OPTIONS} value={shown.sort} onSelect={(sort) => push({ sort })} />
      </div>
      <div className="sh-feed-controls__filters">
        <Segmented name={TYPE_GROUP_NAME} label="Asset type" options={TYPE_OPTIONS} value={shown.type} onSelect={(type) => push({ type })} />

        <div className="sh-filter">
          <label className="sh-filter__label" htmlFor="feed-reward">
            Fee share in
          </label>
          <select
            id="feed-reward"
            className="sh-filter__select"
            value={shown.reward}
            onChange={(event) => push({ reward: event.target.value as FeedUrlState['reward'] })}
          >
            <option value="">Any asset</option>
            <option value="T">Own token (T)</option>
            {rewardAssets.map((asset) => (
              <option key={`${asset.chainId}:${asset.address}`} value={asset.address.toLowerCase()}>
                {asset.symbol}
              </option>
            ))}
            {rewardListed ? null : <option value={shown.reward}>Checking asset…</option>}
          </select>
        </div>

        <div className="sh-filter">
          <label className="sh-filter__label" htmlFor="feed-lifecycle">
            Lifecycle
          </label>
          <select
            id="feed-lifecycle"
            className="sh-filter__select"
            value={shown.lifecycle === 'all' ? '' : shown.lifecycle}
            onChange={(event) => push({ lifecycle: (event.target.value || 'all') as LifecycleFilter })}
          >
            {LIFECYCLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value === 'all' ? '' : option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

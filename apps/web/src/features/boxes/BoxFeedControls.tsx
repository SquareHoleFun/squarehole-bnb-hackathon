/**
 * The box feed's controls: one search field (the field the header's "Search boxes" focuses: `FEED_SEARCH_ID`), the state
 * chips with their counts, one sort and the Grid / List switch. Every control writes the URL (box-feed-params.ts);
 * nothing here asks a wallet for anything.
 */
import { useId, useState, type ChangeEvent } from 'react';
import { normaliseQuery } from '../../shell/search-url';
import { FEED_SEARCH_ID } from '../../shell/search-focus';
import { SearchIcon } from '../../shell/icons';
import { BOX_STATES, STATE_LABELS } from './box-model';
import type { BoxFeedUrlState, BoxSort, BoxView } from './box-feed-params';
import type { StateCounts } from './box-feed';
import { STATE_GLYPHS } from './BoxParts';

export type BoxFeedChange = (patch: Partial<BoxFeedUrlState>, options: { replace: boolean }) => void;

const SORT_LABELS: readonly (readonly [BoxSort, string])[] = [
  ['new', 'New'],
  ['progress', 'Progress'],
  ['mcap', 'FDV'],
  ['volume', '24h volume'],
];

const SORTS: ReadonlyMap<string, BoxSort> = new Map(SORT_LABELS.map(([value]) => [value, value]));

export interface BoxFeedControlsProps {
  readonly state: BoxFeedUrlState;
  readonly counts: StateCounts;
  /** Why the 24h volume sort is off, or null. */
  readonly volumeOff: string | null;
  readonly onChange: BoxFeedChange;
  /** False when the only result is a wallet: the state chips (all 0) would say nothing about it. */
  readonly chips?: boolean;
}

export function BoxFeedControls({ state, counts, volumeOff, onChange, chips = true }: BoxFeedControlsProps) {
  const sortId = useId();
  // The field keeps what is typed (a space between two words included); the URL keeps the normalised query. When the
  // URL changes from elsewhere (Back, "Clear"), the field follows it.
  const [draft, setDraft] = useState(state.q);
  const [seen, setSeen] = useState(state.q);
  if (seen !== state.q) {
    setSeen(state.q);
    if (normaliseQuery(draft) !== state.q) setDraft(state.q);
  }
  function onSort(event: ChangeEvent<HTMLSelectElement>) {
    const sort = SORTS.get(event.target.value);
    if (sort) onChange({ sort }, { replace: false });
  }
  const view = (next: BoxView) => onChange({ view: next }, { replace: false });
  return (
    <div className="sh-box-controls">
      <div className="sh-box-search" role="search">
        <SearchIcon />
        <label htmlFor={FEED_SEARCH_ID} className="sh-visually-hidden">
          Search boxes, tokens or a wallet
        </label>
        <input
          id={FEED_SEARCH_ID}
          type="search"
          value={draft}
          placeholder="Search boxes, tokens or a wallet"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setDraft(event.target.value);
            onChange({ q: event.target.value }, { replace: true });
          }}
        />
      </div>
      <div className="sh-box-chips" role="group" aria-label="State" hidden={!chips}>
        <button type="button" className="sh-box-chip" aria-pressed={state.state === 'all'} onClick={() => onChange({ state: 'all' }, { replace: false })}>
          All <span className="sh-box-chip__n">{counts.all}</span>
        </button>
        {BOX_STATES.map((id) => (
          <button key={id} type="button" className="sh-box-chip" data-state={id} aria-pressed={state.state === id} onClick={() => onChange({ state: id }, { replace: false })}>
            <svg className="sh-box-glyph" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
              {STATE_GLYPHS[id]}
            </svg>
            {STATE_LABELS[id]} <span className="sh-box-chip__n">{counts[id]}</span>
          </button>
        ))}
      </div>
      <div className="sh-box-tools">
        <span className="sh-box-sort">
          <label htmlFor={sortId} className="sh-visually-hidden">
            Sort
          </label>
          <select id={sortId} value={state.sort === 'volume' && volumeOff ? 'new' : state.sort} onChange={onSort}>
            {SORT_LABELS.map(([value, label]) => (
              <option key={value} value={value} disabled={value === 'volume' && volumeOff !== null}>
                {value === 'volume' && volumeOff !== null ? `${label} · not yet` : label}
              </option>
            ))}
          </select>
        </span>
        <div className="sh-box-seg" role="group" aria-label="View">
          <button type="button" aria-pressed={state.view === 'grid'} onClick={() => view('grid')}>
            Grid
          </button>
          <button type="button" aria-pressed={state.view === 'list'} onClick={() => view('list')}>
            List
          </button>
        </div>
      </div>
    </div>
  );
}

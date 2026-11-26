/**
 * SH-C review: on a chain source no USD figure exists (no USD source is adopted for test chains, ADR-0012), so a USD
 * sort is really launch order. The results bar says so, and only the Age column carries the sort mark and aria-sort.
 */
import type { PairRecord } from '@squarehole/domain';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { effectiveFeedSort } from './feed-state';
import { FeedTable } from './FeedTable';
import { ResultsBar } from './ResultsBar';

afterEach(cleanup);

const row = (usd: { marketCapUsd: string | null; turnover24hUsd: string | null }) => usd as unknown as PairRecord;
const NO_UPDATE = { available: false, asOf: null, apply: () => undefined };

describe('effectiveFeedSort', () => {
  it('a USD sort with no USD figure on a chain source is launch order', () => {
    const none = [row({ marketCapUsd: null, turnover24hUsd: null })];
    expect(effectiveFeedSort('market_cap', none, { chainSource: true })).toEqual({ sort: 'new', usdUnavailable: true });
    expect(effectiveFeedSort('turnover', [], { chainSource: true })).toEqual({ sort: 'new', usdUnavailable: true });
    expect(effectiveFeedSort('new', none, { chainSource: true })).toEqual({ sort: 'new', usdUnavailable: false });
  });

  it('keeps the chosen sort when a disclosed USD source gave figures, and always for the demo fixtures', () => {
    const priced = [row({ marketCapUsd: '120', turnover24hUsd: null }), row({ marketCapUsd: null, turnover24hUsd: null })];
    expect(effectiveFeedSort('market_cap', priced, { chainSource: true })).toEqual({ sort: 'market_cap', usdUnavailable: false });
    expect(effectiveFeedSort('turnover', priced, { chainSource: true })).toEqual({ sort: 'new', usdUnavailable: true });
    expect(effectiveFeedSort('market_cap', [row({ marketCapUsd: null, turnover24hUsd: null })], { chainSource: false })).toEqual({
      sort: 'market_cap',
      usdUnavailable: false,
    });
  });
});

describe('ResultsBar', () => {
  it('says the real order when USD ranking is unavailable', () => {
    render(<ResultsBar kind="results" totalMatches={3} sort="market_cap" usdUnavailable matchSummary={null} update={NO_UPDATE} />);
    const sort = document.querySelector('.sh-results-bar__sort');
    expect(sort?.textContent).toBe('No USD market cap on this test chain: ordered by launch time, newest first');
    cleanup();
    render(<ResultsBar kind="results" totalMatches={3} sort="turnover" usdUnavailable matchSummary={null} update={NO_UPDATE} />);
    expect(document.querySelector('.sh-results-bar__sort')?.textContent).toBe('No USD turnover on this test chain: ordered by launch time, newest first');
  });

  it('keeps the USD ranking text when it applies', () => {
    render(<ResultsBar kind="results" totalMatches={3} sort="market_cap" usdUnavailable={false} matchSummary={null} update={NO_UPDATE} />);
    expect(document.querySelector('.sh-results-bar__sort')?.textContent).toBe('By market cap, highest first · unavailable figures last');
  });
});

describe('FeedTable headers', () => {
  it('marks only the column the rows are ordered by', () => {
    render(
      <MemoryRouter>
        <FeedTable rows={[]} sort="new" busy={false} loading={false} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('columnheader', { name: /Market cap/ }).getAttribute('aria-sort')).toBeNull();
    expect(screen.getByRole('columnheader', { name: /24h turnover/ }).getAttribute('aria-sort')).toBeNull();
    expect(screen.getByRole('columnheader', { name: /Age/ }).getAttribute('aria-sort')).toBe('ascending');
    expect(screen.getByRole('columnheader', { name: /Market cap/ }).querySelector('svg')).toBeNull();
  });
});

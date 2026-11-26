import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router';
import { DEMO_FIT_TARGET, type FitMarketTarget } from '../fit-pair/fit-target';
import { parseSnapshotV2 } from '../core/v2/indexer-v2';
import { recordV2, summaryV2 } from '../core/v2/record-v2';
import { publishedV2 } from '../core/v2/test-support/published-v2';
import { BoxCard, BoxTable } from './BoxCard';
import type { BoxSummary } from './box-model';
import { launchRecord } from './box-sources';

/**
 * SH-224 phase 4 (re-review of phase 3): the feed card and the List row agree with the box page about "Rehearsal · test
 * set": a v1 rehearsal record (the first box's set-up with neutral names) keeps it; a core v2 box read from the local
 * source does not say it (its record carries the flag only for being local).
 */
afterEach(cleanup);

function shown(summary: BoxSummary) {
  const card = render(<MemoryRouter><ul><BoxCard summary={summary} to="/box/x" /></ul></MemoryRouter>);
  const link = card.container.querySelector('a.sh-box-card__link') as HTMLElement;
  const out = { label: link.getAttribute('aria-label') ?? '', meta: card.container.querySelector('.sh-box-card__meta')?.textContent ?? '', chip: card.container.querySelector('.sh-box-card__rehearsal') };
  cleanup();
  const table = render(<MemoryRouter><BoxTable rows={[{ summary, to: '/box/x' }]} /></MemoryRouter>);
  const row = table.container.querySelector('.sh-box-table__box small')?.textContent ?? '';
  return { ...out, row };
}

describe('SH-224: "Rehearsal · test set" on the feed', () => {
  it('a local core v2 box: no rehearsal words on its card, in its name or in its List row', async () => {
    const { body, source } = await publishedV2();
    expect(source.network).toBe('local');
    const view = { ...parseSnapshotV2(body, source), verified: true };
    const record = recordV2(view, source, null, 'tUSDC');
    expect(record.rehearsal).toBe(true);
    const card = shown(summaryV2(record, view, false));
    expect(card.chip).toBeNull();
    expect(card.meta).not.toMatch(/Rehearsal/);
    expect(card.label).not.toMatch(/Rehearsal/);
    expect(card.row).not.toMatch(/Rehearsal/);
  });

  it('a v1 rehearsal record (neutral names) keeps it on its card, in its name and in its List row', () => {
    const neutral: FitMarketTarget = {
      ...DEMO_FIT_TARGET,
      names: { kind: 'neutral', tokenName: 'Rehearsal Token 2', tokenSymbol: 'RHT2', collectionName: 'Rehearsal Collection', collectionSymbol: 'RHC', placeholderName: 'Rehearsal placeholder', placeholderSymbol: 'RHC-P', item: 'item', items: 'items' },
    };
    const record = launchRecord(neutral);
    expect(record.rehearsal).toBe(true);
    const summary: BoxSummary = { record, state: 'bonding', figure: { text: '30.5%', barBps: 3050 }, mcapRaw: null, progressBps: 3050, volumeRaw: null, notice: null };
    const card = shown(summary);
    expect(card.chip?.textContent).toBe(' · Rehearsal · test set');
    expect(card.label).toMatch(/, Rehearsal, test set$/);
    expect(card.row).toMatch(/ · Rehearsal$/);
  });
});

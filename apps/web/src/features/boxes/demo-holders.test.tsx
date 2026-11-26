/**
 * Holder claims on the Demo's own boxes (Pocket Stamps, Clay Pots) read as on a box created in the Demo (F74 U1;
 * SH-F74-polish item 11): "Pending legal review" beside the set-up in About, on the Owning one tile and on the Claims
 * counter; boxes without holder claims carry no such note.
 */
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { AboutPanel } from './AboutPanel';
import { countersFor } from './counters';
import { DEMO_BOXES } from './demo-boxes';

afterEach(cleanup);

const byTicker = (ticker: string) => {
  const record = DEMO_BOXES.find((box) => box.ticker === ticker);
  if (!record) throw new Error(`missing ${ticker}`);
  return record;
};

describe('holder claims on the Demo boxes', () => {
  it('About flags the set-up "Pending legal review", as a created box flags its side', () => {
    for (const ticker of ['STMP', 'POTS']) {
      const record = byTicker(ticker);
      render(
        <MemoryRouter>
          <AboutPanel record={record} state={record.demoState} target={null} launchContent={false} size={record.itemCount} />
        </MemoryRouter>,
      );
      const flags = [...document.querySelectorAll('.sh-box-about .sh-box-flag')].map((flag) => flag.textContent);
      expect(flags, ticker).toEqual(['Pending legal review']);
      cleanup();
    }
    const plain = byTicker('KITE');
    render(
      <MemoryRouter>
        <AboutPanel record={plain} state={plain.demoState} target={null} launchContent={false} size={plain.itemCount} />
      </MemoryRouter>,
    );
    expect(document.querySelectorAll('.sh-box-about .sh-box-flag')).toHaveLength(0);
  });

  it('the Claims counter gives the same words', () => {
    const claims = countersFor({ record: byTicker('POTS'), state: 'bonding', marketLink: null, marketReason: 'No links in Demo' }).find((counter) => counter.id === 'claims');
    expect(claims && 'reason' in claims ? claims.reason : null).toBe('Pending legal review');
  });
});

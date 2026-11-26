import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { placeholdersIn, termsTextOf } from './terms-common';
import { PRODUCTION_TERMS } from './terms-production';
import { TermsSections, TermsText } from './TermsText';

afterEach(cleanup);

/** The production Terms (SH-V2-FE7) through the pages' renderer: every open item marked, no raw markup left. */
describe('the production Terms, rendered', () => {
  it('shows all 18 sections and marks every placeholder, with nothing left unmarked', () => {
    const { container } = render(<TermsSections sections={PRODUCTION_TERMS.document.sections} />);
    for (const section of PRODUCTION_TERMS.document.sections) expect(screen.getByRole('heading', { level: 2, name: `${section.n}. ${section.title}` })).toBeTruthy();
    expect(container.textContent).not.toContain('**');
    const marks = Array.from(container.querySelectorAll('mark'), (mark) => mark.textContent ?? '');
    const sectionTexts = termsTextOf({ ...PRODUCTION_TERMS.gate, title: '', status: '', intro: '', bullets: [], checkbox: '', declined: '' }, { ...PRODUCTION_TERMS.document, status: '', disputeNotice: '', readFirst: { title: '', bullets: [] }, closing: '' });
    expect(marks).toEqual(placeholdersIn(sectionTexts));
    const clone = container.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('mark').forEach((mark) => mark.remove());
    expect(clone.textContent).not.toMatch(/\[(COUNSEL|FOUNDER|ENGINEERING)/);
  });

  it('marks the gate’s two open items: the sign-off and box 0’s mainnet addresses (SH-V2-FE9)', () => {
    const { container } = render(
      <ul>
        {[PRODUCTION_TERMS.gate.status, ...PRODUCTION_TERMS.gate.bullets].map((text) => (
          <li key={text}>
            <TermsText text={text} />
          </li>
        ))}
      </ul>,
    );
    const marks = Array.from(container.querySelectorAll('mark'), (mark) => mark.textContent ?? '');
    expect(marks.map((mark) => mark.slice(0, 30))).toEqual(['[FOUNDER + COUNSEL: delete thi', '[FOUNDER: box 0’s mainnet addr']);
    expect(container.textContent).toContain('At squarehole.fun, Square Hole runs on Ethereum mainnet only.');
  });
});

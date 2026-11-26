import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, type InitialEntry } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { TERMS_SECTIONS, TERMS_VERSION } from '../features/legal';
import { TermsPage } from './TermsPage';

afterEach(cleanup);

function renderPage(entry: InitialEntry = '/about/terms') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <TermsPage />
    </MemoryRouter>,
  );
}

/** A section card by its number (the cards are not landmarks; the id is the Contents anchor). */
const sectionText = (n: string) => document.getElementById(`terms-${n}`)?.textContent ?? '';

describe('/about/terms (F19)', () => {
  it('is the full draft Terms of Use, marked as a draft with its version', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Square Hole Terms of Use' })).toBeTruthy();
    expect(document.title).toBe('Terms of Use · Square Hole');
    const main = document.body.textContent ?? '';
    expect(main).toContain('DRAFT pending legal review. It may change, and you will be asked to accept the final version.');
    expect(main).toContain(`Version ${TERMS_VERSION} · Draft of 11 October 2026`);
    expect(main).toContain('DRAFT pending legal review. It may change before it is final.');
    expect(main).not.toMatch(/not in force|not legal advice/i);
  });

  it('shows "Read this first" and all 18 sections in order, each headed and anchored from the contents, without 18 landmarks', () => {
    const { container } = renderPage();
    expect(screen.getByRole('region', { name: 'Read this first' })).toBeTruthy();
    const headings = TERMS_SECTIONS.map((section) => screen.getByRole('heading', { level: 2, name: `${section.n}. ${section.title}` }));
    expect(headings.map((heading) => heading.closest('section')?.id)).toEqual(TERMS_SECTIONS.map((section) => section.id));
    expect(screen.getAllByRole('region').map((region) => region.getAttribute('aria-labelledby'))).toEqual(['page-title', 'terms-read-first']);
    const contents = screen.getByRole('navigation', { name: 'Contents' });
    expect(within(contents).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(TERMS_SECTIONS.map((section) => `#${section.id}`));
    expect(container.querySelectorAll('h2').length).toBe(TERMS_SECTIONS.length + 2);
  });

  it('renders bold text and marks every open placeholder, with no raw markup left', () => {
    const { container } = renderPage();
    expect(container.textContent).not.toContain('**');
    const marks = Array.from(container.querySelectorAll('mark'), (mark) => mark.textContent ?? '');
    expect(marks.length).toBeGreaterThan(30);
    for (const mark of marks) expect(mark).toMatch(/^\[(COUNSEL|FOUNDER|ENGINEERING)\b.*\]$/);
    // Outside the marks, no bracketed placeholder is left unmarked.
    const clone = container.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('mark').forEach((mark) => mark.remove());
    expect(clone.textContent).not.toMatch(/\[(COUNSEL|FOUNDER|ENGINEERING)/);
    expect(document.getElementById('terms-5')?.querySelectorAll('strong').length).toBeGreaterThan(10);
  });

  it('names the restricted places from the one list, and the age limit', () => {
    renderPage();
    const eligibility = sectionText('4');
    expect(eligibility).toContain('uses the Services from the United States, Canada or the United Kingdom');
    expect(eligibility).toContain('at least 18 years old');
    expect(eligibility).toContain('comprehensive sanctions or embargo');
  });

  it('describes burns, buybacks and the stream as mechanics that owe nothing and promise no yield, return or price (SEC staff FAQ Q2.5)', () => {
    renderPage();
    const services = sectionText('5');
    expect(services).toContain('It pays nobody and gives nobody a right to anything.');
    expect(services).toContain('Nobody promises that burns will happen, how large or how frequent they will be, or that they will bring profit, yield, return, income, a price rise or price support.');
    expect(services).toContain('Market prices can fall to zero however many tokens are burned.');
    expect(services).toContain('They are not interest, a dividend or a return on anything');
    expect(services).toContain('It is not income, interest, a dividend or a return on anything');
    expect(services).toContain('FIT holders receive no payouts.');
    expect(services).toContain('FIT’s only link to the vault is the vault’s rules (5.8)');
    const regulatory = sectionText('3');
    expect(regulatory).toContain('including staff guidance on token buybacks or burns, do not approve Square Hole');
    expect(document.body.textContent).not.toMatch(/\bAPY\b|\bAPR\b|guaranteed (returns?|yield|profit)/i);
  });

  it('states the test-only status: no mainnet deployment exists or is authorised, contracts not audited, the rest is planned', () => {
    renderPage();
    const services = sectionText('5');
    expect(services).toContain('Planned design (not deployed).');
    expect(services).toContain('gives you no right to any future token, NFT, allocation or airdrop');
    expect(services).toContain('The boxes this build shows on a local chain or on Sepolia are test deployments of the current box contracts');
    // F130: the development Terms name the sample data, never "Demo".
    expect(document.body.textContent).not.toMatch(/\bdemo\b/i);
    expect(services).toContain('No Square Hole contract is deployed on Ethereum mainnet or any other production network, and no such deployment is authorised.');
    expect(services).toContain('The smart contracts have not been audited or independently reviewed.');
  });

  it('links only inside the site: its own sections, the feed, About & risks and the privacy notice', () => {
    const { container } = renderPage();
    const hrefs = Array.from(container.querySelectorAll('a[href]'), (link) => link.getAttribute('href') ?? '');
    const outside = hrefs.filter((href) => !href.startsWith('#terms-') && href !== '/' && href !== '/about/risks' && href !== '/about/privacy');
    expect(outside).toEqual([]);
    expect(hrefs).toContain('/');
    expect(hrefs).toContain('/about/risks');
    expect(screen.getByRole('link', { name: 'Privacy notice' }).getAttribute('href')).toBe('/about/privacy');
    expect(container.querySelectorAll('button, input, select, textarea, iframe')).toHaveLength(0);
    expect(screen.getByRole('link', { name: 'Back to the feed' }).getAttribute('href')).toBe('/');
  });

  it('opened from the gate, leads back to the page the visitor asked for', () => {
    renderPage({ pathname: '/about/terms', state: { from: '/pair/31337/0x66?tab=nfts' } });
    expect(screen.getByRole('link', { name: 'Back to the page you opened' }).getAttribute('href')).toBe('/pair/31337/0x66?tab=nfts');
    expect(screen.queryByRole('link', { name: 'Back to the feed' })).toBeNull();
    cleanup();
    renderPage({ pathname: '/about/terms', state: { from: 'https://evil.example/' } });
    expect(screen.getByRole('link', { name: 'Back to the feed' }).getAttribute('href')).toBe('/');
  });
});

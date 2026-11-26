import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { DataSourceProvider, resetDataSourceForTests, saveDataSource, type DataSourceBuild, type DataSourceId } from '../features/data-source';
import { TERMS_SECTIONS } from '../features/legal';
import { appCopyFraming, renderedCopy, unnegatedReturnFraming } from '../features/legal/wording';
import { ABOUT_FACTS } from './about-facts';
import { PRODUCTION_TERMS } from '../features/legal/terms-production';
import { ABOUT_CARDS, MORE_RISKS, NO_TRADING_CARD, OUR_BOXES, TEST_TRADING_CARD, TRADING_CARD, termsLabel } from './about-content';
import { LinkOutGlyph } from './about-visuals';
import { AboutCard, OurBoxAddress, RisksPage } from './RisksPage';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  resetDataSourceForTests();
});

function renderPage() {
  return render(
    <MemoryRouter>
      <RisksPage />
    </MemoryRouter>,
  );
}

const REGISTRY = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const COMMIT = '097710ffe2e37e01bc88133f723041f165ea25a9';
const MANIFEST = { schema: 'squarehole.deployment/v1', status: 'deployed', gitCommit: COMMIT, gitDirty: false, contracts: { registry: { address: REGISTRY } } };

/** The page under a chain data source (the runtime is never loaded: the page needs no chain read). */
function renderOnSource(id: Exclude<DataSourceId, 'demo'>, registry = true) {
  const build: DataSourceBuild = {
    localManifest: id === 'local' ? MANIFEST : null,
    sepoliaManifest: id === 'sepolia' ? (registry ? { ...MANIFEST, gitDirty: null } : { ...MANIFEST, gitDirty: null, contracts: {} }) : null,
    localRpcUrl: 'http://127.0.0.1:8560',
  };
  saveDataSource(id);
  return render(
    <DataSourceProvider build={build} loader={() => Promise.reject(new Error('the risks page must not load the chain runtime'))}>
      <MemoryRouter>
        <RisksPage />
      </MemoryRouter>
    </DataSourceProvider>,
  );
}

const DEMO_ONLY = [/Mock data/, /Not deployed anywhere/, /This is a demo/, /invented demo data/, /No contract, pool or route shown here exists anywhere/, /Local chain/, /ORCHARD/];
/** The first handoff's pair model, its gates and its test assets: none of it is on the page any more (SH-V2-FE7). */
const FIRST_HANDOFF = /\bpairs?\b|paired|USDT-TEST|WETH9|AAPLx|\bG0[1-8]\b|production gates|3% target|Draft policy|realized Q|Decision records/i;
const TITLES = ['What’s a box', 'Curve & graduation', 'Fees & payouts', 'Failure & claim', 'Coins, stocks & gold', 'Box 0 · The Misfits', 'Our boxes', 'More risks', 'No trading here', 'Terms'];

/** A card's words outside its figures, pictures and details: what a visitor reads before opening anything. */
function visibleSentences(card: HTMLElement): string[] {
  const clone = card.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('details, dl, figure, [role="img"], ol, ul, img, h2, .sh-about-splits').forEach((node) => node.remove());
  return (clone.textContent ?? '').split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter((part) => /[.!?]$/.test(part));
}

describe('/about/risks (UI-03; SH-V2-FE7, core v2)', () => {
  it('the sample data: the status strip states its chain and time, no outside audit, no in-app trading and claim-only payouts; no Demo card or word (F130)', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'About & risks' })).toBeTruthy();
    const status = document.querySelector('.sh-risks__status')?.textContent ?? '';
    for (const expected of ['Local chain 31337', 'Fixed at 25 Sep 2026, 12:00 UTC', 'No outside audit', 'None today', 'Claim only']) {
      expect(status).toContain(expected);
    }
    expect(status).not.toContain('Test tokens');
    expect(status).not.toContain('Deployment');
    expect(screen.queryByRole('region', { name: 'This is a demo' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/\b(demo|mock)\b/i);
    expect(document.title).toBe('About & risks · Square Hole');
  });

  it('local anvil: the real chain, its manifest, test tokens of no value, and no Demo words', () => {
    renderOnSource('local');
    const status = document.querySelector('.sh-risks__status')?.textContent ?? '';
    const text = document.body.textContent ?? '';
    for (const pattern of DEMO_ONLY) expect(text).not.toMatch(pattern);
    expect(status).toContain('Local anvil chain (31337)');
    expect(status).toContain('Read from the chain; each page shows its block and time');
    expect(status).toContain(`Local anvil deployment (manifest commit ${COMMIT.slice(0, 10)})`);
    expect(status).toContain('Test tokensNo value');
    expect(screen.queryByRole('region', { name: 'This is a demo' })).toBeNull();
  });

  it('Sepolia: the testnet, its registry only when the manifest names one', () => {
    renderOnSource('sepolia');
    expect(document.body.textContent).toContain('Sepolia testnet (11155111)');
    expect(document.body.textContent).toContain(`Sepolia test deployment (registry ${REGISTRY})`);
    cleanup();
    resetDataSourceForTests();
    renderOnSource('sepolia', false);
    const status = document.querySelector('.sh-risks__status')?.textContent ?? '';
    expect(status).toContain('Sepolia testnet (11155111)');
    expect(status).not.toContain('Deployment');
    for (const pattern of DEMO_ONLY) expect(document.body.textContent).not.toMatch(pattern);
  });

  it('shows the core v2 story in ten cards, in order, and nothing of the first handoff’s pairs', () => {
    renderPage();
    const cards = Array.from(document.querySelectorAll<HTMLElement>('.sh-about-grid > .sh-about-card'));
    expect(cards.map((card) => card.querySelector('h2')?.textContent)).toEqual(TITLES);
    for (const title of TITLES) expect(screen.getByRole('region', { name: title })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(FIRST_HANDOFF);
    expect(document.querySelector('table')).toBeNull();
  });

  it('puts numbers first: every card leads with figures of at most three-word labels, and shows at most one sentence', () => {
    renderPage();
    for (const card of Array.from(document.querySelectorAll<HTMLElement>('.sh-about-card'))) {
      const title = card.querySelector('h2')?.textContent ?? '';
      expect(visibleSentences(card).length, title).toBeLessThanOrEqual(1);
      for (const label of Array.from(card.querySelectorAll('.sh-about-figure dt'), (dt) => dt.textContent ?? '')) {
        expect(label.split(/\s+/).length, `${title}: ${label}`).toBeLessThanOrEqual(3);
      }
      // A figure's value comes before its label on screen, its label first for screen readers.
      for (const figure of Array.from(card.querySelectorAll('.sh-about-figure'))) expect(Array.from(figure.children, (child) => child.tagName)).toEqual(['DT', 'DD']);
    }
    const figures = (title: string) => within(screen.getByRole('region', { name: title })).getAllByRole('definition').map((dd) => dd.textContent);
    expect(figures('Curve & graduation')).toEqual([ABOUT_FACTS.window, ABOUT_FACTS.deadlineRange, ABOUT_FACTS.raise, `${ABOUT_FACTS.taxFirst} → ${ABOUT_FACTS.taxLast}`]);
    expect(figures('Fees & payouts')).toEqual(['1%', '0', 'Claim only']);
    expect(figures('Failure & claim')).toEqual(['30–180 d', '7 d', '14 d', 'No expiry']);
    expect(figures('Box 0 · The Misfits')).toEqual(['1%', '25%', '5%', '0', '1,000,000,000']);
    // A long figure takes two columns and comes last, so the grid never reorders what a screen reader reads.
    for (const card of Array.from(document.querySelectorAll('.sh-about-figures'))) {
      const wide = Array.from(card.children, (figure) => figure.hasAttribute('data-wide'));
      expect(wide.slice(wide.indexOf(true)).every(Boolean) || !wide.includes(true)).toBe(true);
    }
  });

  it('draws the launch tax, the fee splits and the failure steps, each with its words', () => {
    renderPage();
    const curve = screen.getByRole('region', { name: 'Curve & graduation' });
    const tax = within(curve).getByRole('img', { name: /^Launch-window tax per 12 s step: 93\.2% at the start, falling over 32 steps to 8\.1%/ });
    expect(tax.querySelectorAll('.sh-about-tax__bar')).toHaveLength(32);
    const fees = screen.getByRole('region', { name: 'Fees & payouts' });
    // Every part named in words under its bar, not only by colour (WCAG 1.4.1); the bar itself is decoration.
    const split = (name: string) => within(within(fees).getByRole('list', { name })).getAllByRole('listitem').map((item) => item.textContent);
    expect(split('Other boxes · each side')).toEqual(['10/15 Creator’s choice', '2/15 FIT burn', '1/15 Square Hole', '2/15 Box pool']);
    expect(split('Box 0 · buys (ETH)')).toEqual(['11/15 FIT burn', '2/15 Square Hole', '2/15 Box pool']);
    expect(split('Box 0 · sells (FIT)')).toEqual(['13/15 Misfits stream', '2/15 Box pool']);
    expect(fees.querySelectorAll('.sh-about-split__bar[aria-hidden="true"]')).toHaveLength(3);
    const steps = within(screen.getByRole('region', { name: 'Failure & claim' })).getByRole('list', { name: 'After a missed deadline' });
    expect(within(steps).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['30–180 dDeadline', 'AnyoneClose box', 'No expiryClaim', 'UnclaimedLocked for good']);
  });

  it('keeps the details closed behind one disclosure per card, each pointing to a Terms section both builds have', () => {
    const { container } = renderPage();
    // Sections, never clause numbers: the development draft and the production text share only their 18 sections.
    const sections = new Set(TERMS_SECTIONS.map((section) => section.id));
    expect(PRODUCTION_TERMS.document.sections.map((section) => section.id)).toEqual(TERMS_SECTIONS.map((section) => section.id));
    expect(PRODUCTION_TERMS.document.sections.map((section) => section.title)).toEqual(TERMS_SECTIONS.map((section) => section.title));
    for (const copy of ABOUT_CARDS) {
      const card = screen.getByRole('region', { name: copy.title });
      const details = card.querySelector('details');
      expect(details?.open, copy.title).toBe(false);
      expect(details?.querySelector('summary')?.textContent).toBe(`Details: ${copy.title}`);
      for (const line of copy.details) expect(details?.textContent, line).toContain(line);
      expect(within(card).getByRole('link', { name: termsLabel(copy.terms) }).getAttribute('href')).toBe(`/about/terms#terms-${copy.terms[0] ?? ''}`);
      for (const n of copy.terms) expect(sections.has(`terms-${n}`), `${copy.title}: ${n}`).toBe(true);
      expect(termsLabel(copy.terms)).toMatch(/^Terms, Sections? \d+(?:(?:, \d+)* and \d+)?$/);
    }
    const more = screen.getByRole('region', { name: 'More risks' });
    expect(Array.from(more.querySelectorAll('summary'), (summary) => summary.textContent)).toEqual(MORE_RISKS.map((risk) => risk.label));
    // No summary or link names a trade action (the no-trade audit), and every link stays inside the site.
    for (const summary of Array.from(container.querySelectorAll('summary'))) expect(summary.textContent).not.toMatch(/\b(buy|sell|swap)\b/i);
    const hrefs = Array.from(container.querySelectorAll('a[href]'), (a) => a.getAttribute('href') ?? '');
    expect(hrefs.filter((href) => !href.startsWith('/'))).toEqual([]);
  });

  it('keeps the legal disclosures in reach: who may use it, the Terms, their risk and fee sections, the privacy notice', () => {
    renderPage();
    const legal = screen.getByRole('region', { name: 'Terms' });
    expect(within(legal).getAllByRole('definition').map((dd) => dd.textContent)).toEqual(['18+', 'US · Canada · UK', 'Sanctioned']);
    expect(within(legal).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Terms of Use', '/about/terms'],
      ['Risks · Section 6', '/about/terms#terms-6'],
      ['Fees · Section 11', '/about/terms#terms-11'],
      ['Privacy notice', '/about/privacy'],
    ]);
    expect(screen.getAllByRole('link', { name: 'Terms of Use' })[0]?.getAttribute('href')).toBe('/about/terms');
  });

  it('lists Square Hole’s own boxes by contract address, box 0 first, with box 0’s mainnet address still an open item (F133)', () => {
    renderPage();
    const ours = screen.getByRole('region', { name: 'Our boxes' });
    expect(within(ours).getAllByRole('definition').map((dd) => dd.textContent)).toEqual(['1', '0']);
    const boxes = Array.from(ours.querySelectorAll<HTMLElement>('.sh-about-ours > li'));
    expect(boxes.map((box) => box.querySelector('.sh-about-ours__name')?.textContent)).toEqual(['The Misfits']);
    expect(boxes[0]?.querySelector('.sh-about-ours__meta')?.textContent).toBe('Box 0 · FIT');
    // Not deployed on mainnet yet: the Terms' own open item stands in for the address, highlighted like every placeholder.
    expect(OUR_BOXES[0]?.address).toBe('[FOUNDER: box 0’s mainnet addresses once deployed (counsel pack, Question 1).]');
    expect(boxes[0]?.querySelector('mark.sh-legal__todo')?.textContent).toBe(OUR_BOXES[0]?.address);
    expect(PRODUCTION_TERMS.document.readFirst.bullets.join(' ')).toContain(OUR_BOXES[0]?.address ?? '?');
    // The details: no mark on the boxes themselves, the same list on X, the address check, and no approval.
    const details = ours.querySelector('details')?.textContent ?? '';
    for (const line of ['No badge or label in the feed or on a box’s page says a box is ours.', 'Box 0 is shown first as Featured: a place in the feed, not an approval.', 'The same addresses are posted on X.', 'a name or picture proves nothing', 'Being on this list is not an approval of any box.']) {
      expect(details, line).toContain(line);
    }
    expect(ours.textContent).not.toMatch(/\b(verified|official|approved|trusted)\b/i);
  });

  it('shows a deployed box’s address as text to check, with a copy button and no placeholder', () => {
    const address = '0x000000000000000000000000000000000000f17e';
    render(<OurBoxAddress box={{ name: 'The Misfits', token: 'FIT', label: 'Box 0', address }} />);
    expect(screen.getByText(address).tagName).toBe('CODE');
    expect(screen.getByRole('button', { name: 'Copy the contract address of The Misfits' })).toBeTruthy();
    expect(document.querySelector('mark')).toBeNull();
  });

  it('states claim-only payouts, the claim without end, the money locked for good and the issuers’ powers in its details', () => {
    renderPage();
    const fees = screen.getByRole('region', { name: 'Fees & payouts' }).textContent ?? '';
    expect(fees).toContain('Holder and item payouts are never sent: each waits until you claim it');
    expect(fees).toContain('Both parts are done by us, not by code.');
    expect(fees).toContain('Square Hole’s 1/15 goes to its platform wallet, which the founder signs for.');
    expect(screen.getByRole('region', { name: 'Curve & graduation' }).textContent).toContain('Each box raises the amount its price coin’s listing names when the box is created');
    const failure = screen.getByRole('region', { name: 'Failure & claim' }).textContent ?? '';
    // RC5-A (F136): no year and no sweep to FIT; the share nobody hands in, and money after the last claim, stay locked.
    expect(failure).toContain('Claims never close. Money that reaches the box later goes to the claims made after it.');
    expect(failure).toContain('The share of coins nobody hands in stays locked for good, and so does money arriving after the last claim. Nobody can take it out, Square Hole included.');
    expect(failure).not.toMatch(/one year|1 yr|365|buy-back wallet|Rest to FIT/i);
    expect(screen.getByRole('region', { name: 'Curve & graduation' }).textContent).not.toMatch(/within a year/);
    const coins = screen.getByRole('region', { name: 'Coins, stocks & gold' }).textContent ?? '';
    expect(coins).toContain('give no shares, dividends or votes');
    expect(coins).toContain('One issuer action can stop every box priced in its coin');
  });

  it('says nothing about a cap on Square Hole’s income, or its absence, details included (F160, F209; SH-245)', () => {
    const { container } = renderPage();
    expect(container.textContent ?? '').not.toMatch(/\bcap(s|ped)?\b|keeps at most|\b(16|32) ETH\b|\/ 30 d\b|per 30 d/i);
    // Box 0's card keeps its first detail word for word.
    expect(screen.getByRole('region', { name: 'Box 0 · The Misfits' }).textContent).toContain('No deadline.');
  });

  it('says nothing about draws stopping, a missing random number or a safety mode, details included (F142, desk R61-STOP "hide")', () => {
    const { container } = renderPage();
    expect(container.textContent ?? '').not.toMatch(/safety mode|safe mode|terminal|without a random number|no (random )?numbers? came|stop(s|ped)? draws|draws stop|stuck draw|7 days without/i);
    // The risk itself stays, in plain words; the Terms (5.11) keep the whole mechanism.
    expect(screen.getByRole('region', { name: 'Box 0 · The Misfits' }).textContent).toContain('Reveals can be late.');
  });

  it('shows the main site’s trading card in this build (no trade code); the Sepolia alpha’s card keeps the page’s shape (SH-ALPHA-NOTICE, F156)', () => {
    renderPage();
    expect(TRADING_CARD).toBe(NO_TRADING_CARD);
    const shown = screen.getByRole('region', { name: 'No trading here' });
    expect(within(shown).getAllByRole('definition').map((dd) => dd.textContent)).toEqual(['0', '0']);
    expect(screen.queryByRole('region', { name: 'Test trades only' })).toBeNull();
    cleanup();
    // The alpha's card as the Sepolia build renders it in the same place (which build shows which: about-trading-card.test.ts).
    const { container } = render(
      <MemoryRouter>
        <AboutCard copy={TEST_TRADING_CARD} icon={<LinkOutGlyph />} />
      </MemoryRouter>,
    );
    const card = screen.getByRole('region', { name: 'Test trades only' });
    expect(card.getAttribute('data-card')).toBe('risks-trading');
    expect(Array.from(card.querySelectorAll('.sh-about-figure dt'), (dt) => dt.textContent)).toEqual(['Real money', 'Wallet amounts']);
    expect(within(card).getAllByRole('definition').map((dd) => dd.textContent)).toEqual(['0', 'Exact']);
    // Numbers first and one sentence in view; the rest waits behind a closed disclosure.
    expect(visibleSentences(card)).toEqual(['Box pages buy and sell test tokens only; browsing never opens your wallet.']);
    const details = card.querySelector('details');
    expect(details?.open).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toBe('Details: Test trades only');
    for (const line of TEST_TRADING_CARD.details) expect(details?.textContent, line).toContain(line);
    for (const summary of Array.from(container.querySelectorAll('summary'))) expect(summary.textContent).not.toMatch(/\b(buy|sell|swap)\b/i);
    expect(unnegatedReturnFraming(renderedCopy(container))).toEqual([]);
    expect(appCopyFraming(renderedCopy(container))).toEqual([]);
  });

  it('describes mechanics, never earnings, rewards, yield or value (SEC staff FAQ Q2.5), on every source', () => {
    for (const source of ['demo', 'local', 'sepolia'] as const) {
      const { container, unmount } = source === 'demo' ? renderPage() : renderOnSource(source);
      expect(unnegatedReturnFraming(renderedCopy(container)), source).toEqual([]);
      expect(appCopyFraming(renderedCopy(container)), source).toEqual([]);
      unmount();
      window.localStorage.clear();
      resetDataSourceForTests();
    }
  });
});

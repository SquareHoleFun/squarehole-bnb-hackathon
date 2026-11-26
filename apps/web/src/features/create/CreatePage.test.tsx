/**
 * The creation page in the app shell (jsdom; the browser suite is e2e/box-create.spec.ts): six steps in F70's order,
 * the summary on Next, the shortest path for a plain token (Basics, Contents, Overview), a hidden collection with its
 * own cover (F74 U3), a banner and teasers, the Overview's Edit links returning with "Back to overview", the fee sides
 * (Holders in the Demo with "Pending legal review", F74 U1; BP-13 off; the sell flag), the one target (F74 U5), Create
 * off until the rights box is ticked, and v1's slugs redirecting. File reading runs through a test environment (no
 * canvas in jsdom); the pictures are still checked by content.
 */
import { sha256Hex } from '@squarehole/artwork';
import { QStream } from '@squarehole/box-spec';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { getAddress } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makePng } from '../../../../../packages/artwork/src/test-support/images';
import { AppProviders } from '../../app-providers';
import { BoxPage } from '../../pages/BoxPage';
import { Shell } from '../../shell/Shell';
import { createdBoxEntries, resetCreatedBoxesForTests } from '../boxes/created-boxes';
import { createDemoWalletAdapter, DEMO_WALLET_TITLE } from '../wallet';
import type { ArtEnvironment } from './art-files';
import { CreatePage } from './CreatePage';
import { DEFAULT_FORM } from './create-model';
import { resetDraftForTests } from './draft';
import { EMPTY_MONEY, moneyJson } from './v2/v2-stored';

let salt = 0;
const ENV: ArtEnvironment = {
  digest: async (bytes) => sha256Hex(bytes),
  thumbnail: async () => 'data:image/png;base64,iVBORw0KGgo=',
  encodeCover: async (file) => ({ bytes: new Uint8Array(await file.arrayBuffer()) }),
  salt: () => sha256Hex(new TextEncoder().encode(`salt-${(salt += 1)}`)),
};

function Where() {
  const { pathname } = useLocation();
  return <output data-testid="where">{pathname}</output>;
}

function renderCreate(path = '/create/basics') {
  render(
    <AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Shell />}>
            <Route path="create/:step" element={<CreatePage env={ENV} />} />
            <Route path="box/:chain/:address" element={<BoxPage />} />
          </Route>
        </Routes>
        <Where />
      </MemoryRouter>
    </AppProviders>,
  );
}

const where = () => screen.getByTestId('where').textContent;
const png = makePng({ width: 32, height: 32, decodable: true });
const square = makePng({ width: 512, height: 512, decodable: true });
const coverPicture = makePng({ width: 600, height: 600, decodable: true });
const wide = makePng({ width: 1024, height: 256, decodable: true });
const file = (name: string, bytes: Uint8Array | string, type = 'image/png') => new File([typeof bytes === 'string' ? bytes : bytes.slice().buffer], name, { type });
const art = (n: number) => [...Array.from({ length: n }, (_, i) => file(`${i + 1}.png`, png)), file('traits.csv', ['id,Colour', ...Array.from({ length: n }, (_, i) => `${i + 1},${i % 2 ? 'Teal' : 'Red'}`)].join('\n'), 'text/csv')];
const heading = () => screen.getByRole('heading', { level: 1 }).textContent;
const steps = () => screen.getByRole('navigation', { name: 'Steps' });

async function choose(input: HTMLElement, files: File[]) {
  await act(async () => {
    fireEvent.change(input, { target: { files } });
  });
}

async function press(name: string | RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

async function go(name: string | RegExp) {
  await act(async () => fireEvent.click(within(steps()).getByRole('link', { name })));
}

async function fillBasics(name: string, ticker: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: name } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Ticker' }), { target: { value: ticker } });
  await choose(screen.getByLabelText('Logo Add image'), [file('logo.png', square)]);
  await waitFor(() => expect(screen.getByLabelText('Logo Change')).toBeTruthy());
}

async function connect(persona: 'Box wallet A' | 'Box wallet B') {
  await press('Connect to create');
  const dialog = screen.getByRole('dialog', { name: DEMO_WALLET_TITLE });
  fireEvent.click(within(dialog).getByRole('radio', { name: persona }));
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: /^(Connect|Update) sample wallet$/ }));
  });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  window.sessionStorage.clear();
  resetDraftForTests();
  resetCreatedBoxesForTests();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  window.localStorage.clear();
  resetDraftForTests();
  resetCreatedBoxesForTests();
});

describe('/create (launch a box, F70’s order)', () => {
  it('Next on empty Basics: a focused summary whose links move to each field; later steps stay closed', async () => {
    renderCreate();
    expect(heading()).toBe('Launch a box, step 1 of 6: Basics');
    expect(screen.getByText('Paired with ETH')).toBeTruthy();
    expect(within(steps()).queryAllByRole('link')).toHaveLength(0);
    await press('Next');
    const summary = screen.getByRole('alert');
    expect(document.activeElement).toBe(summary);
    expect(within(summary).getAllByRole('link').map((link) => link.textContent)).toEqual(['Name: Required', 'Ticker: Required', 'Add a logo']);
    fireEvent.click(within(summary).getAllByRole('link')[1] as HTMLElement);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Ticker' }));
    expect(screen.getByRole('textbox', { name: 'Ticker' }).getAttribute('aria-invalid')).toBe('true');
    expect(where()).toBe('/create/basics');
  });

  it('a bad link opens Links and names its rule; Contents is reachable once Basics is complete', async () => {
    renderCreate();
    await fillBasics('Plain Kites', 'KITE');
    expect(within(steps()).getAllByRole('link').map((link) => link.textContent)).toEqual(['Contents']);
    fireEvent.change(screen.getByRole('textbox', { name: 'Website' }), { target: { value: 'http://kites.example' } });
    await press('Next');
    expect(within(screen.getByRole('alert')).getAllByRole('link').map((link) => link.textContent)).toEqual(['Website: Use a full https:// link']);
    fireEvent.change(screen.getByRole('textbox', { name: 'Website' }), { target: { value: 'https://kites.example' } });
    await press('Next');
    expect(where()).toBe('/create/contents');
  });

  it('a plain token: Basics, "Token", then the Overview; Create waits for the rights box; the box has no items', async () => {
    renderCreate();
    await fillBasics('Plain Kites', 'KITE');
    await press('Next');
    expect(heading()).toBe('Launch a box, step 2 of 6: Contents');
    // No tile is pre-chosen; the Coming later cards are cards, not controls.
    await press('Next');
    expect(within(screen.getByRole('alert')).getAllByRole('link').map((link) => link.textContent)).toEqual(['Pick what’s in the box']);
    const later = screen.getByRole('region', { name: 'Coming later' });
    expect(within(later).getAllByRole('listitem').map((item) => item.querySelector('strong')?.textContent)).toEqual(['NFTs you own', 'NFTs from fees', 'Token baskets']);
    expect(within(later).queryAllByRole('radio')).toHaveLength(0);
    expect(within(later).getByText('Checked by address')).toBeTruthy();
    // The tiles say what each means (D10): a second line, in sight and in the name.
    expect(screen.getByRole('radio', { name: /^Token/ }).closest('label')?.textContent).toBe('TokenNo NFTs');
    expect(screen.getByRole('radio', { name: /^New collection/ }).closest('label')?.textContent).toBe('New collectionYour NFTs');
    fireEvent.click(screen.getByRole('radio', { name: /^Token/ }));
    // Contents complete: every step is a link, the Overview included (the shortest path).
    expect(within(steps()).getAllByRole('link').map((link) => link.textContent)).toEqual(['Basics', 'Box kind', 'Raise', 'Opening', 'Overview']);
    await go('Overview');
    expect(where()).toBe('/create/overview');
    // Opens Now by default (founder 2026-10-04): the block after creation, about 12 seconds.
    expect(screen.getAllByRole('group', { name: /^Preview: Plain Kites, KITE, Token, Upcoming, Opens in <1 min, / }).length).toBeGreaterThan(0);
    expect(screen.getByRole('region', { name: 'Opening' }).textContent).toContain('Now · next block');
    expect(within(screen.getByRole('list', { name: 'Warnings' })).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Not full in 30 days: refunds']);
    expect(screen.getByRole('region', { name: 'Contents' }).textContent).toContain('Token');
    expect(screen.queryByRole('region', { name: /Collection page data/ })).toBeNull();
    await connect('Box wallet B');
    const create = screen.getByRole('button', { name: 'Create' });
    // F70 (6): every parameter, then Create. Each group and the fixed values come before the bar in reading order.
    for (const group of ['Basics', 'Contents', 'Box kind', 'Raise', 'Opening']) {
      expect(screen.getByRole('region', { name: group }).compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING, group).toBeTruthy();
    }
    expect(screen.getByText('Fixed for every box', { selector: 'summary' }).compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(create.getAttribute('aria-disabled')).toBe('true');
    expect(create.getAttribute('aria-describedby')).toBe('create-rights-label');
    await press('Create');
    expect(within(screen.getByRole('alert')).getAllByRole('link').map((link) => link.textContent)).toEqual(['Confirm your rights']);
    expect(where()).toBe('/create/overview');
    fireEvent.click(screen.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }));
    expect(screen.getByRole('button', { name: 'Create' }).getAttribute('aria-disabled')).toBeNull();
    await press('Create');
    await waitFor(() => expect(where()).toMatch(/^\/box\/31337\/0xde00c[0-9a-f]{35}$/));
    expect(await screen.findByRole('heading', { level: 1, name: 'Plain Kites' })).toBeTruthy();
    expect(screen.getByText('Token', { selector: '.sh-box-kind' })).toBeTruthy();
    // The site record: the rights confirmation with the creator's address, never in the spec.
    const [entry] = createdBoxEntries();
    expect(entry?.spec.boxType).toBe(3);
    expect(entry?.rights).toMatchObject({ creator: getAddress('0xde00000000000000000000000000000000000b22'), statement: 'rights-statement-draft-1' });
  });

  it('a hidden collection with a banner and teasers; an Edit link returns with "Back to overview"; a sell is flagged', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:reveal'), revokeObjectURL: vi.fn() });
    renderCreate();
    await fillBasics('Glass Fish', 'FISH');
    const about = 'Glass fish swim in a slow green river under the old mill, each one blown by hand and kept in the box.';
    fireEvent.change(screen.getByRole('textbox', { name: 'About' }), { target: { value: about } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Website' }), { target: { value: 'https://glassfish.example' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'X' }), { target: { value: '@glassfish' } });
    await press('Next');
    fireEvent.click(screen.getByRole('radio', { name: /^New collection/ }));
    // F74 U3: the collection's own cover, its own upload (no "same as logo"); required for a new collection.
    expect(screen.queryByText('Your logo')).toBeNull();
    await choose(screen.getByLabelText('Art Images + traits'), art(10));
    await waitFor(() => expect(screen.getByText('10 items · 1 trait')).toBeTruthy());
    await press('Next');
    expect(within(screen.getByRole('alert')).getAllByRole('link').map((link) => link.textContent)).toEqual(['Add a collection cover']);
    await choose(screen.getByLabelText('Collection cover Add image'), [file('cover.png', coverPicture)]);
    await waitFor(() => expect(screen.getByLabelText('Collection cover Change')).toBeTruthy());
    fireEvent.click(screen.getByRole('radio', { name: 'Hidden until drawn' }));
    await choose(screen.getByLabelText('Banner Add image'), [file('banner.png', wide)]);
    await waitFor(() => expect(screen.getByLabelText('Banner Change')).toBeTruthy());
    await choose(screen.getByLabelText('Teasers Add images'), [file('t1.png', square), file('t2.png', square)]);
    await waitFor(() => expect(screen.getAllByRole('img', { name: /^Teaser \d$/ })).toHaveLength(2));
    await go('Overview');
    // Every parameter by step (F70 (6), C2): the description as the spec holds it, the links as plain text.
    const basics = screen.getByRole('region', { name: 'Basics' });
    expect(basics.querySelector('.sh-newbox-clamp')?.textContent).toBe(about);
    expect(within(basics).getByRole('button', { name: 'More' }).getAttribute('aria-expanded')).toBe('false');
    expect(basics.textContent).toContain('glassfish.example · @glassfish');
    // Plain text in the rows (the group's only link is its Edit link).
    expect(within(basics).getAllByRole('link').map((link) => link.getAttribute('aria-label'))).toEqual(['Edit Basics']);
    const contents = screen.getByRole('region', { name: 'Contents' });
    expect(contents.textContent).toContain('10 · hidden');
    expect([...contents.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual(['Items', 'Traits', 'Collection cover', 'Owner', 'Royalty', 'Page']);
    expect(within(contents).getByRole('img', { name: 'Collection cover added' })).toBeTruthy();
    expect(within(basics).getByRole('img', { name: 'Logo added' })).toBeTruthy();
    expect(contents.textContent).toContain('Traits1');
    expect(contents.textContent).toContain('OwnerYou');
    // Hidden art: the ticket's and the hidden item's texts behind the Items row's (i).
    fireEvent.click(within(contents).getByRole('button', { name: 'About the hidden texts' }));
    expect(within(contents).getByText('Ticket: Opens into one item once its number is drawn.')).toBeTruthy();
    expect(within(contents).getByText('Hidden item: This item is not revealed yet.')).toBeTruthy();
    // The collection page as pictures: the banner, each teaser tagged "Teaser", the link.
    expect(within(contents).getByRole('img', { name: 'Banner' })).toBeTruthy();
    expect(within(contents).getAllByRole('img', { name: /^Teaser \d$/ })).toHaveLength(2);
    expect([...contents.querySelectorAll('.sh-newbox-page-row__teaser small')].map((tag) => tag.textContent)).toEqual(['Teaser', 'Teaser']);
    expect(contents.querySelector('.sh-newbox-page-row__link')?.textContent).toBe('glassfish.example');
    fireEvent.click(screen.getByText('Fixed for every box', { selector: 'summary' }));
    expect(screen.getByText('80% of FISH on the curve, its price ×14.7 from the first trade to the last; after graduation the pool spreads over all prices')).toBeTruthy();
    expect(screen.getByLabelText('contractURI JSON').textContent).toMatch(/"banner_image": "ipfs:\/\/b/);
    // Edit Box kind: the step opens with "Back to overview" as its primary button.
    await act(async () => fireEvent.click(screen.getByRole('link', { name: 'Edit Box kind' })));
    expect(where()).toBe('/create/kind');
    const sellers = screen.getByRole('group', { name: /^Sellers’ fees · FISH/ });
    // Holders (F74 U1): offered in the Demo, marked "Pending", described as pending legal review; BP-13: Burn FIT off
    // beside buyers' Burn FISH.
    const holders = within(sellers).getByRole('radio', { name: /^Holders/ });
    expect(holders.getAttribute('aria-disabled')).toBeNull();
    expect(holders.closest('label')?.querySelector('small')?.textContent).toBe('Pending');
    expect(document.getElementById(holders.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Pending legal review');
    const burnFit = within(sellers).getByRole('radio', { name: /^FIT/ });
    expect(burnFit.getAttribute('aria-disabled')).toBe('true');
    // Its reason in sight (as Holders show "Later") and in full as its description, naming the OTHER side's choice.
    expect(burnFit.closest('label')?.querySelector('small')?.textContent).toBe('Not with buyers’ Burn FISH');
    expect(document.getElementById(burnFit.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Not beside Burn FISH on buyers’ fees: the box would sell and buy back in one pool.');
    fireEvent.click(burnFit);
    expect((within(sellers).getByRole('radio', { name: 'FISH' }) as HTMLInputElement).checked).toBe(true);
    // The other way round (C1): buyers on Burn FIT, sellers on Burn FIT (a sell); now buyers' Burn FISH is off, and its
    // reason names the sellers' choice, never itself.
    const buyers = screen.getByRole('group', { name: /^Buyers’ fees · ETH/ });
    fireEvent.click(within(buyers).getByRole('radio', { name: 'FIT' }));
    fireEvent.click(within(sellers).getByRole('radio', { name: 'FIT' }));
    const buyersFish = within(buyers).getByRole('radio', { name: /^FISH/ });
    expect(buyersFish.getAttribute('aria-disabled')).toBe('true');
    expect(buyersFish.closest('label')?.querySelector('small')?.textContent).toBe('Not with sellers’ Burn FIT');
    expect(document.getElementById(buyersFish.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Not beside Burn FIT on sellers’ fees (sells FISH for ETH): the box would sell and buy back in one pool.');
    // The side's name is its legend's words, without its (i).
    expect(buyers.getAttribute('aria-labelledby')).toBe('create-buyers-legend');
    // You, paid in ETH: a sell, flagged in one line tied to the choice; the cap appears.
    fireEvent.click(within(sellers).getByRole('radio', { name: 'You' }));
    fireEvent.click(within(sellers).getByRole('radio', { name: 'ETH' }));
    expect(within(sellers).getByText('Sells FISH for ETH')).toBeTruthy();
    expect(within(sellers).getByRole('radio', { name: 'ETH' }).getAttribute('aria-describedby')).toBe('create-sellers-sells');
    fireEvent.click(screen.getByText('Fee cap', { selector: 'summary' }));
    fireEvent.click(screen.getByRole('radio', { name: '4 ETH' }));
    // F74 U2: a fixed amount per 30 days, tied to the chips (D2). jsdom does not open <details>, so the summary still
    // reads as closed and carries the amount; the hint under the chips names only the period (the chip has the amount).
    expect(screen.getByText('Fee cap · 4 ETH / 30 days', { selector: 'summary' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Cap your fees' }).getAttribute('aria-describedby')).toBe('create-cap-hint');
    expect(document.getElementById('create-cap-hint')?.textContent).toBe('Per 30 days');
    // Above the cap: Holders offered in the Demo, marked "Pending" as the sides are (F74 U1).
    const excessHolders = within(screen.getByRole('group', { name: 'Above the cap' })).getByRole('radio', { name: /^Holders/ });
    expect(excessHolders.getAttribute('aria-disabled')).toBeNull();
    expect(document.getElementById(excessHolders.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Pending legal review');
    expect(within(screen.getByRole('group', { name: 'Cap your fees' })).getAllByRole('radio').map((radio) => radio.closest('label')?.textContent)).toEqual(['Off', '1 ETH', '4 ETH', '8 ETH', '16 ETH', '32 ETH']);
    await press('Back to overview');
    expect(screen.getByRole('region', { name: 'Box kind' }).textContent).toContain('4 ETH / 30 days · burn above');
    // F74: one target for every box (U5), a fact with every digit, never a choice; the cap does not follow it (U2).
    expect(screen.getByRole('region', { name: 'Raise' }).textContent).toContain('4.206980085 ETH · 30 days');
    await act(async () => fireEvent.click(screen.getByRole('link', { name: 'Edit Raise' })));
    expect(document.getElementById('create-target')?.textContent).toBe('Target4.206980085 ETH');
    expect(screen.queryAllByRole('radio', { name: /ETH/ })).toHaveLength(0);
    expect(screen.queryByRole('group', { name: /^Target/ })).toBeNull();
    expect(document.getElementById('create-target-cap')).toBeNull();
    // The Edit link opens the step's only choice, the deadline.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('radio', { name: '30 days' })));
    await press('Back to overview');
    expect(where()).toBe('/create/overview');
    expect(within(screen.getByRole('list', { name: 'Warnings' })).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Sells FISH for ETH', 'Not full in 30 days: refunds', 'Keep the reveal file']);
    expect(screen.getByRole('region', { name: 'Box kind' }).textContent).toContain('You · ETH');
    fireEvent.click(screen.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }));
    await connect('Box wallet A');
    expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
    await press('Save reveal file');
    await press('Create');
    await waitFor(() => expect(where()).toMatch(/^\/box\/31337\/0xde00c[0-9a-f]{35}$/));
    expect(await screen.findByRole('heading', { level: 1, name: 'Glass Fish' })).toBeTruthy();
    expect(document.querySelector('.sh-box-head__banner img')).not.toBeNull();
    const [entry] = createdBoxEntries();
    expect(entry?.teaserUrls).toHaveLength(2);
    expect(entry?.bannerUrl).toMatch(/^data:image\//);
    // F74 U3: the collection cover is kept with the box (the logo is the card's), and the spec commits to its own hash.
    expect(entry?.collectionCoverUrl).toMatch(/^data:image\//);
    expect(entry?.spec.collectionCoverSha256).toBe(sha256Hex(coverPicture));
    expect(entry?.spec.coverSha256).toBe(sha256Hex(square));
  });

  it('F74 U1: Holders in the Demo, paid in a token, marked "Pending legal review" on the step, the Overview and the box', async () => {
    renderCreate();
    await fillBasics('Snail Mail', 'SNAIL');
    await press('Next');
    fireEvent.click(screen.getByRole('radio', { name: /^Token/ }));
    await go('Box kind');
    const buyers = screen.getByRole('group', { name: /^Buyers’ fees · ETH/ });
    fireEvent.click(within(buyers).getByRole('radio', { name: /^Holders/ }));
    // Holders paid in ETH or in the token (a buy), like You; the note in words beside the choice.
    const paidIn = within(buyers).getByRole('group', { name: 'Paid in' });
    expect(within(paidIn).getAllByRole('radio').map((radio) => radio.closest('label')?.textContent)).toEqual(['ETH', 'SNAIL']);
    expect(within(buyers).getByText('Pending legal review', { selector: 'p.sh-newbox-pending' })).toBeTruthy();
    // No side pays the creator: no fee cap.
    expect(screen.queryByText('Fee cap', { selector: 'summary' })).toBeNull();
    await go('Overview');
    const kind = screen.getByRole('region', { name: 'Box kind' });
    expect(kind.textContent).toContain('Holders · ETH');
    expect(within(kind).getByText('Pending legal review')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }));
    await connect('Box wallet A');
    await press('Create');
    await waitFor(() => expect(where()).toMatch(/^\/box\/31337\/0xde00c[0-9a-f]{35}$/));
    expect(await screen.findByRole('heading', { level: 1, name: 'Snail Mail' })).toBeTruthy();
    const [entry] = createdBoxEntries();
    expect(entry?.spec.qStream).toBe(4);
    fireEvent.click(screen.getByRole('tab', { name: 'About' }));
    const about = document.querySelector('.sh-box-about') as HTMLElement;
    expect(about.textContent).toContain('Holders · ETH');
    expect(about.textContent).toContain('Pending legal review');
  });

  it('a far-off year for the opening time: the Overview still renders and names the problem (no blank page)', async () => {
    renderCreate();
    await fillBasics('Far Off', 'FAR');
    await press('Next');
    fireEvent.click(screen.getByRole('radio', { name: /^Token/ }));
    await go('Opening');
    fireEvent.click(screen.getByRole('radio', { name: 'Pick a time' }));
    fireEvent.change(screen.getByLabelText('Time (UTC)'), { target: { value: '9999-12-31T23:59' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Your ETH at start' }), { target: { value: `1${'0'.repeat(80)}` } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }));
    await go(/^Overview/);
    expect(heading()).toBe('Launch a box, step 6 of 6: Overview');
    expect(screen.getByText(/^Cost ≈ [\d.,]+ ETH$/)).toBeTruthy();
    await connect('Box wallet A');
    await press('Create');
    expect(within(screen.getByRole('alert')).getAllByRole('link').map((link) => link.textContent)).toEqual(['Pick a time within 14 days', 'Your ETH: Below the target: less than 4.206980085 ETH']);
    expect(where()).toBe('/create/overview');
    // The stepper marks the step after the press (as v1); the Overview's group says it too.
    expect(within(steps()).getAllByRole('link').map((link) => link.textContent)).toEqual(['Basics', 'Contents', 'Box kind', 'Raise', 'Opening · Fix']);
    // On a phone the names are hidden: the count says it in words, the dot has a "!" (never colour alone, D8).
    expect(steps().querySelector('.sh-newbox-steps__count')?.textContent).toBe('6/6 · 1 to fix');
    expect(screen.getByRole('region', { name: /^Opening/ }).querySelector('h2')?.textContent).toBe('Opening · Fix');
  });

  it('a draft saved with a share-of-the-raise cap says once that its fee cap was reset (F74 U2)', async () => {
    // Before F74 U2 a draft stored the cap as a share of the raise (capBps) and had no capPerEpoch.
    const form: Record<string, unknown> = { ...DEFAULT_FORM, name: 'Old Kites', ticker: 'KITE', contents: 'token', qStream: QStream.TO_CREATOR, capBps: 2500 };
    delete form.capPerEpoch;
    // SH-256: with the v2 part and the parts' print a draft of this version stores beside it (without them: a clean start).
    window.sessionStorage.setItem('sh.create.draft.v2', JSON.stringify({ form, cover: null, revealSaved: false, v2: moneyJson(EMPTY_MONEY), parts: { art: null, cover: null, collectionCover: null, page: null } }));
    renderCreate('/create/kind');
    expect(screen.getByText(/^Draft restored/).textContent).toBe('Draft restored · Fee cap reset · Start over');
    expect(screen.queryByText('Fee cap · 4 ETH / 30 days', { selector: 'summary' })).toBeNull();
  });

  it('v1’s slugs open the steps that now hold their choices; anything else opens the format 2 flow, as Launch does', async () => {
    for (const [from, to] of [
      ['/create/collection', '/create/contents'],
      ['/create/price', '/create/raise'],
      ['/create/fees', '/create/kind'],
      ['/create/review', '/create/overview'],
      ['/create/nope', '/create/v2-basics'],
      // Own keys only: an Object.prototype name is no v1 step name.
      ['/create/constructor', '/create/v2-basics'],
      ['/create/__proto__', '/create/v2-basics'],
    ] as const) {
      renderCreate(from);
      await waitFor(() => expect(where()).toBe(to));
      cleanup();
    }
  });
});

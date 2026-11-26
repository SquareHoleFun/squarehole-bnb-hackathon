/**
 * SH-251: the picture way of Create, against the six steps. One state and one set of checks: for every template and a
 * matrix of choices, a press on the picture leaves the SAME draft and choices as the same press on the steps (so the same
 * create inputs); the picture's fee choices are FeesStep's for every example configuration; every part opens its
 * sheet; keyboard, Escape and focus return; and nothing is requested on render or on a press of "What happens".
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../../app-providers';
import { Shell } from '../../../shell/Shell';
import { createDemoWalletAdapter } from '../../wallet';
import { PART_ORDER, type PartId } from '../../box-picture/picture';
import { PICTURE_WORDS, WALK_WORDS, aboutOf } from '../../box-picture/picture-words';
import { CreatePage } from '../CreatePage';
import { currentDraft, resetDraftForTests, updateDraft } from '../draft';
import { CONTROL } from '../reason-copy';
import { DEMO_LISTINGS } from '../v2/listings';
import { DEFAULT_V2, V2_CONTROL, buildSpecV2, type V2Choices } from '../v2/model';
import { specHashV2 } from '../v2/spec-types';
import { offeredTemplates } from '../v2/templates';
import { CONFIGURATIONS } from '../v2/test-support/example-configurations';
import { inputV2Of, seedV2 } from '../v2/test-support/v2-fixtures';
import { resetV2ForTests, setV2Loaded, updateV2 } from '../v2/v2-draft';
import { CreateWays } from './CreateWays';
import { EXAMPLES_IN_APP, EXAMPLES_PATH } from './examples-entry';
import { PartSheet } from './PartSheet';
import { issueLine, partOfIssue } from './picture-input';
import { SHOP_CONTROL } from '../v2/shop';
import { WALK_ORDER, WALK_STEP_MS, walkSwitch } from './Walk';
import { PICTURE_PATH } from './picture-route';
import { App } from '../../../App';
import { NAV_ITEMS } from '../../../shell/nav-items';
import { acceptTermsForTests } from '../../../test-support/terms';
import { shLimit } from '../../../../../../vitest.timeouts.mjs';

function Where() {
  const { pathname } = useLocation();
  return <output data-testid="where">{pathname}</output>;
}

function renderAt(path: string) {
  render(
    <AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<Shell />}>
            <Route path="create/:step" element={<CreatePage demoStepMs={0} v2Listings={DEMO_LISTINGS} />} />
          </Route>
        </Routes>
        <Where />
      </MemoryRouter>
    </AppProviders>,
  );
}

const where = () => screen.getByTestId('where').textContent;
// The draft is saved in this browser's session storage and read again after a reset: each start clears it.
const fresh = () => { cleanup(); window.sessionStorage.clear(); localStorage.clear(); resetDraftForTests(); resetV2ForTests(); };
/** The v2 choices as the store holds them now (read through the store's own update, which keeps them as they are). */
function choicesNow(): V2Choices {
  let now: V2Choices = DEFAULT_V2;
  updateV2((choices) => { now = choices; return choices; });
  return now;
}
const stateNow = () => ({ form: currentDraft().form, v2: choicesNow() });
const partOf = (id: PartId): Element => {
  const found = document.querySelector(`[data-part="${id}"]`);
  if (!found) throw new Error(`no part ${id}`);
  return found;
};
const one = (selector: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`nothing at ${selector}`);
  return found;
};
async function press(target: Element) {
  await act(async () => { fireEvent.click(target); });
}
async function openPart(id: PartId) {
  await press(partOf(id));
  return screen.getByRole('dialog');
}

beforeEach(() => { window.sessionStorage.clear(); localStorage.clear(); resetDraftForTests(); resetV2ForTests(); });
afterEach(() => { cleanup(); window.sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const usdc = DEMO_LISTINGS.find((listing) => listing.symbol === 'USDC');
if (!usdc) throw new Error('USDC listing');
const complete = () => {
  const config = CONFIGURATIONS.find((entry) => entry.id === 'gas-guzzlers');
  if (!config) throw new Error('gas-guzzlers');
  return config;
};

/**
 * One press (or one typed value), as the steps reach its control (a step's path) and as the picture does (a part's
 * sheet, or none).
 */
interface Press { readonly name: string; readonly path: string; readonly part: PartId | null; readonly selector: string; readonly value?: string; readonly seed?: string; readonly prepare?: () => void }

const presses: readonly Press[] = [
  // The templates the steps offer here (The Alchemist's only once a route row resolved, which no test chain does).
  ...offeredTemplates(null).map((template): Press => ({ name: `template ${template.id}`, path: '/create/v2-basics', part: null, selector: `[data-template="${template.id}"]` })),
  { name: 'price coin USDC', path: '/create/v2-basics', part: 'price', selector: `#${V2_CONTROL.pricing} input[value="${usdc.token}"]` },
  { name: 'name typed', path: '/create/v2-basics', part: 'token', selector: `#${CONTROL.name}`, value: 'Night Owls' },
  ...(['keep', 'burn', 'grow', 'holders', 'items', 'eat'] as const).flatMap((choice) => (['buyers', 'sellers'] as const).map((side): Press => ({
    name: `${side} ${choice}`, path: '/create/v2-fees', part: side, selector: `#${V2_CONTROL[side]} [data-fee-choice="${choice}"]`, seed: 'bag-holders',
  }))),
  { name: 'sellers into the shop', path: '/create/v2-fees', part: 'sellers', selector: `#${V2_CONTROL.sellers} [data-fee-choice="shop"]`, seed: 'curio-corner' },
  { name: 'sellers to the pile', path: '/create/v2-fees', part: 'sellers', selector: `#${V2_CONTROL.sellers} [data-fee-choice="pile"]`, seed: 'dragons-hoard',
    // To the pile needs a pile in the price coin: the example's pile, in the box's own price coin.
    prepare: () => updateV2((choices) => (choices.pile ? { ...choices, pile: { ...choices.pile, asset: choices.pricing } } : choices)) },
  ...(['token', 'collection', 'shop'] as const).map((kind): Press => ({ name: `contents ${kind}`, path: '/create/v2-contents', part: 'contents', selector: `#${CONTROL.contents} input[value="${kind}"]` })),
  ...([30, 60, 90, 180] as const).map((days): Press => ({ name: `deadline ${days}`, path: '/create/v2-raise', part: 'raise', selector: `#${CONTROL.deadline} input[value="${days}"]` })),
  ...(['now', '5m', '1h', '24h'] as const).map((open): Press => ({ name: `opens ${open}`, path: '/create/v2-opening', part: 'creator', selector: `#${CONTROL.opens} input[value="${open}"]` })),
];

async function act_(press_: Press) {
  const target = one(press_.selector);
  if (press_.value === undefined) await press(target);
  else await act(async () => { fireEvent.change(target, { target: { value: press_.value } }); });
}

describe('SH-251 the picture and the steps share one state', () => {
  it.each(presses)('$name leaves the same draft and choices both ways', async (entry) => {
    const config = entry.seed ? CONFIGURATIONS.find((candidate) => candidate.id === entry.seed) : undefined;
    if (entry.seed && !config) throw new Error(entry.seed);
    if (config) seedV2(config);
    entry.prepare?.();
    renderAt(entry.path);
    await act_(entry);
    const steps = stateNow();

    fresh();
    if (config) seedV2(config);
    entry.prepare?.();
    renderAt(PICTURE_PATH);
    if (entry.part) await openPart(entry.part);
    await act_(entry);
    const picture = stateNow();

    expect(picture).toEqual(steps);
    // And so the same create inputs: the spec the Overview would create.
    const base = inputV2Of();
    expect(specHashV2(buildSpecV2({ ...base, form: picture.form, v2: picture.v2 }))).toBe(specHashV2(buildSpecV2({ ...base, form: steps.form, v2: steps.v2 })));
  });

  it('switching between the ways keeps what was entered', async () => {
    renderAt(PICTURE_PATH);
    const sheet = await openPart('token');
    await act(async () => { fireEvent.change(within(sheet).getByRole('textbox', { name: 'Name' }), { target: { value: 'Night Owls' } }); });
    const ways = screen.getByRole('navigation', { name: PICTURE_WORDS.ways });
    expect(within(ways).getByRole('link', { name: PICTURE_WORDS.visual }).getAttribute('aria-current')).toBe('true');
    await press(within(ways).getByRole('link', { name: PICTURE_WORDS.steps }));
    expect(where()).toBe('/create/v2-basics');
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Night Owls');
    // The steps' header is the steps' own: the switch sits in its own row above it.
    expect(document.querySelector('header.sh-newbox__head .sh-pic-ways')).toBeNull();
    // And back: the picture shows the same draft, under the steps' own heading.
    await press(within(screen.getByRole('navigation', { name: PICTURE_WORDS.ways })).getByRole('link', { name: PICTURE_WORDS.visual }));
    expect(where()).toBe(PICTURE_PATH);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(PICTURE_WORDS.title);
  });

  it('shows three ways in on both ways, in one rounded control: Visual, Steps, Examples; only the way one is on is current', () => {
    expect(EXAMPLES_IN_APP).toBe(true);
    for (const [path, current] of [['/create/v2-basics', PICTURE_WORDS.steps], [PICTURE_PATH, PICTURE_WORDS.visual]] as const) {
      renderAt(path);
      const nav = screen.getByRole('navigation', { name: PICTURE_WORDS.ways });
      const ways = within(nav);
      expect(ways.getAllByRole('link').map((link) => link.textContent)).toEqual([PICTURE_WORDS.visual, PICTURE_WORDS.steps, PICTURE_WORDS.examples]);
      // All three sit inside the one control.
      expect(nav.querySelectorAll('.sh-pic-ways__switch > a')).toHaveLength(3);
      expect(ways.getAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'true').map((link) => link.textContent)).toEqual([current]);
      expect(ways.getByRole('link', { name: PICTURE_WORDS.examples }).getAttribute('href')).toBe(EXAMPLES_PATH);
      cleanup();
    }
  });

  it('an Edit instruction is cleared through the router too: its own location forgets it, the sheet stays open (U3)', async () => {
    cleanup();
    function StateProbe() {
      const { state } = useLocation();
      return <output data-testid="router-state">{JSON.stringify(state ?? null)}</output>;
    }
    render(
      <AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}>
        <MemoryRouter initialEntries={[{ pathname: PICTURE_PATH, state: { open: { part: 'creator', control: null } } }]}>
          <Routes>
            <Route element={<Shell />}>
              <Route path="create/:step" element={<CreatePage demoStepMs={0} v2Listings={DEMO_LISTINGS} />} />
            </Route>
          </Routes>
          <StateProbe />
        </MemoryRouter>
      </AppProviders>,
    );
    expect(screen.getByRole('dialog', { name: PICTURE_WORDS.creator })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('router-state').textContent).toBe('null'));
    expect(screen.getByRole('dialog', { name: PICTURE_WORDS.creator })).toBeTruthy();
  });

  it('an Edit instruction is used once: after it opened its part it is gone from the history entry; a field that no longer exists falls back to the title', async () => {
    cleanup();
    acceptTermsForTests();
    window.history.replaceState({ usr: { open: { part: 'creator', control: 'create-no-such-field' } }, key: 'edit', idx: 0 }, '', PICTURE_PATH);
    render(<App />);
    await waitFor(() => expect(screen.getByRole('dialog', { name: PICTURE_WORDS.creator })).toBeTruthy(), { timeout: shLimit(10_000) });
    await waitFor(() => expect((window.history.state as { usr: unknown } | null)?.usr ?? null).toBeNull());
    await waitFor(() => expect(document.activeElement?.classList.contains('sh-pic-sheet__title')).toBe(true));
    cleanup();
    window.history.replaceState(null, '', '/');
  });

  it('opens the visual way from /create, where the navigation’s Launch leads (the default, SH-254)', async () => {
    cleanup();
    acceptTermsForTests();
    window.history.replaceState(null, '', '/create');
    render(<App />);
    await waitFor(() => expect(window.location.pathname).toBe(PICTURE_PATH), { timeout: shLimit(10_000) });
    expect(NAV_ITEMS.find((item) => item.id === 'launch')?.to).toBe('/create');
    cleanup();
    window.history.replaceState(null, '', '/');
  });

  it('shows the switch alone when the way to the examples is switched off', () => {
    render(<MemoryRouter><CreateWays current="steps" examples={false} /></MemoryRouter>);
    const ways = within(screen.getByRole('navigation', { name: PICTURE_WORDS.ways }));
    expect(ways.getAllByRole('link').map((link) => link.textContent)).toEqual([PICTURE_WORDS.visual, PICTURE_WORDS.steps]);
    expect(screen.queryByRole('link', { name: PICTURE_WORDS.examples })).toBeNull();
    cleanup();
  });

  it('once the examples are in the app, links them inside it, in the same tab', () => {
    render(<MemoryRouter><CreateWays current="steps" examples /></MemoryRouter>);
    const link = within(screen.getByRole('navigation', { name: PICTURE_WORDS.ways })).getByRole('link', { name: PICTURE_WORDS.examples });
    expect(link.getAttribute('href')).toBe(EXAMPLES_PATH);
    expect(EXAMPLES_PATH).toBe('/examples');
    expect(link.getAttribute('target')).toBeNull();
  });
});

describe('SH-251 Overview and the issues follow the steps’ own rules', () => {
  it('a fresh page lists nothing; a field left shows its own issue', async () => {
    renderAt(PICTURE_PATH);
    expect(screen.queryByRole('button', { name: 'Name: Required' })).toBeNull();
    expect(document.querySelector('.sh-pic-issues')).toBeNull();
    const sheet = await openPart('token');
    const name = within(sheet).getByRole('textbox', { name: 'Name' });
    await act(async () => { fireEvent.blur(name); });
    expect(screen.getByRole('button', { name: 'Name: Required' })).toBeTruthy();
    expect(document.querySelector('.sh-pic-issues__title')?.textContent).toBe('One thing to fix');
  });

  it('Overview reveals what to fix while Basics or Contents has an issue (the steps would not let you through), and its line opens the part', async () => {
    renderAt(PICTURE_PATH);
    await press(screen.getByRole('button', { name: PICTURE_WORDS.overview }));
    expect(where()).toBe(PICTURE_PATH);
    const title = document.querySelector<HTMLElement>('.sh-pic-issues__title');
    expect(title?.textContent).toMatch(/things to fix$/);
    await waitFor(() => expect(document.activeElement).toBe(title));
    await press(screen.getByRole('button', { name: 'Name: Required' }));
    const sheet = screen.getByRole('dialog', { name: 'Token' });
    await waitFor(() => expect(document.activeElement).toBe(within(sheet).getByRole('textbox', { name: 'Name' })));
  });

  it('with Basics and Contents complete, Overview opens the steps’ own Overview, and its Back returns to the picture', async () => {
    seedV2(complete());
    renderAt(PICTURE_PATH);
    await press(screen.getByRole('button', { name: PICTURE_WORDS.overview }));
    expect(where()).toBe('/create/v2-overview');
    const back = screen.getByRole('link', { name: 'Back to Visual' });
    await press(back);
    expect(where()).toBe(PICTURE_PATH);
  });

  it('lists none of the Overview’s own issues and no wallet words (Shop template, no wallet)', async () => {
    renderAt(PICTURE_PATH);
    await press(one('[data-template="shop"]'));
    await press(screen.getByRole('button', { name: PICTURE_WORDS.overview }));
    expect(document.querySelector('.sh-pic-create')?.textContent ?? '').not.toMatch(/wallet/i);
    for (const button of document.querySelectorAll('.sh-pic-issues button')) expect(button.textContent).not.toMatch(/curator|starter/i);
  });
});

describe('SH-251 the picture’s fee choices are FeesStep’s', () => {
  const menu = (side: 'buyers' | 'sellers') => Array.from(document.querySelectorAll<HTMLElement>(`#${V2_CONTROL[side]} [data-fee-choice]`), (button) => [button.dataset.feeChoice, button.getAttribute('aria-pressed'), button.getAttribute('aria-disabled')]);
  it.each(CONFIGURATIONS.map((config) => [config.id, config] as const))('%s: the same buttons, the same pressed one', async (_id, config) => {
    seedV2(config);
    renderAt('/create/v2-fees');
    const steps = { buyers: menu('buyers'), sellers: menu('sellers') };
    fresh();
    seedV2(config);
    renderAt(PICTURE_PATH);
    await openPart('buyers');
    const buyers = menu('buyers');
    expect(document.querySelector(`#${V2_CONTROL.sellers}`)).toBeNull();
    await press(within(screen.getByRole('dialog')).getByRole('button', { name: PICTURE_WORDS.close }));
    await openPart('sellers');
    expect({ buyers, sellers: menu('sellers') }).toEqual(steps);
  });
});

describe('SH-251 every part is a control that opens its sheet', () => {
  const titles: Readonly<Record<PartId, string>> = {
    buyers: 'Buyers’ fees', token: 'Token', contents: 'What’s in the box', sellers: 'Sellers’ fees', creator: 'Creator', raise: 'Raise',
    price: 'Priced in', holders: 'Holders', mark: 'Square Hole', pool: 'Pool',
  };

  it('each part, by its name, opens its own sheet with the steps’ fields', async () => {
    renderAt(PICTURE_PATH);
    const parts = screen.getAllByRole('button').filter((button) => button.hasAttribute('data-part'));
    expect(parts.map((button) => button.getAttribute('data-part'))).toEqual(PART_ORDER);
    for (const id of PART_ORDER) {
      const sheet = await openPart(id);
      expect(sheet.querySelector('.sh-pic-sheet__title')?.textContent).toBe(titles[id]);
      expect(partOf(id).getAttribute('aria-expanded')).toBe('true');
      // The steps' own controls, by the steps' own ids.
      const control = { token: CONTROL.name, contents: CONTROL.contents, price: V2_CONTROL.pricing, raise: CONTROL.deadline, creator: CONTROL.opens, buyers: V2_CONTROL.buyers, sellers: V2_CONTROL.sellers, holders: V2_CONTROL.buyers, pool: null, mark: null }[id];
      if (control) expect(sheet.querySelector(`#${control}`)).not.toBeNull();
      // Its (?) (every sheet has one since round 125) starts closed; a name used inside the sheet is never used twice there.
      const head = sheet.querySelector('.sh-pic-sheet__head');
      const about = head ? within(head as HTMLElement).queryAllByRole('button').find((button) => button.getAttribute('aria-label')?.startsWith('About ')) : undefined;
      expect(about, id).toBeTruthy();
      if (about) {
        expect(about.getAttribute('aria-expanded')).toBe('false');
        expect(within(sheet).getAllByRole('button', { name: about.getAttribute('aria-label') ?? '' })).toHaveLength(1);
      }
      await press(within(sheet).getByRole('button', { name: PICTURE_WORDS.close }));
      expect(screen.queryByRole('dialog')).toBeNull();
    }
  });

  it('names each part with the words it shows, never the audit’s words; what sits beside it is its one description', () => {
    renderAt(PICTURE_PATH);
    for (const id of PART_ORDER) expect(partOf(id).getAttribute('aria-label')).not.toMatch(/\b(buy|sell|swap)\b/i);
    expect(partOf('buyers').getAttribute('aria-label')).toBe('Buys · Buyers’ fees');
    expect(partOf('sellers').getAttribute('aria-label')).toBe('Sells · Sellers’ fees');
    for (const id of ['buyers', 'sellers', 'pool', 'mark'] as const) {
      const described = document.getElementById(partOf(id).getAttribute('aria-describedby') ?? '');
      expect(described?.tagName.toLowerCase()).toBe('desc');
      expect(described && partOf(id).contains(described)).toBe(true);
    }
    expect(document.getElementById(partOf('buyers').getAttribute('aria-describedby') ?? '')?.textContent).toBe('Buy back and burn the box coin · 0.667%');
    expect(document.getElementById(partOf('pool').getAttribute('aria-describedby') ?? '')?.textContent).toBe('0.133%');
    // The station's words are plain text, outside every control.
    for (const words of document.querySelectorAll('[data-words]')) expect(words.closest('[data-part]')).toBeNull();
  });

  it('opens with Enter, moves focus to its title, closes with Escape and gives focus back to the part', async () => {
    renderAt(PICTURE_PATH);
    const part = partOf('raise') as SVGGElement;
    part.focus();
    await act(async () => { fireEvent.keyDown(part, { key: 'Enter' }); });
    const sheet = screen.getByRole('dialog', { name: 'Raise' });
    await waitFor(() => expect(document.activeElement).toBe(sheet.querySelector('.sh-pic-sheet__title')));
    await act(async () => { fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }); });
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(partOf('raise')));
  });

  it('closes without moving focus when focus or a click leaves it', async () => {
    renderAt(PICTURE_PATH);
    await act(async () => { fireEvent.keyDown(partOf('pool'), { key: ' ' }); });
    const title = screen.getByRole('dialog', { name: 'Pool' }).querySelector<HTMLElement>('.sh-pic-sheet__title');
    if (!title) throw new Error('the sheet has a title');
    const play = within(screen.getByRole('region', { name: PICTURE_WORDS.whatHappens })).getByRole('button', { name: /^Someone buys/ });
    await act(async () => { fireEvent.focusOut(title, { relatedTarget: play }); });
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => { fireEvent.keyDown(partOf('pool'), { key: ' ' }); });
    expect(screen.getByRole('dialog', { name: 'Pool' })).toBeTruthy();
    const heading = screen.getByRole('heading', { level: 1 });
    await act(async () => { fireEvent.click(heading); });
    expect(screen.queryByRole('dialog')).toBeNull();
    await new Promise((done) => { window.setTimeout(done, 0); });
    expect(document.activeElement).not.toBe(partOf('pool'));
  });

  it('leaves an Escape that belongs to a search field holding text; an empty one lets the sheet shut', async () => {
    // Review pass 2 (L-new-3): the price sheet of the Demo listings has no search field (the coin picker shows one only
    // above 12 coins), so the sheet is given one here, as the coin picker's own field is in a long list.
    const onClose = vi.fn();
    render(
      <PartSheet title="Priced in" icon={null} why={[]} whyLabel={null} anchor={() => null} stage={() => null} onClose={onClose}>
        <input type="search" aria-label="Find a coin" />
      </PartSheet>,
    );
    const search = screen.getByRole('searchbox', { name: 'Find a coin' });
    await act(async () => { fireEvent.change(search, { target: { value: 'US' } }); });
    await act(async () => { fireEvent.keyDown(search, { key: 'Escape' }); });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Priced in' })).toBeTruthy();
    await act(async () => { fireEvent.change(search, { target: { value: '' } }); });
    await act(async () => { fireEvent.keyDown(search, { key: 'Escape' }); });
    expect(onClose).toHaveBeenCalledExactlyOnceWith('escape');
  });
});

describe('SH-251 What happens, in the Demo source', () => {
  it('requests nothing on render or on any press; the fifteenths and its spoken result', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('no network in this test')));
    vi.stubGlobal('fetch', fetchSpy);
    const open = vi.spyOn(XMLHttpRequest.prototype, 'open');
    const walletRequest = vi.fn();
    vi.stubGlobal('ethereum', { request: walletRequest, on: vi.fn(), removeListener: vi.fn() });
    renderAt(PICTURE_PATH);
    const happens = screen.getByRole('region', { name: PICTURE_WORDS.whatHappens });
    // Clear stays in place and says it is off until something ran.
    expect(within(happens).getByRole('button', { name: PICTURE_WORDS.clear }).getAttribute('aria-disabled')).toBe('true');
    await press(within(happens).getByRole('button', { name: /^Someone buys/ }));
    await waitFor(() => expect(happens.querySelector('[data-row="buyers"] b')?.textContent).toBe('0.00667'));
    expect(happens.querySelector('[data-row="pool"] b')?.textContent).toBe('0.00133');
    expect(happens.querySelector('[data-row="mark"] b')?.textContent).toBe('0.002');
    expect(happens.querySelector('[data-traded]')?.textContent).toBe('1 ETH traded · fee 0.01 ETH');
    // Said once when the run ends: the result line, then each line of the list.
    expect(happens.querySelector('[data-said]')?.textContent).toBe('1 ETH traded · fee 0.01 ETH. Buy back and burn the box coin 0.00667 ETH. Pool 0.00133 ETH. Square Hole 0.002 ETH');
    expect(happens.querySelector('ul')?.getAttribute('aria-live')).toBeNull();
    await press(within(happens).getByRole('button', { name: /^Someone sells/ }));
    await press(within(happens).getByRole('button', { name: /^100 trades/ }));
    await waitFor(() => expect(happens.querySelector('[data-traded]')?.textContent).toBe('102 ETH traded · fee 1.02 ETH'));
    // The picture shows the run's amounts beside its stations.
    expect(document.querySelector('[data-number="pool"]')?.textContent).toBe('0.136');
    await press(within(happens).getByRole('button', { name: PICTURE_WORDS.clear }));
    expect(happens.querySelector('[data-traded]')?.textContent).toBe(PICTURE_WORDS.everyTrade);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(walletRequest).not.toHaveBeenCalled();
  });

  it('says what its fifteenths leave out, behind its (?), closed by default; no line on the tip (his choice, desk round 125)', async () => {
    renderAt(PICTURE_PATH);
    const happens = screen.getByRole('region', { name: PICTURE_WORDS.whatHappens });
    const about = within(happens).getByRole('button', { name: 'About the fees' });
    expect(about.getAttribute('aria-expanded')).toBe('false');
    await press(about);
    expect(happens.textContent).toContain('Sale fees in the box coin are burned until graduation. After it the box sells them for ETH in its own pool and splits that ETH like the other fees.');
    expect(happens.textContent).not.toContain('5%');
  });
});

describe('SH-254 the walk switched off (as on the site now)', () => {
  it('leaves nothing of the walk on the page: no player, no reserved room', () => {
    expect(walkSwitch.on).toBe(false);
    renderAt(PICTURE_PATH);
    expect(document.querySelector('[data-walk]')).toBeNull();
    expect(document.querySelector('.sh-pic-page')?.hasAttribute('data-walk-on')).toBe(false);
    expect(screen.queryByRole('button', { name: WALK_WORDS.play })).toBeNull();
  });

  it('a sheet shuts when focus leaves it for the next control, as before SH-254', async () => {
    renderAt(PICTURE_PATH);
    const sheet = await openPart('token');
    const next = screen.getByRole('button', { name: aboutOf('picture') });
    await act(async () => { fireEvent.focusOut(within(sheet).getByRole('button', { name: PICTURE_WORDS.close }), { relatedTarget: next }); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('SH-254 a problem opens the part where it is fixed', () => {
  it('on an Overview reached from the visual way, a group to fix leads back to the part of its problem, focus on its field', async () => {
    seedV2(complete());
    updateDraft((draft) => ({ ...draft, form: { ...draft.form, firstIn: '1e3' } }));
    renderAt(PICTURE_PATH);
    await press(screen.getByRole('button', { name: PICTURE_WORDS.overview }));
    expect(where()).toBe('/create/v2-overview');
    await press(screen.getByRole('link', { name: 'Edit Opening' }));
    expect(where()).toBe(PICTURE_PATH);
    const sheet = screen.getByRole('dialog', { name: PICTURE_WORDS.creator });
    await waitFor(() => expect(document.activeElement?.id).toBe(CONTROL.firstIn));
    expect(sheet.contains(document.activeElement)).toBe(true);
  });

  it('on that Overview each group’s Edit leads back to its part; reached from the steps, to its step as before', async () => {
    seedV2(complete());
    renderAt(PICTURE_PATH);
    await press(screen.getByRole('button', { name: PICTURE_WORDS.overview }));
    await press(screen.getByRole('link', { name: 'Edit Fees' }));
    expect(where()).toBe(PICTURE_PATH);
    expect(screen.getByRole('dialog', { name: PICTURE_WORDS.buyersFees })).toBeTruthy();
    fresh();
    seedV2(complete());
    renderAt('/create/v2-overview');
    await press(screen.getByRole('link', { name: 'Edit Fees' }));
    expect(where()).toBe('/create/v2-fees');
  });

  it('a problem keeps the sheet it opens, also when that sheet is already open; Close then returns to the problem', async () => {
    renderAt(PICTURE_PATH);
    await press(screen.getByRole('button', { name: PICTURE_WORDS.overview }));
    // The Token sheet is open already (by hand), focus outside it, when its problem is pressed.
    await openPart('token');
    const problem = screen.getByRole('button', { name: 'Ticker: Required' });
    problem.focus();
    await press(problem);
    const sheet = screen.getByRole('dialog', { name: PICTURE_WORDS.token });
    await waitFor(() => expect(document.activeElement).toBe(within(sheet).getByRole('textbox', { name: 'Ticker' })));
    await press(within(sheet).getByRole('button', { name: PICTURE_WORDS.close }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Ticker: Required' })));
  });

  it('Close returns focus to the list’s title when its problem is fixed and others remain, to the part when none is left', async () => {
    renderAt(PICTURE_PATH);
    await press(screen.getByRole('button', { name: PICTURE_WORDS.overview }));
    await press(screen.getByRole('button', { name: 'Ticker: Required' }));
    const sheet = screen.getByRole('dialog', { name: PICTURE_WORDS.token });
    const ticker = within(sheet).getByRole('textbox', { name: 'Ticker' });
    await waitFor(() => expect(document.activeElement).toBe(ticker));
    await act(async () => { fireEvent.change(ticker, { target: { value: 'OWL' } }); });
    expect(screen.queryByRole('button', { name: 'Ticker: Required' })).toBeNull();
    // Others remain ("Name: Required" among them): back to the list's title, which names how many.
    expect(screen.getByRole('button', { name: 'Name: Required' })).toBeTruthy();
    await press(within(sheet).getByRole('button', { name: PICTURE_WORDS.close }));
    const title = document.querySelector<HTMLElement>('.sh-pic-issues__title');
    await waitFor(() => expect(document.activeElement).toBe(title));
    expect(title?.textContent).toMatch(/to fix$/);
  });

  it('Close returns focus to the part when the list is empty (the only problem fixed)', async () => {
    seedV2(complete());
    updateDraft((draft) => ({ ...draft, form: { ...draft.form, ticker: '' } }));
    renderAt(PICTURE_PATH);
    await press(screen.getByRole('button', { name: PICTURE_WORDS.overview }));
    expect(document.querySelectorAll('.sh-pic-issues button')).toHaveLength(1);
    await press(screen.getByRole('button', { name: 'Ticker: Required' }));
    const sheet = screen.getByRole('dialog', { name: PICTURE_WORDS.token });
    await act(async () => { fireEvent.change(within(sheet).getByRole('textbox', { name: 'Ticker' }), { target: { value: 'OWL' } }); });
    expect(document.querySelector('.sh-pic-issues')).toBeNull();
    await press(within(sheet).getByRole('button', { name: PICTURE_WORDS.close }));
    await waitFor(() => expect(document.activeElement).toBe(partOf('token')));
  });

  it('one click on the open part closes it, also when focus was on a problem just before', async () => {
    renderAt(PICTURE_PATH);
    await press(screen.getByRole('button', { name: PICTURE_WORDS.overview }));
    await openPart('token');
    const problem = screen.getByRole('button', { name: 'Ticker: Required' });
    problem.focus();
    // The pointer press on the part moves focus there first (blur), then the click toggles.
    await act(async () => { fireEvent.blur(problem, { relatedTarget: partOf('token') }); });
    await press(partOf('token'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('focus moving from a problem on to anything outside the sheet shuts the sheet like any other departure', async () => {
    renderAt(PICTURE_PATH);
    await press(screen.getByRole('button', { name: PICTURE_WORDS.overview }));
    await openPart('token');
    const problem = screen.getByRole('button', { name: 'Ticker: Required' });
    // Focus passes through the problem (a Tab, not a press): the sheet stays while focus is on it.
    await act(async () => { fireEvent.focusOut(screen.getByRole('dialog').querySelector('h2') as HTMLElement, { relatedTarget: problem }); });
    expect(screen.getByRole('dialog', { name: PICTURE_WORDS.token })).toBeTruthy();
    // ...and on to Overview: the sheet shuts.
    await act(async () => { fireEvent.blur(problem, { relatedTarget: screen.getByRole('button', { name: PICTURE_WORDS.overview }) }); });
    expect(screen.queryByRole('dialog')).toBeNull();
    // A press on the list's empty space is an ordinary press outside the sheet.
    await openPart('token');
    await press(document.querySelector('.sh-pic-issues') as HTMLElement);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Start over clears the logo reader’s error: the new box’s empty picker shows none (U4a)', async () => {
    seedV2(complete());
    renderAt(PICTURE_PATH);
    await openPart('token');
    const logo = () => document.getElementById(CONTROL.logo) as HTMLInputElement;
    await act(async () => { fireEvent.change(logo(), { target: { files: [new File(['not a picture'], 'bad.png', { type: 'image/png' })] } }); });
    await waitFor(() => expect(logo().getAttribute('aria-invalid')).toBe('true'), { timeout: shLimit(10_000) });
    // A loaded setup offers Start over (the steps' own note); the reader's error is the old box's.
    await act(async () => { setV2Loaded({ pileFollowsPrice: false, items: 0, hidden: false, note: null }); });
    await press(screen.getAllByRole('button', { name: 'Start over' })[0] as HTMLElement);
    await openPart('token');
    expect(logo().getAttribute('aria-invalid')).toBeNull();
  });

  it('Start over inside an open sheet, then Back: the old entry does not reopen that sheet on the new box (U4c)', async () => {
    cleanup();
    acceptTermsForTests();
    seedV2(complete());
    setV2Loaded({ pileFollowsPrice: false, items: 0, hidden: false, note: null });
    window.history.replaceState(null, '', PICTURE_PATH);
    render(<App />);
    const raise = await waitFor(() => { const found = document.querySelector('[data-part="raise"]'); if (!found) throw new Error('no picture yet'); return found; }, { timeout: shLimit(10_000) });
    await press(raise);
    const sheet = screen.getByRole('dialog', { name: PICTURE_WORDS.raise });
    await press(within(sheet).getByRole('button', { name: 'Start over' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await act(async () => { window.history.back(); await new Promise((done) => { window.setTimeout(done, 50); }); });
    expect(screen.queryByRole('dialog', { name: PICTURE_WORDS.raise })).toBeNull();
    cleanup();
    window.history.replaceState(null, '', '/');
  });

  it('Start over on the visual way starts a new box with nothing of the old one: no trades, no problems listed', async () => {
    seedV2(complete());
    setV2Loaded({ pileFollowsPrice: false, items: 0, hidden: false, note: null });
    renderAt(PICTURE_PATH);
    const happens = () => screen.getByRole('region', { name: PICTURE_WORDS.whatHappens });
    await press(within(happens()).getByRole('button', { name: /^Someone buys/ }));
    await waitFor(() => expect(happens().querySelector('[data-traded]')?.textContent).not.toBe(PICTURE_WORDS.everyTrade));
    await act(async () => { fireEvent.blur(within(await openPart('token')).getByRole('textbox', { name: 'Name' })); });
    await press(screen.getAllByRole('button', { name: 'Start over' })[0] as HTMLElement);
    expect(where()).toBe(PICTURE_PATH);
    expect(happens().querySelector('[data-traded]')?.textContent).toBe(PICTURE_WORDS.everyTrade);
    expect(document.querySelector('.sh-pic-issues')).toBeNull();
    expect(screen.queryAllByRole('button', { name: 'Start over' })).toHaveLength(0);
    const name = within(await openPart('token')).getByRole('textbox', { name: 'Name' });
    expect((name as HTMLInputElement).value).toBe('');
    expect(name.getAttribute('aria-invalid')).not.toBe('true');
  });

  it('names each problem by its field, so two with the same message never share a name', () => {
    const line = (control: string, message: string) => issueLine({ control, message });
    expect(line(V2_CONTROL.buyers, 'Choose a fee destination.')).toBe('Buyers’ fees: Choose a fee destination.');
    expect(line(V2_CONTROL.sellers, 'Choose a fee destination.')).toBe('Sellers’ fees: Choose a fee destination.');
    // Lines the checks really produce (shop.ts): the tiers' and the seed's "More than 0" name different fields.
    expect(line(SHOP_CONTROL.tier(1), 'More than 0')).toBe('Tier 2: More than 0');
    expect(line(SHOP_CONTROL.seed, 'More than 0')).toBe('Seed: More than 0');
    expect(line(SHOP_CONTROL.tier(2), 'Above tier 2')).toBe('Tier 3: Above tier 2');
    expect(line(SHOP_CONTROL.starters(2), 'Use ids like 1, 2, 5-9')).toBe('Starter ids 3: Use ids like 1, 2, 5-9');
    expect(line(V2_CONTROL.pricing, 'Choose a current price coin.')).toBe('Priced in: Choose a current price coin.');
    expect(line(CONTROL.name, 'Required')).toBe('Name: Required');
  });

  it('every step’s problems have a part on the picture, except the Overview’s own (fixed on the Overview itself)', () => {
    for (const step of ['v2-basics', 'v2-contents', 'v2-fees', 'v2-raise', 'v2-opening'] as const) expect(partOfIssue({ step, control: 'any' }), step).not.toBeNull();
    expect(partOfIssue({ step: 'v2-basics', control: V2_CONTROL.pricing })).toBe('price');
    expect(partOfIssue({ step: 'v2-fees', control: V2_CONTROL.sellers })).toBe('sellers');
    expect(partOfIssue({ step: 'v2-overview', control: 'any' })).toBeNull();
  });
});

describe('SH-254 the walk through the parts (its switch forced on; it is off on the site for now)', () => {
  beforeEach(() => { walkSwitch.on = true; });
  afterEach(() => { walkSwitch.on = false; vi.useRealTimers(); delete document.documentElement.dataset.motion; });
  const walk = () => within(document.querySelector<HTMLElement>('[data-walk]') ?? document.body);

  it('is the examples’ player: Play, the steps by name, Next step; a step opens its part and changes no value', async () => {
    renderAt(PICTURE_PATH);
    const before = stateNow();
    const player = walk();
    expect(player.getByRole('button', { name: WALK_WORDS.play })).toBeTruthy();
    const steps = within(player.getByRole('list', { name: WALK_WORDS.steps })).getAllByRole('button');
    expect(steps.map((step) => step.getAttribute('aria-label'))).toEqual([
      'Step 1 of 8, Token', 'Step 2 of 8, Priced in', 'Step 3 of 8, What’s in the box', 'Step 4 of 8, Buyers’ fees',
      'Step 5 of 8, Sellers’ fees', 'Step 6 of 8, Raise', 'Step 7 of 8, Creator', 'Step 8 of 8, Overview',
    ]);
    expect(WALK_ORDER).toHaveLength(8);
    const priced = steps[1];
    if (!priced) throw new Error('step 2');
    priced.focus();
    await press(priced);
    expect(screen.getByRole('dialog', { name: PICTURE_WORDS.pricedIn })).toBeTruthy();
    // The walk keeps focus on its own controls; the part is marked open; the step is current and said.
    expect(document.activeElement).toBe(priced);
    expect(partOf('price').getAttribute('aria-expanded')).toBe('true');
    expect(priced.getAttribute('aria-current')).toBe('step');
    expect(player.getByRole('status').textContent).toBe('2/8 Priced in');
    await press(player.getByRole('button', { name: WALK_WORDS.next }));
    expect(screen.getByRole('dialog', { name: PICTURE_WORDS.contents })).toBeTruthy();
    expect(player.getByRole('status').textContent).toBe('3/8 What’s in the box');
    // The last step: no sheet, the Overview marked; Next step says it is off.
    const last = steps[7];
    if (!last) throw new Error('step 8');
    await press(last);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: PICTURE_WORDS.overview }).hasAttribute('data-walk-here')).toBe(true);
    expect(player.getByRole('button', { name: WALK_WORDS.next }).getAttribute('aria-disabled')).toBe('true');
    expect(player.getByRole('button', { name: WALK_WORDS.replay })).toBeTruthy();
    expect(stateNow()).toEqual(before);
  });

  it('plays on by itself, and stops where it is at any press elsewhere on the page', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    renderAt(PICTURE_PATH);
    const player = walk();
    await press(player.getByRole('button', { name: WALK_WORDS.play }));
    expect(screen.getByRole('dialog', { name: PICTURE_WORDS.token })).toBeTruthy();
    expect(player.getByRole('button', { name: WALK_WORDS.pause })).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(WALK_STEP_MS); });
    expect(screen.getByRole('dialog', { name: PICTURE_WORDS.pricedIn })).toBeTruthy();
    await act(async () => { fireEvent.pointerDown(screen.getByRole('heading', { level: 1 })); });
    expect(player.getByRole('button', { name: WALK_WORDS.play })).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(WALK_STEP_MS * 3); });
    expect(player.getByRole('status').textContent).toBe('2/8 Priced in');
  });

  it('with reduced motion never moves on by itself: Play goes one step', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    renderAt(PICTURE_PATH);
    // The app's own Reduce motion (set after the page applied its saved settings).
    document.documentElement.dataset.motion = 'reduce';
    const player = walk();
    await press(player.getByRole('button', { name: WALK_WORDS.play }));
    expect(player.getByRole('status').textContent).toBe('1/8 Token');
    expect(player.getByRole('button', { name: WALK_WORDS.play })).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(WALK_STEP_MS * 3); });
    expect(player.getByRole('status').textContent).toBe('1/8 Token');
    await press(player.getByRole('button', { name: WALK_WORDS.play }));
    expect(player.getByRole('status').textContent).toBe('2/8 Priced in');
  });
});

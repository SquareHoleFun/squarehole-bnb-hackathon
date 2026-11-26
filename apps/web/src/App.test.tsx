import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from './app-providers';
import { SEARCH_DEBOUNCE_MS } from './features/feed/FeedControls';
import { AppRoutes } from './routes';
import { LEGACY_PAGES } from './test-support/legacy-pages';

beforeEach(() => {
  // jsdom does not implement scrolling; the feed's Back/Forward scroll restoration calls it.
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function HistoryBack() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      History back
    </button>
  );
}

function renderAt(path: string, { withHistoryBack = false, before = [] as string[], legacy = false } = {}) {
  // A fresh query cache, feed sources and snapshot pins per test. `before`: history entries behind `path`. `legacy`: the
  // first handoff's pages mounted at their old paths, for their own tests (no build routes them since F134 R46B).
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={[...before, path]} initialIndex={before.length}>
        <AppRoutes legacyPages={legacy ? LEGACY_PAGES : undefined} />
        <LocationProbe />
        {withHistoryBack ? <HistoryBack /> : null}
      </MemoryRouter>
    </AppProviders>,
  );
}

/** The first handoff's pages (the pair feed, a pair, Claims, Portfolio), mounted for their own tests. */
const legacyAt = (path: string, options: { withHistoryBack?: boolean; before?: string[] } = {}) => renderAt(path, { ...options, legacy: true });
const pause = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
/** The pair feed's search (unrouted, `legacyAt`) and the box feed's (`/`): one search per page, the header trigger focuses the box feed's. */
const searchbox = () => screen.getByRole('searchbox', { name: 'Search pairs' }) as HTMLInputElement;
const boxSearch = () => screen.getByRole('searchbox', { name: 'Search boxes, tokens or a wallet' }) as HTMLInputElement;
const radio = (name: string) => screen.getByRole('radio', { name }) as HTMLInputElement;

const location = () => screen.getByTestId('location').textContent;
const primaryNav = () => screen.getByRole('navigation', { name: 'Primary' });

describe('shell landmarks and skip link', () => {
  it('has banner, primary navigation, search, main and contentinfo landmarks', async () => {
    renderAt('/');
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(primaryNav()).toBeTruthy();
    expect(await screen.findByRole('search')).toBeTruthy();
    expect(screen.getByRole('main')).toBeTruthy();
    expect(screen.getByRole('contentinfo')).toBeTruthy();
  });

  it('starts with a skip link to the main content', () => {
    const { container } = renderAt('/');
    const first = container.querySelector('a, button, input, [tabindex]');
    expect(first?.textContent).toBe('Skip to content');
    expect(first?.getAttribute('href')).toBe('#main');
    expect(screen.getByRole('main').id).toBe('main');
    expect(screen.getByRole('main').getAttribute('tabindex')).toBe('-1');
  });

  it('brands the top bar with no source badge for the sample data and no Demo word (F130); the launch set has no "Launch pair" button', () => {
    renderAt('/');
    const banner = screen.getByRole('banner');
    expect(within(banner).getByRole('link', { name: 'Square Hole home' }).getAttribute('href')).toBe('/');
    expect(banner.textContent).toContain('Different shapes. Same hole.');
    expect(banner.querySelector('.sh-source-badge')).toBeNull();
    expect(banner.textContent).not.toMatch(/demo|mock/i);
    expect(within(banner).queryByRole('link', { name: 'Launch pair' })).toBeNull();
  });

  it('offers the wallet only behind an explicit button, and no trading control (UI-01, UI-09)', async () => {
    const { container } = renderAt('/');
    await screen.findByText('6 boxes');
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/\bbuy\b|\bsell\b|\bswap\b/i);
    // SH-015: one closed "Connect wallet" button in the top bar; nothing is open or prompting on load.
    const wallet = within(screen.getByRole('banner')).getByRole('button', { name: 'Connect wallet' });
    expect(wallet.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getAllByRole('button', { name: /wallet/i })).toEqual([wallet]);
    expect(screen.queryByRole('dialog')).toBeNull();
    // The only form controls are the box feed's one search and its sort.
    expect(container.querySelectorAll('input:not([type="search"]), textarea, iframe')).toHaveLength(0);
    const selects = Array.from(container.querySelectorAll('select'), (select) => select.labels?.[0]?.textContent);
    expect(selects).toEqual(['Sort']);
  });
});

describe('primary navigation', () => {
  it('marks the current page with aria-current; My Box is offered only once a wallet is connected', () => {
    renderAt('/');
    const nav = primaryNav();
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['Boxes', 'Launch', 'Settings', 'About & risks']);
    expect(within(nav).getByRole('link', { name: 'Boxes' }).getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBeNull();
    expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  it('navigates and moves focus to the new page heading', async () => {
    renderAt('/');
    await act(async () => fireEvent.click(within(primaryNav()).getByRole('link', { name: 'Settings' })));
    expect(location()).toBe('/settings');
    const heading = screen.getByRole('heading', { level: 1, name: 'Settings' });
    expect(document.activeElement).toBe(heading);
    expect(within(primaryNav()).getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBe('page');
    expect(document.title).toBe('Settings · Square Hole');
  });

  it('moves focus to the heading of a lazy page too (Settings, then Boxes)', async () => {
    renderAt('/settings');
    await act(async () => fireEvent.click(within(primaryNav()).getByRole('link', { name: 'Boxes' })));
    expect(location()).toBe('/');
    const heading = await screen.findByRole('heading', { level: 1, name: 'Boxes' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it('opens a new page at the top, but leaves Back/Forward positions alone', async () => {
    renderAt('/', { withHistoryBack: true });
    const scrollTo = vi.mocked(window.scrollTo);
    scrollTo.mockClear();
    await act(async () => fireEvent.click(within(primaryNav()).getByRole('link', { name: 'Settings' })));
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    scrollTo.mockClear();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'History back' })));
    expect(location()).toBe('/');
    expect(scrollTo).not.toHaveBeenCalledWith(0, 0);
  });

  it('marks Boxes current on a box page, and nothing on a page outside the navigation (the FIT pair page)', () => {
    renderAt('/box/31337/0x000000000000000000000000000000000000f17e');
    expect(within(primaryNav()).getByRole('link', { name: 'Boxes' }).getAttribute('aria-current')).toBe('page');
    cleanup();
    renderAt('/fit-pair');
    expect(within(primaryNav()).queryByRole('link', { current: 'page' })).toBeNull();
  });
});

describe('compact menu', () => {
  it('toggles with aria-expanded and closes on Escape, returning focus to the toggle', () => {
    renderAt('/');
    const toggle = screen.getByRole('button', { name: 'Menu' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(primaryNav().id);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(primaryNav().getAttribute('data-open')).toBe('true');
    const feedLink = within(primaryNav()).getByRole('link', { name: 'Boxes' });
    feedLink.focus();
    fireEvent.keyDown(feedLink, { key: 'Escape' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
  });

  it('closes on Escape while focus is on the toggle itself', () => {
    renderAt('/');
    const toggle = screen.getByRole('button', { name: 'Menu' });
    fireEvent.click(toggle);
    toggle.focus();
    fireEvent.keyDown(toggle, { key: 'Escape' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
  });

  it.each<[string, () => Promise<void>]>([
    [
      'a nav link',
      async () => {
        fireEvent.click(within(primaryNav()).getByRole('link', { name: 'Settings' }));
      },
    ],
    [
      'a feed sort',
      async () => {
        fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'progress' } });
      },
    ],
  ])('stays closed when history returns to the entry it was opened on (left via %s)', async (_via, leave) => {
    renderAt('/', { withHistoryBack: true });
    await screen.findByRole('heading', { level: 1, name: 'Boxes' });
    const menu = () => screen.getByRole('button', { name: 'Menu' });
    fireEvent.click(menu());
    expect(menu().getAttribute('aria-expanded')).toBe('true');
    await act(leave);
    expect(location()).not.toBe('/');
    expect(menu().getAttribute('aria-expanded')).toBe('false');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'History back' })));
    expect(location()).toBe('/');
    expect(menu().getAttribute('aria-expanded')).toBe('false');
  });

  it('closes after navigating', async () => {
    renderAt('/');
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    await act(async () => fireEvent.click(within(primaryNav()).getByRole('link', { name: 'Settings' })));
    expect(location()).toBe('/settings');
    expect(screen.getByRole('button', { name: 'Menu' }).getAttribute('aria-expanded')).toBe('false');
  });
});

describe('the single discovery search (SH-006)', () => {
  it('lives in the box feed controls; the header only has a trigger', async () => {
    renderAt('/');
    expect(await screen.findAllByRole('searchbox')).toHaveLength(1);
    expect(within(screen.getByRole('banner')).queryByRole('searchbox')).toBeNull();
    expect(within(screen.getByRole('banner')).getByRole('button', { name: 'Search boxes' })).toBeTruthy();
  });

  it('the header trigger opens the box feed from another page and focuses the search field', async () => {
    renderAt('/launch');
    expect(screen.queryByRole('searchbox')).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Search boxes' })));
    expect(location()).toBe('/');
    // The box feed is a lazy page: it takes the focus request over once it has loaded.
    await waitFor(() => expect(document.activeElement).toBe(boxSearch()));
  });

  it('"/" opens the box feed search from elsewhere, and focuses it on the feed', async () => {
    renderAt('/settings');
    await act(async () => fireEvent.keyDown(document.body, { key: '/' }));
    expect(location()).toBe('/');
    await waitFor(() => expect(document.activeElement).toBe(boxSearch()));
    boxSearch().blur();
    await act(async () => fireEvent.keyDown(document.body, { key: '/' }));
    expect(document.activeElement).toBe(boxSearch());
  });

  it('"/" typed inside a field stays text', async () => {
    renderAt('/');
    (await screen.findByRole('searchbox', { name: 'Search boxes, tokens or a wallet' })).focus();
    expect(fireEvent.keyDown(boxSearch(), { key: '/' })).toBe(true); // default not prevented
  });

  it('the box feed search writes ?q= in place (replacing the history entry) and filters the boxes', async () => {
    renderAt('/', { withHistoryBack: true, before: ['/settings'] });
    await screen.findByRole('searchbox', { name: 'Search boxes, tokens or a wallet' });
    await act(async () => fireEvent.change(boxSearch(), { target: { value: '  pots ' } }));
    expect(location()).toBe('/?q=pots');
    expect(screen.getAllByRole('link', { name: /^Clay Pots,/ })).toHaveLength(1);
    expect(screen.queryByRole('link', { name: /^Paper Kites,/ })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'History back' })));
    expect(location()).toBe('/settings');
  });

  it('the pair feed (/pairs) keeps its debounced search, replacing the history entry', async () => {
    legacyAt('/pairs', { withHistoryBack: true, before: ['/settings'] });
    fireEvent.change(searchbox(), { target: { value: '  orchard ' } });
    expect(location()).toBe('/pairs');
    await pause(SEARCH_DEBOUNCE_MS + 60);
    expect(location()).toBe('/pairs?q=orchard');
    expect(await screen.findByText('2 pairs')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'History back' })));
    expect(location()).toBe('/settings');
  });

  it('reflects the URL query and keeps the feed filters', async () => {
    legacyAt('/pairs?type=nft_collection&q=tree');
    expect(searchbox().value).toBe('tree');
    fireEvent.change(searchbox(), { target: { value: 'frame' } });
    await act(async () => fireEvent.submit(searchbox().closest('form') as HTMLFormElement));
    expect(location()).toBe('/pairs?q=frame&type=nft_collection');
  });
});

describe('the first handoff’s pair feed (SH-005…SH-007 jsdom smoke; unrouted since F134 R46B, mounted for its tests)', () => {
  it('pins the platform outside the results and lists organic pairs by market cap', async () => {
    legacyAt('/pairs');
    await screen.findByText('11 pairs');
    const pin = screen.getByRole('region', { name: 'Platform pin' });
    expect(within(pin).getByRole('heading', { name: /Square Hole/ })).toBeTruthy();
    expect(pin.textContent).toContain('Platform');
    expect(pin.textContent).toContain('Ticker not set');
    expect(pin.textContent).not.toMatch(/#\d|\brank|crown/i);
    expect(screen.getByText('11 pairs').getAttribute('role')).toBe('status');
    const table = screen.getByRole('table', { name: 'Launched pairs' });
    const ids = Array.from(table.querySelectorAll('[data-pair-id]'), (row) => row.getAttribute('data-pair-id')?.slice(-2));
    expect(ids).toEqual(['66', '67', '68', '69', '6a', '6b', '6c', '6d', '6e', '6f', '70']);
  });

  it('changing a sort pushes ?sort= and shows the provider order', async () => {
    legacyAt('/pairs');
    await screen.findByText('11 pairs');
    await act(async () => fireEvent.click(radio('New')));
    expect(location()).toBe('/pairs?sort=new');
    await waitFor(() => {
      const first = screen.getByRole('table', { name: 'Launched pairs' }).querySelector('[data-pair-id]');
      expect(first?.getAttribute('data-pair-id')?.endsWith('70')).toBe(true);
    });
  });

  it('two quick changes before the router commits both land in the URL', async () => {
    legacyAt('/pairs');
    await screen.findByText('11 pairs');
    await act(async () => {
      fireEvent.click(radio('Tokens'));
      fireEvent.change(screen.getByLabelText('Fee share in'), { target: { value: 'T' } });
    });
    expect(location()).toBe('/pairs?type=token&reward=T');
    expect(radio('Tokens').checked).toBe(true);
    expect(await screen.findByText('2 pairs')).toBeTruthy();
  });

  it('shows "No pairs match" with "Clear search" for an empty search', async () => {
    legacyAt('/pairs?q=zzz');
    expect(await screen.findByRole('heading', { name: 'No pairs match' })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Clear search' })));
    expect(location()).toBe('/pairs');
    expect(await screen.findByText('11 pairs')).toBeTruthy();
  });

  // WCAG 2.4.3: both buttons live in the "No pairs match" panel, which unmounts once results return.
  it('"Clear search" keeps keyboard focus: it moves to the emptied search field', async () => {
    legacyAt('/pairs?q=zzz');
    const clear = await screen.findByRole('button', { name: 'Clear search' });
    clear.focus();
    await act(async () => fireEvent.click(clear));
    expect(await screen.findByText('11 pairs')).toBeTruthy();
    expect(document.activeElement).toBe(searchbox());
    expect(searchbox().value).toBe('');
  });

  it('"Reset filters" keeps keyboard focus: it moves to the first filter control', async () => {
    legacyAt('/pairs?type=nft_collection&lifecycle=graduating');
    const reset = await screen.findByRole('button', { name: 'Reset filters' });
    reset.focus();
    await act(async () => fireEvent.click(reset));
    expect(await screen.findByText('11 pairs')).toBeTruthy();
    expect(location()).toBe('/pairs');
    expect(document.activeElement).toBe(radio('All'));
    expect(radio('All').checked).toBe(true);
  });

  it('the unavailable scenario shows an alert with "Try again"', async () => {
    legacyAt('/pairs?scenario=unavailable');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Feed unavailable');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('remembers a collapsed pin', async () => {
    const first = legacyAt('/pairs');
    await screen.findByText('11 pairs');
    fireEvent.click(screen.getByRole('button', { name: 'Hide platform pin' }));
    expect(screen.getByRole('button', { name: 'Show platform pin' }).getAttribute('aria-expanded')).toBe('false');
    first.unmount();
    legacyAt('/pairs');
    expect(screen.getByRole('button', { name: 'Show platform pin' })).toBeTruthy();
  });
});

describe('routes', () => {
  it('/ renders the Boxes page with its heading; the old pair feed (mounted for its tests) its own', async () => {
    renderAt('/');
    const boxes = await screen.findByRole('region', { name: 'Boxes' });
    expect(within(boxes).getByRole('heading', { level: 1, name: 'Boxes' })).toBeTruthy();
    expect(document.title).toBe('Boxes · Square Hole');
    cleanup();
    legacyAt('/pairs');
    const region = screen.getByRole('region', { name: 'Feed' });
    expect(within(region).getByRole('heading', { level: 1, name: 'Feed' })).toBeTruthy();
    expect(document.title).toBe('Feed · Square Hole');
  });

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', ''])(
    '/pairs?type=%s is not a known feed type: the feed renders with "All" selected',
    async (type) => {
      legacyAt(`/pairs?type=${type}`);
      const region = screen.getByRole('region', { name: 'Feed' });
      expect(within(region).getByRole('heading', { level: 1, name: 'Feed' })).toBeTruthy();
      expect(primaryNav()).toBeTruthy();
      expect(radio('All').checked).toBe(true);
      expect(within(primaryNav()).queryByRole('link', { current: 'page' })).toBeNull();
      expect(await screen.findByText('11 pairs')).toBeTruthy();
    },
  );

  it('/pairs?type=__proto__ does not break the search', async () => {
    legacyAt('/pairs?type=__proto__&q=orchard');
    expect(searchbox().value).toBe('orchard');
    expect(radio('All').checked).toBe(true);
    expect(await screen.findByText('2 pairs')).toBeTruthy();
  });

  it.each([
    ['token', 'Tokens'],
    ['nft_collection', 'NFT collections'],
  ])('/pairs?type=%s selects its type', (type, label) => {
    legacyAt(`/pairs?type=${type}`);
    expect(radio(label).checked).toBe(true);
  });

  // F134 R46B (founder 2026-10-11): the first handoff's pages are off in every build, as on the production site since
  // SH-V2-FE6. Their links open the boxes and My Box, and nothing of the old fixture (its -DEMO coins) shows.
  it.each([
    ['/pairs', '/'],
    ['/pairs?type=nft_collection&q=orch', '/'],
    ['/collections', '/'],
    ['/pair/31337/0x0000000000000000000000000000000000000066', '/'],
    ['/?q=orch&type=token', '/?q=orch'],
    ['/rewards', '/my-box'],
    ['/rewards?pair=31337%3A0x000000000000000000000000000000000000006a', '/my-box'],
    ['/portfolio', '/my-box'],
  ])('%s is off in every build: it opens %s (F134 R46B)', async (path, target) => {
    renderAt(path);
    expect(await screen.findByRole('heading', { level: 1 }, { timeout: 3000 })).toBeTruthy();
    expect(location()).toBe(target);
    expect(document.body.textContent).not.toMatch(/-DEMO\b|ORCHARD|Launched pairs/);
  });

  it('/about/risks is the plain-language risks page (UI-03), not a placeholder', () => {
    renderAt('/about/risks');
    expect(screen.getByRole('heading', { level: 1, name: 'About & risks' })).toBeTruthy();
    expect(screen.getByRole('main').textContent).not.toContain('Arrives in');
    // SH-V2-FE7: the core v2 cards, no longer the first handoff's production gates.
    expect(screen.getByRole('heading', { level: 2, name: 'Failure & claim' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 2, name: 'Production gates' })).toBeNull();
  });

  it('/about/terms is the draft Terms of Use page (F19), linked from the footer next to About & risks', () => {
    renderAt('/about/terms');
    expect(screen.getByRole('heading', { level: 1, name: 'Square Hole Terms of Use' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: '5. The Services and how Square Hole works' })).toBeTruthy();
    const footer = screen.getByRole('contentinfo');
    expect(within(footer).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['About & risks', '/about/risks'],
      ['Terms of use', '/about/terms'],
      ['Privacy', '/about/privacy'],
    ]);
    // Not a primary navigation item: no nav link is current on this page.
    expect(within(primaryNav()).queryByRole('link', { current: 'page' })).toBeNull();
  });

  it('/about/privacy is the draft privacy notice (Fable review S1), linked from the footer', () => {
    renderAt('/about/privacy');
    expect(screen.getByRole('heading', { level: 1, name: 'Privacy notice' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'What stays on your device' })).toBeTruthy();
    expect(within(screen.getByRole('contentinfo')).getByRole('link', { name: 'Privacy' }).getAttribute('href')).toBe('/about/privacy');
    expect(within(primaryNav()).queryByRole('link', { current: 'page' })).toBeNull();
  });

  // SH-014 / SH-015 part 2 (unrouted since F134 R46B). Without a wallet they explain what they need and offer a button.
  it.each([
    ['/rewards', 'Claims', 'Connect a wallet to see your claims'],
    ['/portfolio', 'Portfolio', 'Connect a wallet to see your portfolio'],
  ])('%s (mounted for its tests) asks for a wallet only through an explicit button (UI-09)', (path, heading, prompt) => {
    legacyAt(path);
    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: prompt })).toBeTruthy();
    expect(within(screen.getByRole('main')).getByRole('button', { name: 'Connect wallet' }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('main').textContent).not.toContain('Arrives in');
  });

  it('/settings shows the local preferences', () => {
    renderAt('/settings');
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Motion' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Press / to search' })).toBeTruthy();
    expect(screen.getByRole('main').textContent).not.toContain('Arrives in');
  });

  it('/pair/:chainId/:address shows the read-only pair detail with its artwork', async () => {
    legacyAt('/pair/31337/0x0000000000000000000000000000000000000066');
    expect(await screen.findByRole('heading', { level: 1, name: 'ORCHARD' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Smiling cartoon apple tree beside a box with a glowing square hole' })).toBeTruthy();
    expect(screen.getByRole('main').textContent).not.toContain('Arrives in');
  });

  it('shows the unavailable-artwork state for a pair without art', async () => {
    legacyAt('/pair/31337/0x0000000000000000000000000000000000000070');
    expect(await screen.findByRole('img', { name: 'Artwork not uploaded' })).toBeTruthy();
  });

  it('rejects malformed pair routes without guessing a pair', () => {
    legacyAt('/pair/31337/0x1234');
    expect(screen.getByRole('heading', { level: 1, name: 'Not a valid pair address' })).toBeTruthy();
  });

  it('unknown paths render the not-found page with the joke', () => {
    renderAt('/definitely/not/here');
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(screen.getByRole('main').textContent).toContain("That's right. The square hole.");
    expect(screen.getByRole('link', { name: 'Back to the feed' }).getAttribute('href')).toBe('/');
  });
});

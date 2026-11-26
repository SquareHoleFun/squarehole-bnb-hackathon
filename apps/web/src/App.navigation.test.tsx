import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { TERMS_GATE } from './features/legal';
import { acceptTermsForTests } from './test-support/terms';
import { shAsyncUtilTimeout } from '../../../vitest.timeouts.mjs';

// The production router (BrowserRouter over jsdom's window.history), unlike App.test.tsx's MemoryRouter harness.

// A lazily loaded page's heading: 3 s as before; SH_TEST_TIMEOUT (opt-in, slower machines) may raise the wait, never lower it.
const PAGE_WAIT_MS = Math.max(3000, shAsyncUtilTimeout() ?? 0);

beforeEach(() => {
  // jsdom does not implement scrolling; the feed's Back/Forward scroll restoration calls it.
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  window.history.replaceState(null, '', '/');
  // The entry terms gate (F19) is covered below and in features/legal; these tests start as an accepted visitor.
  acceptTermsForTests();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});

function nextPopState(): Promise<void> {
  return new Promise((resolve) => window.addEventListener('popstate', () => resolve(), { once: true }));
}

describe('App navigation (FEED-05, M1 integration)', () => {
  // The pair feed this test was written for is off in every build (F134 R46B); the box feed writes its URL the same way.
  it('Back before a view change has rendered: the controls follow the URL and the next change starts from it (box feed)', async () => {
    render(<App />);
    const view = await screen.findByRole('group', { name: 'View' });

    await act(async () => {
      const popped = nextPopState();
      fireEvent.click(within(view).getByRole('button', { name: 'List' }));
      window.history.back();
      await popped;
    });

    expect(window.location.search).toBe('');
    await waitFor(() => expect(within(view).getByRole('button', { name: 'Grid' }).getAttribute('aria-pressed')).toBe('true'));
    expect(within(view).getByRole('button', { name: 'List' }).getAttribute('aria-pressed')).toBe('false');

    await act(async () => fireEvent.click(within(screen.getByRole('group', { name: 'State' })).getByRole('button', { name: /^Bonding/ })));
    expect(window.location.search).toBe('?state=bonding');
    expect(within(view).getByRole('button', { name: 'Grid' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('entry terms gate in the app (F19)', () => {
  it('a first visit sees only the gate: no shell, no feed', () => {
    window.localStorage.clear();
    render(<App />);
    expect(screen.getByRole('dialog', { name: TERMS_GATE.title })).toBeTruthy();
    expect(screen.queryByRole('main')).toBeNull();
    expect(screen.queryByRole('banner')).toBeNull();
    expect(screen.queryByRole('heading', { level: 1, name: 'Boxes' })).toBeNull();
  });

  it('the full Terms are readable before accepting, in a frame without wallet, launch or search controls', () => {
    window.localStorage.clear();
    window.history.replaceState(null, '', '/about/terms');
    render(<App />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Square Hole Terms of Use' })).toBeTruthy();
    const banner = screen.getByRole('banner');
    expect(within(banner).queryByRole('button', { name: 'Connect wallet' })).toBeNull();
    expect(within(banner).queryByRole('link', { name: 'Launch pair' })).toBeNull();
    expect(within(banner).queryByRole('button', { name: 'Search boxes' })).toBeNull();
    // The "/" shortcut belongs to the search trigger, so it is gone too.
    fireEvent.keyDown(document.body, { key: '/' });
    expect(window.location.pathname).toBe('/about/terms');
  });

  it('after accepting, the same page has the full frame again', () => {
    window.history.replaceState(null, '', '/about/terms');
    render(<App />);
    const banner = screen.getByRole('banner');
    expect(within(banner).getByRole('button', { name: 'Connect wallet' })).toBeTruthy();
    // The launch set took "Launch pair" out of the top bar (Launch keeps its route).
    expect(within(banner).queryByRole('link', { name: 'Launch pair' })).toBeNull();
    expect(within(banner).getByRole('button', { name: 'Search boxes' })).toBeTruthy();
  });
});

describe('routes of the launch set (BrowserRouter)', () => {
  it('/ is the feed of boxes; the first handoff’s pair feed and its NFT filter open it too (F134 R46B)', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Boxes' })).toBeTruthy();
    for (const path of ['/pairs', '/collections', '/pair/31337/0x0000000000000000000000000000000000000066']) {
      cleanup();
      window.history.replaceState(null, '', path);
      render(<App />);
      await waitFor(() => expect(`${window.location.pathname}${window.location.search}`, path).toBe('/'));
      expect(await screen.findByRole('heading', { level: 1, name: 'Boxes' })).toBeTruthy();
    }
  });

  it.each(['/misfits', '/fit', '/misfits?scenario=window'])('%s opens the box of this source’s FIT market (Demo), keeping the query', async (path) => {
    window.history.replaceState(null, '', path);
    render(<App />);
    const query = path.includes('?') ? path.slice(path.indexOf('?')) : '';
    // The whole App renders here; under the full verify load the default 1 s wait was missed (passes alone in ~0.7 s).
    await waitFor(() => expect(`${window.location.pathname}${window.location.search}`).toBe(`/box/31337/0x000000000000000000000000000000000000f17e${query}`), { timeout: 5000 });
    expect(await screen.findByRole('heading', { level: 1, name: 'The Misfits' }, { timeout: 5000 })).toBeTruthy();
  });

  it('the old pages keep their routes: /fit-pair, /launch; Claims and Portfolio open My Box (F134 R46B)', async () => {
    for (const [path, heading] of [
      ['/fit-pair', /FIT/],
      ['/launch', /Launch/],
      ['/rewards', 'My Box'],
      ['/portfolio', 'My Box'],
    ] as const) {
      window.history.replaceState(null, '', path);
      render(<App />);
      expect(await screen.findByRole('heading', { level: 1, name: heading }, { timeout: PAGE_WAIT_MS }), path).toBeTruthy();
      if (path === '/rewards' || path === '/portfolio') expect(window.location.pathname).toBe('/my-box');
      cleanup();
    }
  });
});

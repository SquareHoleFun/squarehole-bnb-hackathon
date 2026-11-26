// @vitest-environment jsdom
/**
 * SH-261: the BNB Chain testnet build lists the demo boxes that exist on chain 97, each linked to its box page; the
 * Sepolia build lists none. SH-324: the list has its own address (`DEMO_BOXES_PATH`, /examples/boxes), as `/examples`
 * opens the explainer on both networks. The BNB build's modules are loaded again with SH_TESTNET=bnb stubbed, as
 * testnet-bnb.test.ts does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import list from './demo-boxes-97.json' with { type: 'json' };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('the demo boxes of chain 97 (SH-261)', () => {
  it('the list comes from the real runs: chain 97, a name, a ticker and a token each', () => {
    expect(list.schema).toBe('squarehole.demo-boxes/1');
    expect(list.chainId).toBe(97);
    expect(list.boxes.map((box) => box.id)).toEqual(['stock', 'rentfree']);
    for (const box of list.boxes) {
      expect(box.chainId).toBe(97);
      expect(box.token).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(box.coordinator).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
    expect(list.boxes.map((box) => [box.name, box.ticker])).toEqual([['GPU Poor', 'VRAM'], ['Rent Free', 'RENT']]);
  });

  it('the Sepolia build lists none (it keeps the explainer)', async () => {
    const page = await import('./DemoBoxesPage');
    expect(page.demoBoxes()).toEqual([]);
  });

  it('the BNB build lists each box with a link to its box page', async () => {
    vi.stubEnv('SH_TESTNET', 'bnb');
    vi.resetModules();
    // The page, the router and the renderer from the same fresh module graph (one React).
    const [page, { MemoryRouter }, { render, screen, cleanup }] = await Promise.all([import('./DemoBoxesPage'), import('react-router'), import('@testing-library/react')]);
    expect(page.demoBoxes().map((box) => box.id)).toEqual(['stock', 'rentfree']);
    render(<MemoryRouter><page.DemoBoxesPage /></MemoryRouter>);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Examples');
    for (const box of list.boxes) {
      const link = screen.getByRole('link', { name: box.name });
      expect(link.getAttribute('href')).toBe(`/box/97/${box.token.toLowerCase()}`);
    }
    cleanup();
  });

  it('SH-324: the routes of a BNB build: /examples opens the explainer, /examples/boxes lists the demo boxes', async () => {
    vi.stubEnv('SH_TESTNET', 'bnb');
    vi.resetModules();
    const [{ AppRoutes }, { AppProviders }, examples, { MemoryRouter }, { render, screen, cleanup, waitFor }] = await Promise.all([
      import('../../routes'), import('../../app-providers'), import('./index'), import('react-router'), import('@testing-library/react')]);
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const go = vi.spyOn(examples.examplesNavigation, 'go').mockImplementation(() => undefined);
    const at = (path: string) => render(<AppProviders><MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter></AppProviders>);
    at(examples.EXAMPLES_PATH);
    await waitFor(() => expect(go).toHaveBeenCalledWith('/examples/index.html'));
    expect(screen.queryByRole('heading', { level: 1, name: 'Examples' })).toBeNull();
    cleanup();
    at(examples.DEMO_BOXES_PATH);
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Examples');
    for (const box of list.boxes) expect(screen.getByRole('link', { name: box.name }).getAttribute('href')).toBe(`/box/97/${box.token.toLowerCase()}`);
    expect(go).toHaveBeenCalledTimes(1);
    cleanup();
    vi.restoreAllMocks();
  });

  it('SH-324: the routes of a Sepolia build: /examples opens the explainer, /examples/boxes (no demo boxes) leads to Launch', async () => {
    const [{ AppRoutes }, { AppProviders }, examples, { MemoryRouter, useLocation }, { render, screen, cleanup, waitFor }] = await Promise.all([
      import('../../routes'), import('../../app-providers'), import('./index'), import('react-router'), import('@testing-library/react')]);
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const go = vi.spyOn(examples.examplesNavigation, 'go').mockImplementation(() => undefined);
    function Where() {
      return <output data-testid="where">{useLocation().pathname}</output>;
    }
    render(<AppProviders><MemoryRouter initialEntries={[examples.DEMO_BOXES_PATH]}><AppRoutes /><Where /></MemoryRouter></AppProviders>);
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/create/v2-picture'));
    expect(go).not.toHaveBeenCalled();
    cleanup();
    vi.restoreAllMocks();
  });
});

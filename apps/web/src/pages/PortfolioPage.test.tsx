/** /portfolio (SH-014): economic units once, whole NFTs + fraction beneath, NFT ids, links, honest empty states. */
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, connectAs, expectNoAmountInputs, flush, location, main, renderM3 } from '../test-support/m3';

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function open(path = '/portfolio') {
  renderM3(path, { legacy: true });
  await flush();
}

const position = (name: string) => {
  const heading = screen.getByRole('heading', { level: 3, name: new RegExp(`^${name}\\b`) });
  return heading.closest('article') as HTMLElement;
};
const figure = (card: HTMLElement, name: string) => card.querySelector(`[data-figure="${name}"] dd`)?.textContent ?? null;

describe('/portfolio', () => {
  it('disconnected: says what it needs, offers Connect wallet, and still explains fractions', async () => {
    await open();
    expect(screen.getByRole('heading', { level: 1, name: 'Portfolio' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Connect a wallet to see your portfolio' })).toBeTruthy();
    expect(within(main()).getByRole('button', { name: 'Connect wallet' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Fractions are not a piece of a particular NFT' })).toBeTruthy();
    expect(main().textContent).toContain('does not mean owning a quarter of any specific NFT, rare or not');
    expect(screen.getByRole('heading', { level: 3, name: 'Before you trade externally' })).toBeTruthy();
    expect(main().querySelector('article')).toBeNull();
  });

  it('current holder: each balance once, with whole NFTs, the fraction and NFT ids beneath', async () => {
    await open();
    await connectAs('Current holder');
    expect(screen.getByTestId('account-bar').textContent).toContain('Current holder');
    const orchard = position('ORCHARD');
    expect(figure(orchard, 'balance')).toBe('3.25 ORCH');
    expect(figure(orchard, 'representation')).toContain('3 whole NFTs + 0.25 ORCH, not yet a whole NFT');
    expect(figure(orchard, 'representation')).toContain('The same ORCH as the balance above, not extra. 1 NFT = 1 ORCH.');
    expect(within(orchard).getByRole('list', { name: 'ORCHARD NFT ids' }).textContent).toBe('#7#12#31');
    expect(figure(orchard, 'demo-value')).toContain('≈ $7.8');
    expect(figure(orchard, 'demo-value')).toContain('not a quote');
    expect(within(orchard).getByRole('link', { name: 'Pair detail: ORCHARD' }).getAttribute('href')).toBe(
      '/pair/31337/0x0000000000000000000000000000000000000066',
    );
    expect(within(orchard).getByText('Route unverified')).toBeTruthy();

    const frames = position('TINY FRAMES');
    expect(figure(frames, 'balance')).toBe('0.5 FRAME');
    expect(figure(frames, 'representation')).toContain('0 whole NFTs + 0.5 FRAME, not yet a whole NFT');
    expect(figure(frames, 'nft-ids')).toContain('None listed');

    const round = position('ROUND TRIP');
    expect(figure(round, 'balance')).toBe('1,500 ROUND');
    expect(figure(round, 'representation')).toBe('Tokens only (no NFT representation)');
    expect(round.querySelector('[data-figure="nft-ids"]')).toBeNull();
    expectNoAmountInputs(main());
    expect(within(main()).queryByRole('button', { name: /buy|sell|swap/i })).toBeNull();
  });

  it('links a position to its rewards with ?pair= preselected', async () => {
    await open();
    await connectAs('Current holder');
    await click(within(position('ORCHARD')).getByRole('link', { name: 'Claims for ORCHARD' }));
    await flush();
    expect(location()).toBe('/rewards?pair=31337%3A0x0000000000000000000000000000000000000066');
    const first = main().querySelector('article');
    expect(first?.getAttribute('data-pair-id')).toBe('31337:0x0000000000000000000000000000000000000066');
    expect(first?.hasAttribute('data-selected')).toBe(true);
  });

  it('past holder: no current balances, and a pointer to the rewards it still has (ECO-05)', async () => {
    await open();
    await connectAs('Past holder');
    const empty = screen.getByTestId('portfolio-empty');
    expect(empty.textContent).toContain('No current balances');
    expect(within(empty).getByRole('link', { name: 'See your claims' }).getAttribute('href')).toBe('/rewards');
  });

  it('never held: no balances and no rewards pointer', async () => {
    await open();
    await connectAs('Never held');
    const empty = screen.getByTestId('portfolio-empty');
    expect(within(empty).queryByRole('link', { name: 'See your claims' })).toBeNull();
    expect(within(empty).getByRole('link', { name: 'Browse the feed' })).toBeTruthy();
  });

  it('unavailable account data is a failure with a retry, not an empty portfolio', async () => {
    await open('/portfolio?scenario=unavailable');
    await connectAs('Current holder');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Balances unavailable');
    expect(alert.textContent).toContain('a failed read, not an empty portfolio');
    expect(screen.queryByTestId('portfolio-empty')).toBeNull();
  });
});

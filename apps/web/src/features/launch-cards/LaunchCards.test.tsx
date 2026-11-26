/**
 * SH-289: the launch cards on the Boxes page: read only once the boxes have answered, the cards, the search, the
 * failure line with "Try again", and nothing on another network.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LaunchCards } from './LaunchCards';
import type { LaunchCardData } from './launch-reads';

afterEach(cleanup);
const CARDS: LaunchCardData[] = [
  { rail: 'flap', address: '0x0000000000000000000000000000000000000011', name: 'Kite Sale', symbol: 'KITE', state: 'Raised 0.05 of 1 BNB', rules: 'pile 100', href: '/launches/#/flap/0x0000000000000000000000000000000000000011', picture: null },
  { rail: 'four', address: '0x0000000000000000000000000000000000000041', name: 'Moon Four', symbol: 'MOON', state: 'On PancakeSwap', rules: 'pile 100', href: '/launches/#/four/0x0000000000000000000000000000000000000041', picture: null },
];
const shown = (ui: ReactElement) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

describe('the launch cards', () => {
  it('wait for the boxes: no read before, then one card per launch with its rail, state, rule line and page', async () => {
    const load = vi.fn(async () => CARDS);
    const view = shown(<LaunchCards network="bnb" ready={false} query="" load={load} />);
    expect(screen.getByText('Reading the launches…')).toBeTruthy();
    expect(load).not.toHaveBeenCalled();
    view.rerender(<QueryClientProvider client={new QueryClient()}><LaunchCards network="bnb" ready query="" load={load} /></QueryClientProvider>);
    const list = await screen.findByRole('list', { name: 'Launches' });
    const kite = within(list).getByRole('link', { name: 'Kite Sale, KITE, Flap' });
    expect(kite.getAttribute('href')).toBe('/launches/#/flap/0x0000000000000000000000000000000000000011');
    expect(within(kite).getByText('Raised 0.05 of 1 BNB')).toBeTruthy();
    expect(within(kite).getByText('pile 100')).toBeTruthy();
    expect(within(list).getByRole('link', { name: 'Moon Four, MOON, Four.meme' })).toBeTruthy();
    expect(within(list).getByText('On PancakeSwap')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('the search finds them by name or symbol', async () => {
    shown(<LaunchCards network="bnb" ready query="moon" load={async () => CARDS} />);
    const list = await screen.findByRole('list', { name: 'Launches' });
    expect(within(list).getAllByRole('link').map((l) => l.getAttribute('aria-label'))).toEqual(['Moon Four, MOON, Four.meme']);
  });

  it('a failed read: one line with Try again, which reads again', async () => {
    const load = vi.fn<() => Promise<LaunchCardData[]>>().mockRejectedValueOnce(new Error('refused')).mockResolvedValueOnce(CARDS);
    shown(<LaunchCards network="bnb" ready query="" load={load} />);
    expect(await screen.findByText('Could not read the launches.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('list', { name: 'Launches' })).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('another network: nothing, and no read', () => {
    const load = vi.fn(async () => CARDS);
    const { container } = shown(<LaunchCards network="sepolia" ready query="" load={load} />);
    expect(container.innerHTML).toBe('');
    expect(load).not.toHaveBeenCalled();
  });
});

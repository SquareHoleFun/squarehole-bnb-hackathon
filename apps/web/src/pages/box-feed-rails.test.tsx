import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { AppProviders } from '../app-providers';
import { loadLaunchCards, type LaunchCardData } from '../features/launch-cards/launch-reads';
import { BoxFeedPage } from './BoxFeedPage';

vi.hoisted(() => vi.stubEnv('SH_TESTNET', 'bnb'));
vi.mock('../features/launch-cards/launch-reads', () => ({ loadLaunchCards: vi.fn() }));
afterEach(cleanup);
afterAll(() => vi.unstubAllEnvs());

const cards: LaunchCardData[] = [
  { rail: 'flap', name: 'Kite', symbol: 'KITE', address: '0x01', href: '/launches/#/flap/0x01', state: 'Launched', rules: null, picture: null },
  { rail: 'four', name: 'Moon', symbol: 'MOON', address: '0x02', href: '/launches/#/four/0x02', state: 'On PancakeSwap', rules: null, picture: null },
];

function open(url: string, launches = cards) {
  vi.mocked(loadLaunchCards).mockResolvedValue(launches);
  const router = createMemoryRouter([{ path: '/', element: <BoxFeedPage /> }], { initialEntries: [url] });
  render(<AppProviders><RouterProvider router={router} /></AppProviders>);
  return router;
}

const tabs = () => within(screen.getByRole('group', { name: 'Launch on' }));
const choose = (name: string) => fireEvent.click(tabs().getByRole('link', { name }));
const listed = async () => within(await screen.findByRole('list', { name: 'Launches' })).getAllByRole('link').map((link) => link.getAttribute('aria-label'));

it('keeps all cards and controls under Boxes and selects each launch view from its URL, including Back', async () => {
  const router = open('/');
  expect(await listed()).toEqual(['Kite, KITE, Flap', 'Moon, MOON, Four.meme']);
  expect(screen.getByRole('list', { name: 'Boxes' })).toBeTruthy();
  expect(screen.getByRole('group', { name: 'State' })).toBeTruthy();
  expect(document.querySelector('.sh-box-feed__count')?.textContent).toMatch(/\d+ boxes/);
  expect(screen.getByRole('link', { name: 'Launch a box' }).getAttribute('href')).toBe('/create');

  for (const [rail, name, card] of [['flap', 'Flap', 'Kite, KITE, Flap'], ['four', 'Four.meme', 'Moon, MOON, Four.meme']]) {
    choose(`On ${name}`);
    expect(router.state.location.search).toBe(`?on=${rail}`);
    expect(await listed()).toEqual([card]);
    expect(tabs().getByText(`On ${name}`).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: `Launch on ${name}` }).getAttribute('href')).toBe(`/launches/#/${rail}/create`);
    expect(screen.queryByRole('link', { name: 'Launch a box' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Boxes' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'State' })).toBeNull();
    expect(document.querySelector('.sh-box-feed__count, .sh-box-controls')).toBeNull();
  }

  await act(() => router.navigate(-1));
  expect(router.state.location.search).toBe('?on=flap');
  expect(await listed()).toEqual(['Kite, KITE, Flap']);
  choose('Boxes');
  expect(router.state.location.search).toBe('');
  expect(await listed()).toHaveLength(2);
});

it('opens a shared Four.meme URL directly, shows the existing empty copy and keeps the box filters for the return', async () => {
  const router = open('/?view=list&on=four', cards.filter((card) => card.rail === 'flap'));
  expect(await screen.findByText('No launches yet')).toBeTruthy();
  expect(tabs().getByText('On Four.meme').getAttribute('aria-current')).toBe('page');
  expect(screen.queryByRole('list', { name: 'Launches' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Launch on Four.meme' }).getAttribute('href')).toBe('/launches/#/four/create');
  choose('Boxes');
  expect(router.state.location.search).toBe('?view=list');
  expect(screen.getByRole('table')).toBeTruthy();
  expect(screen.queryByText('No launches yet')).toBeNull();
});

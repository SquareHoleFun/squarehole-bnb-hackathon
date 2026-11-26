import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { currentEntry, parseRoute } from '../src/App';
import { usePageTitle } from '../src/lib/page-title';

vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useEffect: (effect: () => void) => effect(),
}));
afterEach(() => vi.unstubAllGlobals());

const address = '0x' + '1'.repeat(40);
it.each([
  ['#/', '', 'Launches', 'boxes'],
  ['#/flap', '', 'Launches', 'boxes'],
  ['#/four', '', 'Launches', 'boxes'],
  ['#/flap/create', '', 'Launch on Flap', 'launch'],
  ['#/four/create', '', 'Launch on Four.meme', 'launch'],
  [`#/flap/${address}`, 'Swap Deck', 'Swap Deck', 'boxes'],
  [`#/four/${address}`, 'Snip', 'Snip', 'boxes'],
  [`#/shop/${address}`, 'SDECK', 'SDECK cards', 'boxes'],
  [`#/pile/${address}`, '', 'Pile', 'boxes'],
  ['#/missing', '', 'Not found', undefined],
] as const)('%s sets the tab title and the current menu entry', (hash, detail, title, current) => {
  const route = parseRoute(hash);
  vi.stubGlobal('document', { title: '' });
  function Screen() {
    usePageTitle(route.name, detail);
    return null;
  }
  renderToStaticMarkup(createElement(Screen));
  expect(document.title).toBe(`${title} · Square Hole`);
  expect(currentEntry(route.name)).toBe(current);
});

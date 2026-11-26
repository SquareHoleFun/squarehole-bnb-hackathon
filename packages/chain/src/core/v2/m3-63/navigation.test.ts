// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { QueryClient, QueryClientProvider } from '../../../../../../apps/web/node_modules/@tanstack/react-query/build/modern/index.js';
import { cleanup, render } from '../../../../../../apps/web/node_modules/@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WalletProvider } from '../../../../../../apps/web/src/features/wallet/wallet-context';
import { createDemoWalletAdapter } from '../../../../../../apps/web/src/features/wallet/wallet-adapter';
import { ItemPayoutsV2 } from '../../../../../../apps/web/src/features/core/v2/ItemPayoutsV2';
import { CoinPileV2 } from '../../../../../../apps/web/src/features/core/v2/CoinPileV2';
import { ClaimAllV2 } from '../../../../../../apps/web/src/features/core/v2/ClaimAllV2';
import { parseSnapshotV2 } from '../../../../../../apps/web/src/features/core/v2/indexer-v2';
import { publishedItems, publishedPile } from '../../../../../../apps/web/src/features/core/v2/test-support/m3-published';

// Only the build-time deployment context is replaced. Panels, wallet provider and reads are real.
vi.mock('../../../../../../apps/web/src/features/data-source', () => ({ useDataSource: () => ({ id: 'demo' }) }));
vi.mock('../../../../../../apps/web/src/features/core/useCore', () => ({ BUILD_CORE: {} }));

const localRequire = createRequire(import.meta.url);
const { createElement } = localRequire('../../../../../../apps/web/node_modules/react') as typeof import('../../../../../../apps/web/node_modules/@types/react');
const { MemoryRouter } = localRequire('../../../../../../apps/web/node_modules/react-router/dist/development/index.js') as typeof import('../../../../../../apps/web/node_modules/react-router/dist/development/index');
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('M363-NAV: mounting, remounting and navigating between actual item, pile and Claim all panels ask no wallet', async () => {
  const request = vi.fn(async () => { throw new Error('unsolicited wallet request'); });
  vi.stubGlobal('ethereum', { request });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const adapter = createDemoWalletAdapter({ latencyMs: 0 }), connect = vi.spyOn(adapter, 'connect');
  const items = await publishedItems(), pile = await publishedPile({ failed: true });
  const itemView = parseSnapshotV2(items.body, items.source), pileView = parseSnapshotV2(pile.body, pile.source);
  const boxes = [{ key: 'items', view: itemView, source: items.source, name: 'Items', symbol: 'P', ticker: 'T', disabled: false }];
  const tree = (key: string, showPile: boolean) => createElement(QueryClientProvider, { client },
    createElement(MemoryRouter, {}, createElement(WalletProvider, { adapter, children: createElement('main', { key },
      showPile ? createElement(CoinPileV2, { view: pileView, source: pile.source, ticker: 'T', disabled: false })
        : createElement(ItemPayoutsV2, { view: itemView, source: items.source, symbol: 'P', ticker: 'T', disabled: false }),
      createElement(ClaimAllV2, { boxes, scope: showPile ? 'wallet' : 'box' }),
    ) })));
  const page = render(tree('item', false));
  expect(document.body.textContent).toContain('Item payouts');
  page.rerender(tree('pile', true)); expect(document.body.textContent).toContain('Coin pile');
  page.rerender(tree('back', false));
  await Promise.resolve();
  expect(connect).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  client.clear();
});

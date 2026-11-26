// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { QueryClient, QueryClientProvider } from '../../../../../../apps/web/node_modules/@tanstack/react-query/build/modern/index.js';
import { cleanup, render } from '../../../../../../apps/web/node_modules/@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WalletProvider } from '../../../../../../apps/web/src/features/wallet/wallet-context';
import { createDemoWalletAdapter } from '../../../../../../apps/web/src/features/wallet/wallet-adapter';
import { HolderEarningsV2 } from '../../../../../../apps/web/src/features/core/v2/HolderEarningsV2';
import { parseSnapshotV2 } from '../../../../../../apps/web/src/features/core/v2/indexer-v2';
import { publishedM2 } from '../../../../../../apps/web/src/features/core/v2/test-support/m2-published';

const localRequire = createRequire(import.meta.url);
const { createElement } = localRequire('../../../../../../apps/web/node_modules/react') as typeof import('../../../../../../apps/web/node_modules/@types/react');
const { MemoryRouter } = localRequire('../../../../../../apps/web/node_modules/react-router/dist/development/index.js') as typeof import('../../../../../../apps/web/node_modules/react-router/dist/development/index');

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('M263-NAV: mounting and navigating the real holder panel never requests a wallet', async () => {
  const request = vi.fn(async () => { throw new Error('unsolicited wallet request'); });
  vi.stubGlobal('ethereum', { request });
  const { source, body } = await publishedM2(true);
  const view = parseSnapshotV2(body, source), client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const adapter = createDemoWalletAdapter({ latencyMs: 0 }), connect = vi.spyOn(adapter, 'connect');
  const tree = (key: string) => createElement(QueryClientProvider, { client },
    createElement(MemoryRouter, {}, createElement(WalletProvider, { adapter, children:
      createElement(HolderEarningsV2, { key, view, source, symbol: 'P', disabled: false }) })));
  const page = render(tree('first'));
  expect(document.querySelector('[aria-label="Holder fee share"]')).toBeTruthy();
  page.rerender(tree('second'));
  await Promise.resolve();
  expect(connect).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  client.clear();
});

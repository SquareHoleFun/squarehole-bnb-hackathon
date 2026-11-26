// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { QueryClient, QueryClientProvider } from '../../../../../../apps/web/node_modules/@tanstack/react-query/build/modern/index.js';
import { cleanup, renderHook } from '../../../../../../apps/web/node_modules/@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useClaimsV2 } from '../../../../../../apps/web/src/features/core/v2/claim-reads';
import { parseSnapshotV2 } from '../../../../../../apps/web/src/features/core/v2/indexer-v2';
import { publishedPile } from '../../../../../../apps/web/src/features/core/v2/test-support/m3-published';
const localRequire = createRequire(import.meta.url);
const { createElement } = localRequire('../../../../../../apps/web/node_modules/react') as typeof import('../../../../../../apps/web/node_modules/@types/react');
type ReactNode = import('../../../../../../apps/web/node_modules/@types/react').ReactNode;
afterEach(cleanup);

it('M363-OC03: Claim all includes an owed failed-pile seed for its recorded seeder', async () => {
  const { body, source, seed } = await publishedPile({ failed: true, loaded: true });
  const parsed = parseSnapshotV2(body, source);
  if (!parsed.closing) throw new Error('missing closing fixture');
  // No other claim is due; the only money this wallet owns here is its retryable recorded seed.
  const view = { ...parsed, closing: { ...parsed.closing, tLeft: 0n, creatorEntitlement: 0n } };
  expect(view.m3?.pileMoney?.seedReturnDue).toBe(seed);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  const box = { key: 'pile', view, source, name: 'Pile', symbol: 'P', ticker: 'T', disabled: false };
  const { result } = renderHook(() => useClaimsV2([box], view.record.creator), { wrapper });
  expect(result.current[0]?.known).toBe(true);
  const steps = result.current[0]?.steps ?? [];
  client.clear();
  expect(steps.map(step => step.kind)).toContain('seed-return');
});

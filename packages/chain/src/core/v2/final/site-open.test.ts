// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { QueryClient, QueryClientProvider } from '../../../../../../apps/web/node_modules/@tanstack/react-query/build/modern/index.js';
import { cleanup, renderHook } from '../../../../../../apps/web/node_modules/@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { itemCandidates, itemsToRead, type ItemSession } from '../../../../../../apps/web/src/features/core/v2/item-claims';
import type { ItemsHistory } from '../../../../../../apps/web/src/features/core/v2/m3-data';
import { useClaimsV2 } from '../../../../../../apps/web/src/features/core/v2/claim-reads';
import { parseSnapshotV2 } from '../../../../../../apps/web/src/features/core/v2/indexer-v2';
import { publishedPile } from '../../../../../../apps/web/src/features/core/v2/test-support/m3-published';
import { A, H } from './wallet-fixture';

const localRequire = createRequire(import.meta.url);
const { createElement } = localRequire('../../../../../../apps/web/node_modules/react') as typeof import('../../../../../../apps/web/node_modules/@types/react');
type ReactNode = import('../../../../../../apps/web/node_modules/@types/react').ReactNode;
afterEach(cleanup);

describe('Inherited M363-OC01/03: unresolved site exits remain reachable', () => {
  it.each(['selected', 'mined'] as const)('the 24th owned item gets its %s deciding read within bounded work', reason => {
    const history: ItemsHistory = { policies: { buyers: 1, sellers: 0 }, outsideIndex: 1n, paidPerItem: 1n,
      fundedP: 24n, retainedBurnP: 0n, flushedP: 0n, fundingCursor: 1n, lifecycleCursor: 24n, openDraws: 0, noticesFailed: 0n,
      known: Array.from({ length: 24 }, (_, i) => ({ id: BigInt(i + 1), inside: false, sequence: BigInt(i + 1) })) };
    const session: ItemSession = reason === 'mined' ? { '24': { claim: { tx: H(7), block: 101n, paidP: 1n } } } : {};
    const candidates = itemCandidates(history, session, reason === 'selected' ? 24n : null);
    const reads = itemsToRead(candidates, new Map(candidates.map(id => [String(id), A])), session, A);
    expect(reads.length).toBeLessThanOrEqual(12);
    expect(reads).toContain(24n);
  });

  it('a fully backed failed-pile seed is a Claim all step even with no other wallet claim', async () => {
    const { body, source, seed } = await publishedPile({ failed: true, loaded: true });
    const parsed = parseSnapshotV2(body, source);
    if (!parsed.closing) throw new Error('missing closing fixture');
    const view = { ...parsed, closing: { ...parsed.closing, tLeft: 0n, creatorEntitlement: 0n } };
    expect(view.m3?.pileMoney?.seedReturnDue).toBe(seed);
    expect(view.m3?.pileMoney?.balance).toBeGreaterThanOrEqual(seed);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
      const box = { key: 'pile', view, source, name: 'Pile', symbol: 'P', ticker: 'T', disabled: false };
      const { result } = renderHook(() => useClaimsV2([box], view.record.creator), { wrapper });
      expect(result.current[0]?.known).toBe(true);
      expect(result.current[0]?.steps.map(step => step.kind)).toContain('seed-return');
    } finally { client.clear(); }
  });
});

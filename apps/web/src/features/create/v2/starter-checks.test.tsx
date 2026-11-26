/**
 * XR-SH-SHOP-CREATE F2 (fix round 1): the page's check of who holds each starter item (shop-checks.ts
 * `useStarterChecks`) is never fresh for good: "all yours" is read again whenever the check is shown again or asked
 * for again (`STARTER_CHECKS_KEY`, which each Create or Continue press asks for), so an item that left the wallet
 * after the first answer shows as missing. The run itself reads every item again before any wallet request
 * (create-send.test.ts).
 */
import { createElement, type ReactNode } from 'react';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { decodeFunctionData, encodeAbiParameters, parseAbi, type Address, type Hex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OWNER } from '../test-support/fixtures';
import { starterKey, type StarterItem } from './shop';
import { STARTER_CHECKS_KEY, useStarterChecks } from './shop-checks';

const chain = vi.hoisted(() => ({ call: vi.fn<(to: Address, data: Hex) => Promise<Hex | null>>() }));
vi.mock('../../data-source', () => ({ useDataSource: () => ({ id: 'local', isDemo: false }) }));
vi.mock('../../core/useCore', () => ({ BUILD_CORE: {} }));
vi.mock('../../core/v2/indexer-v2', () => ({ sourceV2: () => ({ network: 'local', manifest: { chainId: 31337 }, rpc: 'http://127.0.0.1:1' }) }));
vi.mock('./indexer-listings', () => ({ rpcTokenReader: () => ({ call: chain.call, hasCode: async () => true }) }));
afterEach(cleanup);

const OWNER_OF = parseAbi(['function ownerOf(uint256 id) view returns (address)']);
const ITEMS: StarterItem[] = Array.from({ length: 10 }, (_, i) => ({ collection: '0x00000000000000000000000000000000000000a1', tier: 0, id: BigInt(i + 1) }));
const AWAY = '0x000000000000000000000000000000000000bEEF' as Address;

function harness() {
  const away = new Set<bigint>();
  chain.call.mockReset();
  chain.call.mockImplementation(async (_to, data) => {
    const { args } = decodeFunctionData({ abi: OWNER_OF, data });
    return encodeAbiParameters([{ type: 'address' }], [away.has(args[0]) ? AWAY : OWNER]);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return { away, client, render: () => renderHook(() => useStarterChecks(ITEMS, OWNER), { wrapper }) };
}

describe('XR-SH-SHOP-CREATE F2: the page’s starter check is never fresh for good', () => {
  it('shown again after an item left the wallet: it reads again and shows that item as missing', async () => {
    const { away, render, client } = harness();
    const first = render();
    await waitFor(() => expect([...(first.result.current?.values() ?? [])].filter((answer) => answer === 'yours')).toHaveLength(10));
    first.unmount();
    away.add(3n);
    const before = chain.call.mock.calls.length;
    const again = render();
    await waitFor(() => expect(again.result.current?.get(starterKey(ITEMS[2] as StarterItem))).toBe('not-yours'));
    expect(chain.call.mock.calls.length - before).toBe(10);
    again.unmount();
    client.clear();
  });

  it('asked for again while shown (each Create or Continue press asks): it reads again', async () => {
    const { away, render, client } = harness();
    const shown = render();
    await waitFor(() => expect(shown.result.current?.get(starterKey(ITEMS[6] as StarterItem))).toBe('yours'));
    away.add(7n);
    await client.invalidateQueries({ queryKey: [STARTER_CHECKS_KEY] });
    await waitFor(() => expect(shown.result.current?.get(starterKey(ITEMS[6] as StarterItem))).toBe('not-yours'));
    shown.unmount();
    client.clear();
  });
});

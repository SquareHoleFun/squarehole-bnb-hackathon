/**
 * XR-CREATE-RPC-BATCHING (Codex review of SH-CREATE-RPC-BATCHING at c2d5c8efd): the Alchemist offer on Basics and the
 * pair the Fees step reads hold one answer. The first three tests are the review's own regression tests
 * (`admission-refresh.test.tsx`), with this folder's imports; the last two follow CreateV2Flow's own way off and back
 * onto Basics (the offer is asked with no price coin on the other steps).
 * - F1: the offer is what each pair's own query holds. A pair read again (the Fees step reads its pair once a minute;
 *   a pair picked after five minutes is read again) changes the offer too: row 4 refused there is not still offered.
 * - F2: a discovery that could not read a pile coin is not kept as a fresh answer: the offer shown again asks again.
 * All against the committed Sepolia state (test-support/sepolia-create-chain.ts), read one request per call.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Address } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppProviders, createQueryClient } from '../../../app-providers';
import * as dataSource from '../../data-source';
import * as indexerV2 from '../../core/v2/indexer-v2';
import { useAlchemistOffer, useAlchemistRows } from './alchemist';
import { coin, COINS, DIRECT_RPC, ROUTE_HELPER, sepoliaChain, sepoliaSource } from './test-support/sepolia-create-chain';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('the offer and the pair the Fees step reads hold one answer (XR-CREATE-RPC-BATCHING F1, F2)', () => {
  it('removes the offer when the selected pair is refreshed and its directory row no longer resolves', async () => {
    const state = { admitted: true };
    // resolve(4) reverting has the same refusal outcome for withdrawal and immaturity.
    const chain = sepoliaChain({ get mature() { return state.admitted; } });
    vi.stubGlobal('fetch', chain.fetch);
    const useSource = dataSource.useDataSource;
    vi.spyOn(dataSource, 'useDataSource').mockImplementation(function useSepolia() { return { ...useSource(), id: 'sepolia', isDemo: false }; });
    vi.spyOn(indexerV2, 'sourceV2').mockImplementation(() => sepoliaSource(DIRECT_RPC));
    const client = createQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <AppProviders queryClient={client}>{children}</AppProviders>;
    const offer = renderHook(() => useAlchemistOffer(coin('tPEPE'), COINS.map((c) => c.address)), { wrapper });
    await waitFor(() => expect(offer.result.current).toEqual({ coin: coin('tGOLD'), row: 4 }));
    const rows = renderHook(() => useAlchemistRows(coin('tPEPE'), coin('tGOLD')), { wrapper });
    expect(rows.result.current).toMatchObject({ state: 'ready', rows: [{ id: 4 }] });
    state.admitted = false;
    // Refetch the same query useAlchemistRows refreshes every minute on the real page.
    await act(async () => { await client.refetchQueries({ queryKey: ['v2-alchemist'] }); });
    await waitFor(() => expect(rows.result.current).toEqual({ state: 'ready', rows: [] }));
    expect(offer.result.current).toBeNull();
    client.clear();
  });

  it('retries an unread candidate when the offer remounts after the RPC recovers', async () => {
    const state = { failed: true };
    const chain = sepoliaChain({ mature: true, get failCode() { return state.failed ? [ROUTE_HELPER] : []; } });
    vi.stubGlobal('fetch', chain.fetch);
    const useSource = dataSource.useDataSource;
    vi.spyOn(dataSource, 'useDataSource').mockImplementation(function useSepolia() { return { ...useSource(), id: 'sepolia', isDemo: false }; });
    vi.spyOn(indexerV2, 'sourceV2').mockImplementation(() => sepoliaSource(DIRECT_RPC));
    const client = createQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <AppProviders queryClient={client}>{children}</AppProviders>;
    const first = renderHook(() => useAlchemistOffer(coin('tPEPE'), COINS.map((c) => c.address)), { wrapper });
    await waitFor(() => {
      expect(chain.stats.codes).toContain(ROUTE_HELPER);
      expect(client.isFetching()).toBe(0);
    });
    expect(first.result.current).toBeNull();
    const before = chain.stats.ops;
    state.failed = false;
    first.unmount();
    const next = renderHook(() => useAlchemistOffer(coin('tPEPE'), COINS.map((c) => c.address)), { wrapper });
    await waitFor(() => expect(next.result.current).toEqual({ coin: coin('tGOLD'), row: 4 }));
    expect(chain.stats.ops).toBeGreaterThan(before);
    client.clear();
  });

  it('does not keep offering an unresolvable row after five-minute pair cache expiry and a new pair read', async () => {
    vi.useFakeTimers();
    const state = { admitted: true };
    const chain = sepoliaChain({ get mature() { return state.admitted; } });
    vi.stubGlobal('fetch', chain.fetch);
    const useSource = dataSource.useDataSource;
    vi.spyOn(dataSource, 'useDataSource').mockImplementation(function useSepolia() { return { ...useSource(), id: 'sepolia', isDemo: false }; });
    vi.spyOn(indexerV2, 'sourceV2').mockImplementation(() => sepoliaSource(DIRECT_RPC));
    const client = createQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <AppProviders queryClient={client}>{children}</AppProviders>;
    const offer = renderHook(() => useAlchemistOffer(coin('tPEPE'), COINS.map((c) => c.address)), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(offer.result.current).toEqual({ coin: coin('tGOLD'), row: 4 });
    state.admitted = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(301_000); });
    // The review checked here, at c2d5c8efd only, that the pair queries the discovery had filled were gone (five minutes
    // unwatched); the offer now watches them, as before SH-CREATE-RPC-BATCHING. Either way the pair picked next is read
    // again, and its answer is the offer's.
    const ops = chain.stats.ops;
    const rows = renderHook(() => useAlchemistRows(coin('tPEPE'), coin('tGOLD')), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(chain.stats.ops).toBeGreaterThan(ops);
    expect(rows.result.current).toEqual({ state: 'ready', rows: [] });
    expect(offer.result.current).toBeNull();
    client.clear();
  });

  it('the page’s own way back to Basics (no price coin on the other steps, then the same one): an unread pile coin is asked again', async () => {
    const state = { failed: true };
    const chain = sepoliaChain({ mature: true, get failCode() { return state.failed ? [ROUTE_HELPER] : []; } });
    vi.stubGlobal('fetch', chain.fetch);
    const useSource = dataSource.useDataSource;
    vi.spyOn(dataSource, 'useDataSource').mockImplementation(function useSepolia() { return { ...useSource(), id: 'sepolia', isDemo: false }; });
    vi.spyOn(indexerV2, 'sourceV2').mockImplementation(() => sepoliaSource(DIRECT_RPC));
    const client = createQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <AppProviders queryClient={client}>{children}</AppProviders>;
    const offer = renderHook(({ price }: { readonly price: Address | null }) => useAlchemistOffer(price, COINS.map((c) => c.address)), { wrapper, initialProps: { price: coin('tPEPE') as Address | null } });
    await waitFor(() => {
      expect(chain.stats.codes).toContain(ROUTE_HELPER);
      expect(client.isFetching()).toBe(0);
    });
    expect(offer.result.current).toBeNull();
    state.failed = false;
    offer.rerender({ price: null });
    offer.rerender({ price: coin('tPEPE') });
    await waitFor(() => expect(offer.result.current).toEqual({ coin: coin('tGOLD'), row: 4 }));
    client.clear();
  });

  it('back on Basics within the minute, the offer is what the Fees step last read for the pair, and nothing is asked again', async () => {
    const state = { admitted: true };
    const chain = sepoliaChain({ get mature() { return state.admitted; } });
    vi.stubGlobal('fetch', chain.fetch);
    const useSource = dataSource.useDataSource;
    vi.spyOn(dataSource, 'useDataSource').mockImplementation(function useSepolia() { return { ...useSource(), id: 'sepolia', isDemo: false }; });
    vi.spyOn(indexerV2, 'sourceV2').mockImplementation(() => sepoliaSource(DIRECT_RPC));
    const client = createQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <AppProviders queryClient={client}>{children}</AppProviders>;
    // As CreateV2Flow asks it: the price coin on Basics, none on the other steps.
    const offer = renderHook(({ price }: { readonly price: Address | null }) => useAlchemistOffer(price, COINS.map((c) => c.address)), { wrapper, initialProps: { price: coin('tPEPE') as Address | null } });
    await waitFor(() => expect(offer.result.current).toEqual({ coin: coin('tGOLD'), row: 4 }));
    // The Fees step: the offer is off, the chosen pair is read again (its minute), and row 4 no longer resolves.
    offer.rerender({ price: null });
    const rows = renderHook(() => useAlchemistRows(coin('tPEPE'), coin('tGOLD')), { wrapper });
    state.admitted = false;
    await act(async () => { await client.refetchQueries({ queryKey: ['v2-alchemist'], type: 'active' }); });
    await waitFor(() => expect(rows.result.current).toEqual({ state: 'ready', rows: [] }));
    const ops = chain.stats.ops;
    offer.rerender({ price: coin('tPEPE') });
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(offer.result.current).toBeNull();
    expect(chain.stats.ops).toBe(ops);
    client.clear();
  });
});

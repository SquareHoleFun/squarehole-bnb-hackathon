/**
 * SH-CREATE-RPC-BATCHING: the Create route itself, mounted fresh on the Sepolia source with no wallet, against the
 * committed Sepolia state (test-support/sepolia-create-chain.ts as the page's `fetch`). The page asks the indexer once
 * for the book and the keyless RPC at most 30 JSON-RPC operations in at most 12 HTTP requests (it was 424 requests),
 * shows the same coins, raises, issuer lines and templates as one request per read (any RPC but the public one is read
 * that way), asks no wallet, and finds a pair The Alchemist's offer already read when the Fees step asks for it.
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders, createQueryClient } from '../../../app-providers';
import { Shell } from '../../../shell/Shell';
import * as dataSource from '../../data-source';
import * as indexerV2 from '../../core/v2/indexer-v2';
import { CreatePage } from '../CreatePage';
import { resetDraftForTests } from '../draft';
import { useAlchemistOffer, useAlchemistRows } from './alchemist';
import { resetListingSymbolsForTests } from './indexer-listings';
import { FREEZE_LINE } from './listings';
import { PAUSE_LINE, resetIssuerPowersForTests } from './issuer-powers';
import { COINS, DIRECT_RPC, SEPOLIA_RPC, coin, repeats, sepoliaChain, sepoliaSource, type ChainOptions, type FakeChain } from './test-support/sepolia-create-chain';
import { resetV2ForTests } from './v2-draft';

const useSource = dataSource.useDataSource;
let chain: FakeChain;
let wallet: { readonly request: ReturnType<typeof vi.fn>; readonly on: ReturnType<typeof vi.fn>; readonly removeListener: ReturnType<typeof vi.fn> };
let announced: string[];

function onSepolia(rpc: string, options: ChainOptions = {}) {
  chain = sepoliaChain(options);
  vi.stubGlobal('fetch', chain.fetch);
  vi.spyOn(dataSource, 'useDataSource').mockImplementation(function useSepolia() { return { ...useSource(), id: 'sepolia', isDemo: false }; });
  vi.spyOn(indexerV2, 'sourceV2').mockImplementation(() => sepoliaSource(rpc));
}

beforeEach(() => {
  resetDraftForTests();
  resetV2ForTests();
  resetListingSymbolsForTests();
  resetIssuerPowersForTests();
  // An injected wallet that records every request (none may come) and every EIP-6963 discovery.
  wallet = { request: vi.fn(async () => { throw new Error('no wallet request on navigation'); }), on: vi.fn(), removeListener: vi.fn() };
  vi.stubGlobal('ethereum', wallet);
  announced = [];
  const dispatch = window.dispatchEvent.bind(window);
  vi.spyOn(window, 'dispatchEvent').mockImplementation((event: Event) => { if (event.type.startsWith('eip6963')) announced.push(event.type); return dispatch(event); });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The route at /create/v2-basics, fresh: its own query cache, as a reload starts. */
function renderCreate(client: QueryClient = createQueryClient()) {
  render(
    <AppProviders queryClient={client}>
      <MemoryRouter initialEntries={['/create/v2-basics']}>
        <Routes>
          <Route element={<Shell />}>
            <Route path="create/:step" element={<CreatePage demoStepMs={0} />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AppProviders>,
  );
  return client;
}

/** Until the book has loaded and no query is reading any more. */
async function settled(client: QueryClient) {
  await screen.findByRole('radio', { name: /^tFROG/ }, { timeout: 5_000 });
  await waitFor(() => expect(client.isFetching()).toBe(0), { timeout: 5_000 });
  // The Eat answers and the discovery start once the book has rendered: wait until they have been asked and answered.
  await waitFor(() => { expect(chain.stats.methods.eth_call ?? 0).toBeGreaterThan(1); expect(client.isFetching()).toBe(0); }, { timeout: 5_000 });
}

/** What the Basics step shows: every coin with its raise, the chosen coin's card, the template tiles. */
function basics() {
  const picker = screen.getByRole('group', { name: 'Priced in' });
  return {
    coins: within(picker).getAllByRole('radio').map((radio) => radio.closest('label')?.textContent ?? radio.getAttribute('aria-label') ?? ''),
    card: document.querySelector('[data-pricing-card]')?.textContent ?? '',
    templates: Array.from(document.querySelectorAll('.sh-v2-template__name')).map((name) => name.textContent),
  };
}

describe('a fresh Create page on the Sepolia source', () => {
  it('asks the indexer once and the RPC 25 operations in at most 10 requests, shows what one request per read shows, asks no wallet', async () => {
    onSepolia(DIRECT_RPC);
    const direct = renderCreate();
    await settled(direct);
    const before = { shown: basics(), stats: chain.stats };
    cleanup();
    vi.restoreAllMocks();
    resetListingSymbolsForTests();
    resetIssuerPowersForTests();
    resetDraftForTests();
    resetV2ForTests();

    onSepolia(SEPOLIA_RPC);
    const client = renderCreate();
    await settled(client);
    const now = basics();
    expect(now).toEqual(before.shown);
    expect(now.coins.join(' ')).toMatch(/ETH.*tUSDC.*tNVDA/);
    for (const { symbol } of COINS) expect(now.coins.some((label) => label.startsWith(symbol)), symbol).toBe(true);
    expect(now.templates).not.toContain('Alchemist coin pile');
    // The counts: one book; 25 operations in 8 requests when measured (one request per read, with this page's one
    // discovery, was 55 + 8 + 61 = 124; with one discovery per pile coin, 424).
    expect(chain.stats.http.indexer).toBe(1);
    expect(chain.stats.ops).toBe(25);
    expect(chain.stats.http.rpc).toBeLessThanOrEqual(10);
    expect(chain.stats.http.other).toEqual([]);
    expect(before.stats.ops).toBe(124);
    expect(before.stats.http.rpc).toBe(124);
    expect(repeats(chain.stats)).toEqual({ calls: [], codes: [] });
    expect(Object.keys(chain.stats.methods).sort()).toEqual(['eth_call', 'eth_chainId', 'eth_getCode']);
    expect(wallet.request).not.toHaveBeenCalled();
    expect(announced).toEqual([]);
  });

  it('tGOLD’s card shows its own pause and freeze; choosing it asks one new discovery and never the coins again', async () => {
    onSepolia(SEPOLIA_RPC);
    const client = renderCreate();
    await settled(client);
    const ops = chain.stats.ops;
    await act(async () => fireEvent.click(screen.getByRole('radio', { name: /^tGOLD/ })));
    await waitFor(() => expect(basics().card).toContain(PAUSE_LINE));
    expect(basics().card).toContain(FREEZE_LINE);
    await waitFor(() => expect(client.isFetching()).toBe(0));
    // A new price coin is a new discovery (one more read set); the coins' metadata is not read again.
    expect(chain.stats.ops - ops).toBeLessThanOrEqual(9);
    expect(chain.stats.codes.filter((address) => COINS.some((c) => c.address === address))).toHaveLength(6);
    expect(wallet.request).not.toHaveBeenCalled();
  });

  it('in-app, the page mounted again asks the RPC nothing: the coins, the Eat answers and the offer are all still known', async () => {
    onSepolia(SEPOLIA_RPC);
    const client = renderCreate();
    await settled(client);
    const ops = chain.stats.ops;
    cleanup();
    renderCreate(client);
    await screen.findByRole('radio', { name: /^tFROG/ }, { timeout: 5_000 });
    await waitFor(() => expect(client.isFetching()).toBe(0), { timeout: 5_000 });
    expect(chain.stats.ops).toBe(ops);
    expect(basics().coins).toHaveLength(COINS.length);
    expect(wallet.request).not.toHaveBeenCalled();
  });

  it('after row 4 matures, priced in tPEPE: the Alchemist template is offered, as one request per read offers it', async () => {
    const offered = async (rpc: string) => {
      onSepolia(rpc, { mature: true });
      const client = renderCreate();
      await settled(client);
      await act(async () => fireEvent.click(screen.getByRole('radio', { name: /^tPEPE/ })));
      await waitFor(() => expect(basics().templates).toContain('Alchemist coin pile'), { timeout: 5_000 });
      await waitFor(() => expect(client.isFetching()).toBe(0));
      const shown = basics();
      cleanup();
      vi.restoreAllMocks();
      resetListingSymbolsForTests();
      resetIssuerPowersForTests();
      resetDraftForTests();
      resetV2ForTests();
      return shown;
    };
    const direct = await offered(DIRECT_RPC);
    const now = await offered(SEPOLIA_RPC);
    expect(now).toEqual(direct);
    expect(wallet.request).not.toHaveBeenCalled();
  });

  it('a rate-limited RPC: the same coins and card as one request per read (addresses, "could not be read"), no template', async () => {
    const limited = async (rpc: string) => {
      onSepolia(rpc, { failure: { kind: '429', answered: 1 } });
      const client = renderCreate();
      await screen.findAllByRole('radio');
      await waitFor(() => expect(client.isFetching()).toBe(0), { timeout: 5_000 });
      await waitFor(() => expect(chain.stats.http.rpc).toBeGreaterThan(2));
      await waitFor(() => expect(client.isFetching()).toBe(0), { timeout: 5_000 });
      const shown = basics();
      cleanup();
      vi.restoreAllMocks();
      resetListingSymbolsForTests();
      resetIssuerPowersForTests();
      resetDraftForTests();
      resetV2ForTests();
      return shown;
    };
    const direct = await limited(DIRECT_RPC);
    const now = await limited(SEPOLIA_RPC);
    expect(now).toEqual(direct);
    expect(now.templates).not.toContain('Alchemist coin pile');
    expect(now.coins.some((label) => label.toLowerCase().startsWith(coin('tGOLD')))).toBe(true);
  });
});

describe('the offer asks nothing it does not need', () => {
  it('with no other listed coin there is no pair to check, and nothing is read', async () => {
    onSepolia(SEPOLIA_RPC, { mature: true });
    const client = createQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <AppProviders queryClient={client}>{children}</AppProviders>;
    const offer = renderHook(() => useAlchemistOffer(coin('tPEPE'), [coin('tPEPE')]), { wrapper });
    await act(async () => { await new Promise((done) => setTimeout(done, 50)); });
    expect(offer.result.current).toBeNull();
    expect(client.isFetching()).toBe(0);
    expect(chain.stats.ops).toBe(0);
  });
});

describe('the Alchemist tile is what the page last read for the chosen pair (XR-CREATE-RPC-BATCHING F1)', () => {
  it('chosen on Basics, row 4 then refused when the pair is read again (its minute): the tile is no longer offered', async () => {
    const state = { admitted: true };
    onSepolia(SEPOLIA_RPC, { get mature() { return state.admitted; } });
    const client = renderCreate();
    await settled(client);
    await act(async () => fireEvent.click(screen.getByRole('radio', { name: /^tPEPE/ })));
    await waitFor(() => expect(basics().templates).toContain('Alchemist coin pile'), { timeout: 5_000 });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /^Alchemist coin pile/ })));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    state.admitted = false;
    // The chosen pair's own query (useAlchemistRows), read again as its minute would.
    await act(async () => { await client.refetchQueries({ queryKey: ['v2-alchemist'], type: 'active' }); });
    await waitFor(() => expect(basics().templates).not.toContain('Alchemist coin pile'));
    expect(wallet.request).not.toHaveBeenCalled();
  });
});

describe('the Fees step finds the offered pair already read', () => {
  it('useAlchemistRows for the offered pair answers at once, with no further read', async () => {
    onSepolia(SEPOLIA_RPC, { mature: true });
    const client = createQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <AppProviders queryClient={client}>{children}</AppProviders>;
    const piles = COINS.map((c) => c.address as `0x${string}`);
    const offer = renderHook(() => useAlchemistOffer(coin('tPEPE'), piles), { wrapper });
    await waitFor(() => expect(offer.result.current).toEqual({ coin: coin('tGOLD'), row: 4 }));
    const ops = chain.stats.ops;
    const rows = renderHook(() => useAlchemistRows(coin('tPEPE'), coin('tGOLD')), { wrapper });
    expect(rows.result.current).toMatchObject({ state: 'ready', rows: [{ id: 4 }] });
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(chain.stats.ops).toBe(ops);
  });
});

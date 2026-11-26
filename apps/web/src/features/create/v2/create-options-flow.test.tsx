/**
 * SH-218 rail 2 af1 (review F5, changes D and E; request 9): the page's own wiring, rendered: the Create route on a
 * chain source with a routed list (the Sepolia test double, test-support/sepolia-create-chain.ts, for the indexer and
 * RPC; the list answered here). Create is off while the list is down and comes back on Retry; the check handed to the
 * run checks the run's OWN spec, never the page's draft; each Overview row that holds a switched-off option says so,
 * and the line under Create is announced once.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateSendPlanV2 } from '../../../../../../packages/chain/src/core/v2';
import { AppProviders, createQueryClient } from '../../../app-providers';
import { Shell } from '../../../shell/Shell';
import * as dataSource from '../../data-source';
import * as indexerV2 from '../../core/v2/indexer-v2';
import * as wallet from '../../wallet';
import { createDemoWalletAdapter } from '../../wallet';
import { CreatePage } from '../CreatePage';
import { resetDraftForTests } from '../draft';
import { createOptionsFetchForTests, type CreateOptionsFetch } from './create-options';
import { CREATE_OFF, CREATE_UNAVAILABLE } from './create-options-words';
import { CreateRefusal } from './create-send';
import { DEMO_LISTINGS } from './listings';
import { buildSpecV2 } from './model';
import { pickFor } from './recipes';
import { CONFIGURATIONS } from './test-support/example-configurations';
import { inputV2Of, seedV2 } from './test-support/v2-fixtures';
import { sepoliaChain, sepoliaSource } from './test-support/sepolia-create-chain';
import type { CreateSendInput } from './useCreateSend';
import * as send from './useCreateSend';
import { resetV2ForTests } from './v2-draft';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../packages/chain/src/create-options/fixtures');
const SOURCE = sepoliaSource();
const RELEASE = SOURCE.manifest.releases[0];
if (!RELEASE) throw new Error('release');
/** The server's fixture list, pinned to the double's release, with these keys off. */
const listWith = (off: readonly string[]) => JSON.stringify({ ...JSON.parse(readFileSync(join(FIXTURES, 'empty.json'), 'utf8')) as object, chainId: SOURCE.manifest.chainId,
  factory: RELEASE.factory.address.toLowerCase(), registry: RELEASE.registry.address.toLowerCase(), versionCodeHash: RELEASE.versionCodeHash.toLowerCase(), off: off.map((key) => ({ key })) });
const config = (id: string) => {
  const found = CONFIGURATIONS.find((entry) => entry.id === id);
  if (!found) throw new Error(id);
  return found;
};

let list: () => Response;
const lists = vi.fn<CreateOptionsFetch>(async () => list());
let given: CreateSendInput | null = null;
const useSource = dataSource.useDataSource;
const useCurrentWallet = wallet.useWallet;

beforeEach(() => {
  resetDraftForTests();
  resetV2ForTests();
  given = null;
  list = () => new Response(listWith([]), { status: 200 });
  lists.mockClear();
  createOptionsFetchForTests(lists);
  vi.stubGlobal('fetch', sepoliaChain().fetch);
  vi.spyOn(dataSource, 'useDataSource').mockImplementation(function useSepolia() { return { ...useSource(), id: 'sepolia', isDemo: false }; });
  vi.spyOn(indexerV2, 'sourceV2').mockImplementation(() => SOURCE);
  vi.spyOn(wallet, 'useWallet').mockImplementation(function useBrowserWallet() {
    const current = useCurrentWallet();
    return { ...current, status: 'connected', kind: 'injected', account: wallet.DEMO_WALLET_A, chainId: SOURCE.manifest.chainId, signer: { request: vi.fn(), walletName: 'Test' } };
  });
  vi.spyOn(send, 'useCreateSend').mockImplementation((input) => {
    given = input;
    return { available: true, view: { phase: 'idle' }, run: null, runSpec: null, otherBox: null, resumes: false, created: false, start: vi.fn(), stop: vi.fn(), forget: vi.fn() };
  });
});
afterEach(() => { cleanup(); createOptionsFetchForTests(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function renderOverview() {
  render(
    <AppProviders queryClient={createQueryClient()} walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}>
      <MemoryRouter initialEntries={['/create/v2-overview']}>
        <Routes><Route element={<Shell />}><Route path="create/:step" element={<CreatePage demoStepMs={0} v2Listings={DEMO_LISTINGS} />} /></Route></Routes>
      </MemoryRouter>
    </AppProviders>,
  );
}
const create = () => screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement;

describe('SH-218 rail 2 af1: the Create page with a routed list', () => {
  it('D: Create is off while the list is down (line B with Retry), and on again once Retry reads it', async () => {
    list = () => new Response('{"error":"create options unavailable"}', { status: 503 });
    seedV2(config('rug-rugs'));
    renderOverview();
    const line = await screen.findByText(CREATE_UNAVAILABLE);
    expect(line.closest('[role="alert"]')).not.toBeNull();
    expect(create().disabled).toBe(true);
    list = () => new Response(listWith([]), { status: 200 });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })));
    await waitFor(() => expect(create().disabled).toBe(false));
    expect(screen.queryByText(CREATE_UNAVAILABLE)).toBeNull();
  });

  it('E: the check handed to the run checks the run’s own spec, never the page’s draft', async () => {
    list = () => new Response(listWith(['fee.buyers.holders-p']), { status: 200 });
    seedV2(config('rug-rugs'));
    renderOverview();
    // The draft (buyers Keep) needs nothing that is off: Create is on.
    await waitFor(() => expect(create().disabled).toBe(false));
    const check = given?.createOptionsCheck;
    if (!check) throw new Error('no check handed to the run');
    const planOf = (spec: CreateSendPlanV2['spec']) => ({ chainId: SOURCE.manifest.chainId, factory: RELEASE.factory.address, spec }) as unknown as CreateSendPlanV2;
    const savedRun = buildSpecV2(inputV2Of(config('rug-rugs'), { buyers: pickFor('holders') }));
    const refusal = await check(planOf(savedRun)).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(CreateRefusal);
    expect((refusal as CreateRefusal).message).toBe(CREATE_OFF);
    await expect(check(planOf(buildSpecV2(inputV2Of(config('rug-rugs')))))).resolves.toBeUndefined();
  });

  it('af2 (review C2, change J): a switched-off add-on the draft needs (its royalty) marks the Contents row', async () => {
    list = () => new Response(listWith(['addon.4']), { status: 200 });
    seedV2(config('link-marines'));
    renderOverview();
    await waitFor(() => expect(document.querySelectorAll('[data-create-options="row"]')).toHaveLength(1));
    const row = (name: string) => screen.getByText(name, { selector: 'dt' }).closest('.sh-newbox-row') as HTMLElement;
    expect(within(row('Contents')).getByText(CREATE_OFF)).toBeTruthy();
    expect(screen.getAllByRole('alert').filter((alert) => alert.textContent?.includes(CREATE_OFF))).toHaveLength(1);
    expect(create().disabled).toBe(true);
  });

  it('request 9: each Overview row holding a switched-off option says so; the line under Create is announced once', async () => {
    list = () => new Response(listWith(['fee.sellers.keep', 'price.0x0000000000000000000000000000000000000000']), { status: 200 });
    seedV2(config('rug-rugs'));
    renderOverview();
    await waitFor(() => expect(document.querySelectorAll('[data-create-options="row"]')).toHaveLength(2));
    const row = (name: string) => screen.getByText(name, { selector: 'dt' }).closest('.sh-newbox-row') as HTMLElement;
    expect(within(row('Sellers’ fees')).getByText(CREATE_OFF)).toBeTruthy();
    expect(within(row('Priced in')).getByText(CREATE_OFF)).toBeTruthy();
    expect(within(row('Buyers’ fees')).queryByText(CREATE_OFF)).toBeNull();
    expect(within(row('Contents')).queryByText(CREATE_OFF)).toBeNull();
    expect(screen.getAllByRole('alert').filter((alert) => alert.textContent?.includes(CREATE_OFF))).toHaveLength(1);
    expect(create().disabled).toBe(true);
  });
});

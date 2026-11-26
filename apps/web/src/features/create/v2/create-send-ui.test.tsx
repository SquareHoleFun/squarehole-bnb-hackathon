/**
 * TA-22: the real Create's page parts. The bar's one primary action by where the run stands (connect on a click, never on
 * navigation; Create, Stop, Continue, Open your box), the panel's labels and status counts, the failure sentences and
 * the tab's stored run. The step machine itself is create-send.test.ts.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { WalletContextChangedError, WalletRejectedError, NotSendableError } from '@squarehole/chain/write';
import { AppProviders } from '../../../app-providers';
import { Shell } from '../../../shell/Shell';
import * as dataSource from '../../data-source';
import * as wallet from '../../wallet';
import { createDemoWalletAdapter } from '../../wallet';
import { CreatePage } from '../CreatePage';
import { REVEAL_FILE_NOTE } from './CreateV2Flow';
import { resetDraftForTests, updateDraft } from '../draft';
import { CONFIGURATIONS } from './test-support/example-configurations';
import { seedV2 } from './test-support/v2-fixtures';
import { DEMO_LISTINGS } from './listings';
import { resetV2ForTests } from './v2-draft';
import { CreateRefusal, type CreateProgressV2, type CreateRunV2 } from './create-send';
import { parseRunV2 } from './create-send-store';
import { planLabels, sendStatusText } from './CreateSendPanel';
import { creationPlan } from './creation-plan';
import { buildSpecV2, pileSeedOf, recipeCtx } from './model';
import { inputV2Of } from './test-support/v2-fixtures';
import type { CreateSendView } from './useCreateSend';
import * as send from './useCreateSend';
import * as shopChecks from './shop-checks';
import { NATIVE_TOKEN } from './listings';
import { starterItemsOf, starterKey, type ShopChoice, type StarterCheck } from './shop';
import { updateV2 } from './v2-draft';

const config = (id: string) => {
  const found = CONFIGURATIONS.find((entry) => entry.id === id);
  if (!found) throw new Error(id);
  return found;
};
const step = (label: string) => ({ key: label, label, call: { kind: 'createBox' as const, to: wallet.DEMO_WALLET_A, data: '0x' as const, value: 0n } });
const progress = (done: boolean[], later: string[] = []): CreateProgressV2 => ({ steps: done.map((_, i) => step(`Step ${i + 1}`)), done, later, plan: {} as CreateProgressV2['plan'] });

describe('TA-22 panel words', () => {
  it('labels the plan’s steps in the run’s words, before the chain is read', () => {
    const input = inputV2Of(config('dragons-hoard'), { pricing: DEMO_LISTINGS.find((l) => l.symbol === 'LINK')?.token ?? '' });
    const spec = buildSpecV2(input);
    const plan = creationPlan(spec, recipeCtx(input).pricing, { estimate: null, seed: pileSeedOf(input) });
    expect(planLabels(plan, recipeCtx(input).pricing, pileSeedOf(input), 'HOARD')).toEqual([expect.stringMatching(/^Approve [0-9.]+ LINK$/), 'Create the box', 'Approve the seed · 1000 USDC', 'Load the pile']);
  });
  it('counts where the run stands, numbers first', () => {
    expect(sendStatusText({ phase: 'idle' })).toBeNull();
    expect(sendStatusText({ phase: 'preparing' })).toBe('Finding the box’s address');
    expect(sendStatusText({ phase: 'running', progress: progress([true, false], ['Later']), sending: 1, stopping: false })).toBe('2/3 · Confirm in your wallet');
    expect(sendStatusText({ phase: 'running', progress: progress([true, false]), sending: null, stopping: false })).toBe('Reading the chain · 1/2');
    expect(sendStatusText({ phase: 'running', progress: progress([true, false]), sending: 1, stopping: true })).toBe('Stopping · 1/2');
    expect(sendStatusText({ phase: 'stopped', progress: progress([true, false]) })).toBe('Stopped · 1/2');
    expect(sendStatusText({ phase: 'done', progress: progress([true, true]), box: '/box/1/0x1' })).toBe('Created · 2/2');
  });
  it('says what stopped the run in plain words, never the wallet’s own text', () => {
    expect(send.sendFailureText(new WalletRejectedError(), 11155111)).toBe('Declined in the wallet.');
    expect(send.sendFailureText(new WalletContextChangedError('chain', 1), 11155111)).toBe('Switch the wallet to Sepolia (11155111).');
    expect(send.sendFailureText(new WalletContextChangedError('account', 11155111), 11155111)).toBe('The wallet account changed. Connect it again.');
    expect(send.sendFailureText(new CreateRefusal('listing-changed', 'Price coin changed: refresh this plan'), 11155111)).toBe('Price coin changed: refresh this plan');
    expect(send.sendFailureText(new NotSendableError('x'), 11155111)).toBe('This step is not one of this box’s. Nothing was sent.');
    expect(send.sendFailureText(new Error('rpc said 0xdeadbeef'), 11155111)).toBe('The chain could not be read. Try again.');
  });
  it('reads back only a well-formed stored run', () => {
    const a = `0x${'a1'.repeat(20)}`; const b = `0x${'b2'.repeat(20)}`;
    const run = { chainId: 11155111, creator: a, factory: b, encoded: '0x00', cs: `0x${'0'.repeat(64)}`, hs: `0x${'1'.repeat(64)}`,
      coordinator: b, token: a, bootstrapQ: '10', sent: { createBox: `0x${'a'.repeat(64)}` } };
    expect(parseRunV2(run)).toEqual(run);
    expect(parseRunV2({ ...run, walletPending: true })).toEqual({ ...run, walletPending: true });
    for (const bad of [{ ...run, bootstrapQ: '1.5' }, { ...run, cs: '0x12' }, { ...run, creator: 'me' }, { ...run, sent: { a: '0x1' } }, { ...run, chainId: 0 }, null, 'run']) expect(parseRunV2(bad)).toBeNull();
    // SH-SHOP-CREATE: a shop's starter items ride with the run (the spec commits only their hash).
    const starters = [{ collection: b, id: '7', tier: 2 }, { collection: b, id: '115792089237316195423570985008687907853269984665640564039457584007913129639935', tier: 0 }];
    expect(parseRunV2({ ...run, starters })).toEqual({ ...run, starters });
    for (const bad of [{ collection: 'me', id: '1', tier: 0 }, { collection: b, id: '-1', tier: 0 }, { collection: b, id: '1', tier: 4 }, { collection: b, id: 1, tier: 0 }]) {
      expect(parseRunV2({ ...run, starters: [bad] }), JSON.stringify(bad)).toBeNull();
    }
    expect(parseRunV2({ ...run, starters: 'x' })).toBeNull();
  });
  it('SH-SHOP-CREATE: a shop’s starter steps in the plan’s words, each item’s approval numbered, then its page, before the seed', () => {
    const shop: ShopChoice = { ...(config('curio-corner').shop as ShopChoice), collections: [
      { address: `0x${'00'.repeat(19)}a1`, tier: 0, ids: '1-6' }, { address: `0x${'00'.repeat(19)}b2`, tier: 2, ids: '7-10' }] };
    const input = inputV2Of(config('curio-corner'), { pricing: NATIVE_TOKEN, shop });
    const plan = creationPlan(buildSpecV2(input), recipeCtx(input).pricing, { estimate: null, shopSeedT: 1000n * 10n ** 18n, starters: 10 });
    expect(planLabels(plan, recipeCtx(input).pricing, null, 'CURIO')).toEqual(['Create the box', ...Array.from({ length: 10 }, (_, i) => `Approve starter ${i + 1}/10`),
      'Load starter items 1/1', 'Approve the seed · 1000 CURIO', 'Fund the shop', 'Open the shop']);
  });
});

describe('TA-22 the bar on a real build', () => {
  const useSource = dataSource.useDataSource;
  const useCurrentWallet = wallet.useWallet;
  let view: CreateSendView = { phase: 'idle' };
  let connected = false;
  let saved: { run: CreateRunV2 | null; resumes: boolean } = { run: null, resumes: false };
  const start = vi.fn(async () => undefined);
  const stop = vi.fn();
  beforeEach(() => {
    resetDraftForTests();
    resetV2ForTests();
    view = { phase: 'idle' };
    connected = false;
    saved = { run: null, resumes: false };
    start.mockClear();
    stop.mockClear();
    vi.spyOn(dataSource, 'useDataSource').mockImplementation(function useChainSource() { return { ...useSource(), isDemo: false }; });
    vi.spyOn(wallet, 'useWallet').mockImplementation(function useBrowserWallet() {
      const current = useCurrentWallet();
      return connected ? { ...current, status: 'connected', kind: 'injected', account: wallet.DEMO_WALLET_A, chainId: 11155111, signer: { request: vi.fn(), walletName: 'Test' } } : current;
    });
    vi.spyOn(send, 'useCreateSend').mockImplementation(() => ({ available: true, view, run: saved.run, runSpec: null, otherBox: null, resumes: saved.resumes, created: false, start, stop, forget: vi.fn() }));
    seedV2(config('rug-rugs'));
  });
  afterEach(() => { vi.restoreAllMocks(); cleanup(); });

  const renderOverview = (queryClient?: QueryClient) => render(
    <AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })} queryClient={queryClient}>
      <MemoryRouter initialEntries={['/create/v2-overview']}>
        <Routes><Route element={<Shell />}><Route path="create/:step" element={<CreatePage demoStepMs={0} v2Listings={DEMO_LISTINGS} />} /></Route></Routes>
      </MemoryRouter>
    </AppProviders>,
  );

  // Fix round 1 (finding 3): a declined first request leaves a saved run with nothing sent. An edited draft is not that
  // run, so the press prepares the draft: its checks apply, whatever run the tab still holds.
  const unsent = { chainId: 11155111, creator: wallet.DEMO_WALLET_A, factory: wallet.DEMO_WALLET_A, encoded: '0x00', cs: `0x${'0'.repeat(64)}`, hs: `0x${'1'.repeat(64)}`,
    coordinator: wallet.DEMO_WALLET_A, token: wallet.DEMO_WALLET_A, bootstrapQ: '10', sent: {} } as CreateRunV2;
  it('not connected: Connect to create opens the browser-wallet window; Download BoxSpec stays beside it', async () => {
    renderOverview();
    expect(screen.getByRole('button', { name: 'Download BoxSpec' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Connect to create' })));
    expect(within(screen.getByRole('dialog')).getByRole('heading', { name: 'Connect a browser wallet' })).toBeTruthy();
    expect(start).not.toHaveBeenCalled();
  });
  it('connected: Create starts the run; running shows Stop; stopped shows Continue; done links the box', async () => {
    connected = true;
    const { rerender } = renderOverview();
    expect(screen.getByRole('heading', { name: /^Create · 1 transaction$/ })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create', exact: true } as never)));
    expect(start).toHaveBeenCalledTimes(1);
    const again = (next: CreateSendView) => { view = next; rerender(
      <AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}>
        <MemoryRouter initialEntries={['/create/v2-overview']}>
          <Routes><Route element={<Shell />}><Route path="create/:step" element={<CreatePage demoStepMs={0} v2Listings={DEMO_LISTINGS} />} /></Route></Routes>
        </MemoryRouter>
      </AppProviders>); };
    again({ phase: 'running', progress: progress([false]), sending: 0, stopping: false });
    expect(screen.getByRole('status').textContent).toBe('1/1 · Confirm in your wallet');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Stop' })));
    expect(stop).toHaveBeenCalledTimes(1);
    // Stopped with a sent step: the hook resumes that run (Fix round 1: the page and the hook share `resumes`).
    saved = { run: { ...unsent, sent: { createBox: `0x${'3'.repeat(64)}` } } as CreateRunV2, resumes: true };
    again({ phase: 'stopped', progress: progress([false]) });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Continue' })));
    expect(start).toHaveBeenCalledTimes(2);
    again({ phase: 'failed', progress: progress([false]), message: 'Declined in the wallet.' });
    expect(screen.getByRole('alert').textContent).toContain('Declined in the wallet.');
    again({ phase: 'done', progress: progress([true]), box: '/box/11155111/0xabc' });
    expect(screen.getByRole('link', { name: 'Open your box' }).getAttribute('href')).toBe('/box/11155111/0xabc');
    expect(screen.getByRole('button', { name: 'Start a new box' })).toBeTruthy();
  });

  it('Fix round 1: after a declined first request, Create on an edited draft with an issue sends nothing and shows the issue', async () => {
    connected = true;
    saved = { run: unsent, resumes: false };
    view = { phase: 'failed', progress: progress([false]), message: 'Declined in the wallet.' };
    updateDraft((d) => ({ ...d, form: { ...d.form, firstIn: 'abc' } }));
    renderOverview();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /^(Create|Continue)$/ })));
    expect(start).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^(Create|Continue)$/ }).textContent).toBe('Create');
    expect(screen.getAllByText(/Use a number like 0\.05/).length).toBeGreaterThan(0);
  });
  // TA-50: hidden art on a real build saves its reveal file before Create sends anything, with one line on why.
  it('TA-50 hidden art: Save reveal file first (one line on keeping it), then Create; nothing is sent before', async () => {
    connected = true;
    seedV2(config('ultrasound-owls'));
    updateDraft((d) => ({ ...d, form: { ...d.form, rights: true } }));
    const clicks = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const urls = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:reveal'), revokeObjectURL: vi.fn() });
    const { unmount } = renderOverview();
    expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
    expect(screen.getByText(REVEAL_FILE_NOTE)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save reveal file' })));
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    expect(screen.queryByText(REVEAL_FILE_NOTE)).toBeNull();
    expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy();
    unmount();
    Object.assign(URL, urls);
  });
  // SH-SHOP-CREATE: a shop's starter items are pulled from the creator after Create, so the chain's answer about each
  // (shop-checks.ts `useStarterChecks`, here stubbed) holds Create until the connected wallet holds every one.
  it('SH-SHOP-CREATE a shop with starter items: Create waits until the connected wallet holds each one, then sends with them', async () => {
    connected = true;
    seedV2(config('curio-corner'));
    const shop: ShopChoice = { ...(config('curio-corner').shop as ShopChoice), curator: 'none', collections: [
      { address: `0x${'00'.repeat(19)}a1`, tier: 0, ids: '1-6' }, { address: `0x${'00'.repeat(19)}b2`, tier: 2, ids: '7, 8, 9, 10' }] };
    updateV2((choices) => ({ ...choices, pricing: NATIVE_TOKEN, shop }));
    const items = starterItemsOf(shop) ?? [];
    let answer: (i: number) => StarterCheck | 'unknown' = (i) => (i < 2 ? 'not-yours' : 'yours');
    const asked: unknown[][] = [];
    vi.spyOn(shopChecks, 'useStarterChecks').mockImplementation((given, owner) => {
      asked.push([given?.length ?? 0, owner]);
      return new Map(items.map((item, i) => [starterKey(item), answer(i)]));
    });
    const created = vi.spyOn(send, 'useCreateSend');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
    const reasked = vi.spyOn(client, 'invalidateQueries');
    const { unmount } = renderOverview(client);
    expect(screen.getByRole('heading', { name: /^Create · 15 transactions$/ })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create', exact: true } as never)));
    // XR-SH-SHOP-CREATE F2: each press asks the page's starter check again, held or not.
    expect(reasked).toHaveBeenCalledWith({ queryKey: [shopChecks.STARTER_CHECKS_KEY] });
    expect(start).not.toHaveBeenCalled();
    expect(within(screen.getByRole('alert')).getAllByRole('link').map((a) => a.textContent)).toEqual(['Not in your wallet: 2 starter items']);
    expect(screen.getByText('10 · Not in your wallet: 2 starter items')).toBeTruthy();
    expect(asked.at(-1)).toEqual([10, wallet.DEMO_WALLET_A]);
    unmount();
    answer = () => 'yours';
    renderOverview(client);
    reasked.mockClear();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create', exact: true } as never)));
    expect(reasked).toHaveBeenCalledWith({ queryKey: [shopChecks.STARTER_CHECKS_KEY] });
    expect(start).toHaveBeenCalledTimes(1);
    // The hook prepares the run with exactly the items add-on 8 commits.
    expect(created.mock.calls.at(-1)?.[0].starters).toEqual(items);
  });
  it('Fix round 1: the saved run itself (the hook says it resumes) goes on with Continue; its spec was checked when prepared', async () => {
    connected = true;
    saved = { run: { ...unsent, sent: { approve: `0x${'2'.repeat(64)}` } } as CreateRunV2, resumes: true };
    view = { phase: 'failed', progress: progress([true, false]), message: 'Declined in the wallet.' };
    updateDraft((d) => ({ ...d, form: { ...d.form, firstIn: 'abc' } }));
    renderOverview();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Continue' })));
    expect(start).toHaveBeenCalledTimes(1);
  });
});

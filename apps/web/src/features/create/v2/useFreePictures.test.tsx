/**
 * SH-ARWEAVE-PICTURES-WEB: refusal before Create. Where the source keeps the logo and cover on Arweave, a picture that
 * does not fit Turbo's free tier is refused with one short line and Create sends nothing; Create's press asks Turbo's
 * free size again first. The page wires it (the bar on a real build), and the hook decides it.
 */
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@squarehole/artwork';
import { AppProviders } from '../../../app-providers';
import { Shell } from '../../../shell/Shell';
import * as dataSource from '../../data-source';
import * as wallet from '../../wallet';
import { createDemoWalletAdapter } from '../../wallet';
import { fitsFree, resetFreeLimitForTests } from '../../pictures/arweave-publish';
import { TOO_DETAILED } from '../../pictures/shrink';
import { CreatePage } from '../CreatePage';
import { resetDraftForTests, updateDraft } from '../draft';
import type { CoverState } from '../create-model';
import type { CreateProgressV2, CreateRunV2 } from './create-send';
import { DEMO_LISTINGS } from './listings';
import { buildSpecV2 } from './model';
import { CONFIGURATIONS } from './test-support/example-configurations';
import { inputV2Of, seedV2 } from './test-support/v2-fixtures';
import { resetV2ForTests } from './v2-draft';
import * as free from './useFreePictures';
import { ARWEAVE_NOTE, ArweaveLines, useFreePictures, type FreePicturesInput } from './useFreePictures';
import * as publishing from './usePicturePublish';
import * as send from './useCreateSend';

const SEPOLIA = 11155111;
const ZERO = `0x${'0'.repeat(64)}` as const;
/** A PNG-headed picture of `size` bytes as the draft keeps it. */
function picture(size: number, seed = 1): CoverState {
  const bytes = Uint8Array.from({ length: size }, (_, i) => (i < 8 ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][i] ?? 0 : (seed + i) & 255));
  return { sha256: sha256Hex(bytes) as `0x${string}`, url: null, bytes: size, data: Buffer.from(bytes).toString('base64') };
}
const input = (logo: CoverState, more: Partial<FreePicturesInput> = {}): FreePicturesInput => ({
  on: true, chainId: SEPOLIA, spec: { coverSha256: logo.sha256, collectionCoverSha256: ZERO }, draft: { cover: logo, collectionCover: null },
  fitNow: async (chainId) => fitsFree(chainId, 107_520), ...more,
});

beforeEach(() => { resetFreeLimitForTests(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('useFreePictures', () => {
  it('off (no Arweave for this source): no fit, no refusal, Create goes ahead at once', () => {
    const { result } = renderHook(() => useFreePictures(input(picture(200_000), { on: false })));
    expect(result.current).toMatchObject({ on: false, readFit: null, refused: false });
    const start = vi.fn();
    result.current.beforeCreate(start);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('a fit check that finishes after unmount cannot start creation', async () => {
    let finish!: (fit: ReturnType<typeof fitsFree>) => void;
    const fitNow = () => new Promise<ReturnType<typeof fitsFree>>((resolve) => { finish = resolve; });
    const hook = renderHook(() => useFreePictures(input(picture(90_000), { fitNow })));
    const start = vi.fn();
    hook.result.current.beforeCreate(start);
    hook.unmount();
    await act(async () => finish(fitsFree(SEPOLIA, 107_520)));
    expect(start).not.toHaveBeenCalled();
  });

  it('a logo that fits: Create asks Turbo’s free size, then starts', async () => {
    const fitNow = vi.fn(async (chainId: number) => fitsFree(chainId, 107_520));
    const { result } = renderHook(() => useFreePictures(input(picture(90_000), { fitNow })));
    expect(result.current).toMatchObject({ on: true, refused: false });
    expect(await result.current.readFit?.()).toBeTypeOf('function');
    const start = vi.fn();
    await act(async () => { result.current.beforeCreate(start); });
    expect(fitNow).toHaveBeenCalledWith(SEPOLIA);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('a logo over the free size (an earlier draft, a loaded setup): refused before anything is signed', async () => {
    const { result } = renderHook(() => useFreePictures(input(picture(120_000))));
    expect(result.current.refused).toBe(true);
    const start = vi.fn();
    await act(async () => { result.current.beforeCreate(start); });
    expect(start).not.toHaveBeenCalled();
  });

  it('Turbo’s free size went down: the press refuses, and says so until the picture changes', async () => {
    const small = vi.fn(async (chainId: number) => fitsFree(chainId, 20_000));
    const { result, rerender } = renderHook((props: FreePicturesInput) => useFreePictures(props), { initialProps: input(picture(50_000), { fitNow: small }) });
    expect(result.current.refused).toBe(false);
    const start = vi.fn();
    await act(async () => { result.current.beforeCreate(start); });
    expect(start).not.toHaveBeenCalled();
    expect(result.current.refused).toBe(true);
    rerender(input(picture(10_000, 2), { fitNow: small }));
    expect(result.current.refused).toBe(false);
  });
});

describe('ArweaveLines', () => {
  it('one line before Create, and the refusal as an alert; nothing where Arweave is off', () => {
    const { container, rerender } = render(<ArweaveLines on={false} refused />);
    expect(container.innerHTML).toBe('');
    rerender(<ArweaveLines on refused={false} />);
    expect(screen.getByText(ARWEAVE_NOTE)).toBeTruthy();
    expect(ARWEAVE_NOTE).toBe('Logo and cover go on Arweave: public and permanent.');
    expect(screen.queryByRole('alert')).toBeNull();
    rerender(<ArweaveLines on refused />);
    expect(screen.getByRole('alert').textContent).toBe(`! ${TOO_DETAILED}`);
  });
});

describe('the bar on a real build with Arweave on', () => {
  const useSource = dataSource.useDataSource;
  const useCurrentWallet = wallet.useWallet;
  const start = vi.fn(async () => undefined);
  let refused = false;
  const beforeCreate = vi.fn((go: () => void) => { if (!refused) go(); });
  beforeEach(() => {
    resetDraftForTests();
    resetV2ForTests();
    start.mockClear();
    beforeCreate.mockClear();
    refused = false;
    vi.spyOn(dataSource, 'useDataSource').mockImplementation(function useChainSource() { return { ...useSource(), isDemo: false }; });
    vi.spyOn(wallet, 'useWallet').mockImplementation(function useBrowserWallet() {
      return { ...useCurrentWallet(), status: 'connected', kind: 'injected', account: wallet.DEMO_WALLET_A, chainId: SEPOLIA, signer: { request: vi.fn(), walletName: 'Test' } };
    });
    vi.spyOn(send, 'useCreateSend').mockImplementation(() => ({ available: true, view: { phase: 'idle' }, run: null, runSpec: null, otherBox: null, resumes: false, created: false, start, stop: vi.fn(), forget: vi.fn() }));
    vi.spyOn(free, 'useFreePictures').mockImplementation(() => ({ on: true, readFit: null, refused, beforeCreate }));
    const config = CONFIGURATIONS.find((entry) => entry.id === 'rug-rugs');
    if (!config) throw new Error('rug-rugs');
    seedV2(config);
  });
  const renderOverview = () => render(
    <AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}>
      <MemoryRouter initialEntries={['/create/v2-overview']}>
        <Routes><Route element={<Shell />}><Route path="create/:step" element={<CreatePage demoStepMs={0} v2Listings={DEMO_LISTINGS} />} /></Route></Routes>
      </MemoryRouter>
    </AppProviders>,
  );

  it('the one line before Create; Create goes through the free check, then sends', async () => {
    renderOverview();
    expect(screen.getByText(ARWEAVE_NOTE)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create' })));
    expect(beforeCreate).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('a picture that does not fit: one short line, Create disabled, nothing sent', async () => {
    refused = true;
    renderOverview();
    expect(screen.getAllByRole('alert').some((alert) => alert.textContent?.includes(TOO_DETAILED))).toBe(true);
    const button = screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await act(async () => fireEvent.click(button));
    expect(beforeCreate).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});

/**
 * Fix round 1. F1: Create's press hands the run the pictures' publish as the step before its wallet (usePicturePublish's
 * `beforeWallet`), and the line shows its state with Retry. F4: a press that resumes the saved run before its createBox
 * was sent checks the run's own pictures (where the draft holds them) against Turbo's free size, like a fresh press.
 */
describe('fix round 1: Create’s press on a real build with Arweave on', () => {
  const useSource = dataSource.useDataSource;
  const useCurrentWallet = wallet.useWallet;
  const realFree = free.useFreePictures;
  const start = vi.fn(async () => undefined);
  const rugRugs = CONFIGURATIONS.find((entry) => entry.id === 'rug-rugs');
  if (!rugRugs) throw new Error('rug-rugs');
  const HASH = `0x${'2'.repeat(64)}` as const;
  const run = { chainId: SEPOLIA, creator: wallet.DEMO_WALLET_A, factory: wallet.DEMO_WALLET_A, encoded: '0x00', cs: `0x${'0'.repeat(64)}`, hs: `0x${'1'.repeat(64)}`,
    coordinator: wallet.DEMO_WALLET_A, token: wallet.DEMO_WALLET_A, bootstrapQ: '10', sent: { approve: HASH } } as CreateRunV2;
  const step = (kind: 'approve' | 'createBox') => ({ key: kind, label: kind, call: { kind, to: wallet.DEMO_WALLET_A, data: '0x' as const, value: 0n } });
  const progress = (done: boolean[]): CreateProgressV2 => ({ steps: [step('approve'), step('createBox')], done, later: [], plan: {} as CreateProgressV2['plan'] });
  const runSpecWith = (logo: CoverState) => ({ ...buildSpecV2(inputV2Of(rugRugs)), coverSha256: logo.sha256 });
  let sendInput: send.CreateSendInput | null = null;
  let saved: Partial<ReturnType<typeof send.useCreateSend>> = {};
  beforeEach(() => {
    resetDraftForTests();
    resetV2ForTests();
    start.mockClear();
    sendInput = null;
    saved = {};
    vi.spyOn(dataSource, 'useDataSource').mockImplementation(function useChainSource() { return { ...useSource(), isDemo: false }; });
    vi.spyOn(wallet, 'useWallet').mockImplementation(function useBrowserWallet() {
      return { ...useCurrentWallet(), status: 'connected', kind: 'injected', account: wallet.DEMO_WALLET_A, chainId: SEPOLIA, signer: { request: vi.fn(), walletName: 'Test' } };
    });
    vi.spyOn(send, 'useCreateSend').mockImplementation((given) => {
      sendInput = given;
      return { available: true, view: { phase: 'idle' }, run: null, runSpec: null, otherBox: null, resumes: false, created: false, start, stop: vi.fn(), forget: vi.fn(), ...saved };
    });
    // The real free check, with Arweave on for this chain and Turbo's free size as it stood on 2026-10-24.
    vi.spyOn(free, 'useFreePictures').mockImplementation(function useFreeOn(given) { return realFree({ ...given, on: true, chainId: SEPOLIA, fitNow: async (chainId) => fitsFree(chainId, 107_520) }); });
    seedV2(rugRugs);
  });
  const renderOverview = () => render(
    <AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}>
      <MemoryRouter initialEntries={['/create/v2-overview']}>
        <Routes><Route element={<Shell />}><Route path="create/:step" element={<CreatePage demoStepMs={0} v2Listings={DEMO_LISTINGS} />} /></Route></Routes>
      </MemoryRouter>
    </AppProviders>,
  );

  it('F1: the run gets the pictures’ publish as its step before the wallet; the line shows, with Retry', async () => {
    const beforeWallet = vi.fn(async () => true);
    const retry = vi.fn();
    vi.spyOn(publishing, 'usePicturePublish').mockImplementation(() => ({ view: { phase: 'failed', done: 1, total: 2, reason: 'network' }, beforeWallet, retry }));
    updateDraft((d) => ({ ...d, cover: picture(10_000, 3) }));
    renderOverview();
    expect(sendInput?.beforeWallet).toBe(beforeWallet);
    expect(screen.getByText('Pictures not published · 1/2')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })));
    expect(retry).toHaveBeenCalledTimes(1);
    // Create still goes on (it is never held for good by the pictures).
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create' })));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('F4: Continue on a saved run whose createBox was not sent checks the run’s own pictures: one that does not fit is refused, nothing sent', async () => {
    const big = picture(120_000, 7);
    updateDraft((d) => ({ ...d, cover: big }));
    saved = { run, runSpec: runSpecWith(big), resumes: true, created: false, view: { phase: 'stopped', progress: progress([true, false]) } };
    const first = renderOverview();
    expect(screen.getAllByRole('alert').some((alert) => alert.textContent?.includes(TOO_DETAILED))).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Continue' })));
    expect(start).not.toHaveBeenCalled();
    first.unmount();
    // The run's own pictures, not the page's: here only the run commits the (too large) collection cover the draft
    // holds; the page's token draft commits none, so its own spec would pass.
    const small = picture(50_000, 10);
    updateDraft((d) => ({ ...d, cover: small, collectionCover: big }));
    saved = { ...saved, runSpec: { ...runSpecWith(small), collectionCoverSha256: big.sha256 } };
    renderOverview();
    expect(screen.getAllByRole('alert').some((alert) => alert.textContent?.includes(TOO_DETAILED))).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Continue' })));
    expect(start).not.toHaveBeenCalled();
  });

  it('F4: the run’s pictures that fit go on; once createBox was sent or the box is created, Continue always goes on (the box must be finished)', async () => {
    const small = picture(50_000, 8);
    updateDraft((d) => ({ ...d, cover: small }));
    saved = { run, runSpec: runSpecWith(small), resumes: true, created: false, view: { phase: 'stopped', progress: progress([true, false]) } };
    const first = renderOverview();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Continue' })));
    expect(start).toHaveBeenCalledTimes(1);
    first.unmount();
    const big = picture(120_000, 9);
    updateDraft((d) => ({ ...d, cover: big }));
    for (const state of [{ created: false, sent: { ...run.sent, createBox: HASH } }, { created: true, sent: { ...run.sent, createBox: HASH } }]) {
      saved = { run: { ...run, sent: state.sent }, runSpec: runSpecWith(big), resumes: true, created: state.created, view: { phase: 'stopped', progress: progress([true, state.created]) } };
      const shown = renderOverview();
      expect(screen.queryAllByRole('alert').some((alert) => alert.textContent?.includes(TOO_DETAILED))).toBe(false);
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Continue' })));
      shown.unmount();
    }
    expect(start).toHaveBeenCalledTimes(3);
  });
});

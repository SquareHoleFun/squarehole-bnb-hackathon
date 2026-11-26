/**
 * F166 (SH-ALPHA-ONBOARDING): the alpha's welcome step on the app's pages, over doubles of our server, Privy's bridge
 * and the wallet context: one choice for an approved tester not set up yet, "Finish setup" after a setup left midway,
 * nothing for anyone else and nothing on the test-coin page. Nothing of Privy loads and no wallet is asked anything
 * before the press. Af1: a sheet over the page that moves nothing, armed a moment after it appears, put away for the
 * visit with "Not now", and gone while a wallet's own window asks. Af2: the press runs the setup in the background: the
 * sheet goes, the run's chip in the top bar shows its ticks (a stop on the chip, its details with Try again and Close),
 * its end a toast; after a reload mid-run the chip offers "Finish setup".
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRY_RUN_REASON, type AlphaApi, type AlphaMe, type AlphaResult, type ClaimChallenge, type ClaimState } from '../alpha-sepolia/alpha-api';
import { CLAIM_WORDS, SETUP_DETAILS, SETUP_WORDS, claimLine } from '../alpha-sepolia/alpha-words';
import type { MadeWallet, PrivyBridge } from '../alpha-sepolia/privy-bridge';
import { readSetupHint, writeSetupHint, type SetupHintState } from '../alpha-sepolia/setup-hint';
import { appCopyFraming, renderedCopy } from '../legal/wording';
import { PAGE_TITLE_ID } from '../../pages/page-parts';
import { setSetupChipSlot } from '../../shell/setup-chip-slot';
import { AlphaWelcome } from './AlphaWelcome';
import { resetMadeWalletForTests } from './made-wallet';
import { SetupToast, TOAST_MS, chipWords, toastWords } from './SetupChip';
import { ARM_MS } from './SetupPanel';
import { manualChosen, resetSetupForTests } from './setup-run';

// Anvil's well-known default account #1 (a public test key): the made wallet's signature is a real one.
const MADE = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const ADDRESS = MADE.address;
const ID = '0b6a2f9e-6c1d-4f3a-9b2e-1d2c3b4a5f60';
const APP_ID = 'cmtestappid00000000000000';
const textFor = (address: string) => `Square Hole alpha claim\n\nI link my X account @tester (X ID 123) to wallet ${address}.\nI request starter SepETH on Sepolia (chain 11155111).\nClaim ID: ${ID}\nTime: 2026-11-01T08:00:00.000Z\nSite: https://test-app.squarehole.fun`;

const wallet = vi.hoisted(() => ({}) as {
  status: 'disconnected' | 'connecting' | 'connected'; kind: 'injected'; account: string | null; chainId: number | null; walletName: string | null;
  signer: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown>; walletName: string; confirmsInPage?: true } | null;
  resumeProvidedWallet: (() => { current: () => boolean; connect: (made: { id: string; name: string; provider: unknown }) => Promise<boolean> }) | null;
  switchChain: (chainId: number) => Promise<void>;
  requests: { method: string; params?: unknown[] }[];
});
vi.mock('../wallet', () => ({
  useWallet: () => wallet,
  shortAddress: (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`,
}));

/** The made wallet's signer: it signs the claim on the press with no window. */
const madeSigner = () => ({
  walletName: 'Wallet Privy made', confirmsInPage: true as const,
  request: async (args: { method: string; params?: unknown[] }) => {
    wallet.requests.push(args);
    return MADE.signMessage({ message: { raw: (args.params as [`0x${string}`])[0] } });
  },
});

/** The run's clock: each wait moves it on at once, so every wait of the run ends (none can hang a test). */
const clock = { now: 0 };
const TIMING = { now: () => clock.now, sleep: async (ms: number) => { clock.now += ms; await Promise.resolve(); } };

beforeEach(() => {
  resetMadeWalletForTests();
  resetSetupForTests();
  clock.now = 0;
  Object.assign(wallet, {
    status: 'disconnected', kind: 'injected', account: null, chainId: null, walletName: null, signer: null, requests: [], switchChain: async () => undefined,
    resumeProvidedWallet: () => ({
      current: () => wallet.status === 'disconnected',
      connect: async () => {
        if (wallet.status !== 'disconnected') return false;
        Object.assign(wallet, { status: 'connected', account: ADDRESS, chainId: 11155111, walletName: 'Wallet Privy made', signer: madeSigner() });
        return true;
      },
    }),
  });
  try { window.localStorage.clear(); } catch { /* none */ }
});
afterEach(cleanup);

const receipt = (status: ClaimState['status'], over: Partial<ClaimState> = {}): ClaimState => ({ id: ID, status, admitTx: null, sendTx: null, reason: null, at: status === 'queued' ? null : '2026-11-01T08:05:00Z', ...over });
const DRY = receipt('skipped', { reason: DRY_RUN_REASON });

function server(me: AlphaResult<AlphaMe>, states: ClaimState[] = [DRY]) {
  const calls: string[] = [];
  const api: AlphaApi = {
    intake: vi.fn(async () => ({ ok: true as const, value: { open: true, returning: false } })), me: vi.fn(async () => { calls.push('me'); return me; }),
    session: vi.fn(), signOut: vi.fn(), signups: vi.fn(), decide: vi.fn(),
    claimMessage: vi.fn(async (address: string): Promise<AlphaResult<ClaimChallenge>> => { calls.push('message'); return { ok: true, value: { id: ID, address: address as `0x${string}`, message: textFor(address), requestedAt: '2026-11-01T08:00:00.000Z' } }; }),
    claim: vi.fn(async (): Promise<AlphaResult<ClaimState>> => { calls.push('claim'); return { ok: true, value: receipt('queued') }; }),
    claimState: vi.fn(async (): Promise<AlphaResult<ClaimState>> => { calls.push('state'); return { ok: true, value: states.shift() ?? receipt('queued') }; }),
  };
  return { api, calls };
}
const approved = (claim: ClaimState | null = null): AlphaResult<AlphaMe> => ({ ok: true, value: { status: 'approved', handle: 'tester', claim } });

function privyDouble(options: { fails?: number } = {}) {
  let failures = options.fails ?? 0;
  const made: MadeWallet = { address: ADDRESS, provider: { request: vi.fn() } };
  const bridge: PrivyBridge = {
    ready: vi.fn(async () => undefined), authenticated: vi.fn(() => true), signIn: vi.fn(), finishSignIn: vi.fn(), identityToken: vi.fn(), signOut: vi.fn(),
    madeWallet: vi.fn(async () => made), exportWallet: vi.fn(),
    makeWallet: vi.fn(async () => { if (failures > 0) { failures -= 1; throw new Error('Privy’s wallet frame did not load'); } return made; }),
  };
  return { bridge, load: vi.fn(async () => bridge) };
}

/** Where the router is (the step's "I'll do it myself" goes to the test-coin page), and the page's own heading. */
function Page() {
  return (
    <>
      <h1 id={PAGE_TITLE_ID} tabIndex={-1}>Page</h1>
      <output aria-label="Where">{useLocation().pathname}</output>
    </>
  );
}
/** The top bar's place for the chip, as TopBar.tsx hands it over in Sepolia trade builds. */
function Bar() {
  return <header aria-label="Top bar"><span ref={setSetupChipSlot} /></header>;
}
const where = () => screen.getByRole('status', { name: 'Where' }).textContent;
function renderAt(path: string, api: AlphaApi, load = privyDouble().load) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<><Bar /><AlphaWelcome api={api} loadPrivy={load} appId={APP_ID} target={() => ({ ok: false, reason: 'source_unavailable' })} timing={TIMING} /><Page /></>} />
      </Routes>
    </MemoryRouter>,
  );
}
const step = () => screen.queryByRole('region', { name: SETUP_WORDS.title });
const bar = () => screen.getByRole('banner', { name: 'Top bar' });
/** The run's chip in the top bar, by its name ("Setup: …"). */
const chip = () => within(bar()).queryByRole('button', { name: new RegExp(`^${SETUP_WORDS.chipName}: `) });
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
/** A press once the step's buttons are armed (SetupPanel.tsx `ARM_MS` after it appears). */
async function pressArmed(button: HTMLElement) {
  await waitFor(() => expect((button as HTMLButtonElement).disabled || button.getAttribute('aria-disabled') === 'true').toBe(false));
  await act(async () => { fireEvent.click(button); });
}

describe('the alpha’s welcome step (F166, SH-ALPHA-ONBOARDING)', () => {
  it('an approved tester not set up: one choice, minimal words, what it does behind a closed Details; nothing of Privy, no wallet asked', async () => {
    const { api, calls } = server(approved());
    const privy = privyDouble();
    renderAt('/', api, privy.load);
    const region = await screen.findByRole('region', { name: SETUP_WORDS.title });
    expect(within(region).getByText(SETUP_WORDS.lead)).toBeTruthy();
    expect(within(region).getByRole('button', { name: SETUP_WORDS.start })).toBeTruthy();
    // Today's steps live on the test-coin page: the small entry says so, and is a link there.
    expect(within(region).getByRole('link', { name: SETUP_WORDS.manualThere }).getAttribute('href')).toBe('/test-coins');
    expect(within(region).getByRole('button', { name: SETUP_WORDS.notNow })).toBeTruthy();
    const details = within(region).getByRole('button', { name: `Details: ${SETUP_WORDS.whatHappens}` });
    expect(details.getAttribute('aria-expanded')).toBe('false');
    for (const line of SETUP_DETAILS) expect(within(region).getByText(line).closest('[hidden]')).not.toBeNull();
    expect(region.getAttribute('data-setup')).toBe('start');
    await settle();
    expect(calls).toEqual(['me']);
    expect(privy.load).not.toHaveBeenCalled();
    expect(wallet.requests).toEqual([]);
    expect(appCopyFraming(renderedCopy(region))).toEqual([]);
  });

  it('af1 F2: its presses are armed only a moment after it appears; a tap meant for what stood there before does nothing', async () => {
    const { api, calls } = server(approved());
    const privy = privyDouble();
    renderAt('/', api, privy.load);
    const region = await screen.findByRole('region', { name: SETUP_WORDS.title });
    const start = within(region).getByRole('button', { name: SETUP_WORDS.start }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    await act(async () => { fireEvent.click(start); });
    fireEvent.click(within(region).getByRole('link', { name: SETUP_WORDS.manualThere }));
    fireEvent.click(within(region).getByRole('button', { name: SETUP_WORDS.notNow }));
    await settle();
    expect(privy.load).not.toHaveBeenCalled();
    expect(calls).toEqual(['me']);
    expect(where()).toBe('/');
    expect(step()).not.toBeNull();
    // Armed after ARM_MS: the same press now runs.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, ARM_MS + 20)); });
    expect(start.disabled).toBe(false);
  });

  it('af1 F2: a sheet over the page: the page keeps room below its end as tall as the sheet, and gives it back when the sheet goes', async () => {
    const { api } = server(approved());
    renderAt('/', api);
    const region = await screen.findByRole('region', { name: SETUP_WORDS.title });
    expect(region.className).toContain('sh-welcome');
    // jsdom measures nothing (0px); the property is there while the sheet shows, and gone after "Not now".
    // AlphaWelcome sets and removes it in a passive effect, which can run after the region is found: wait for it
    // (under gate load on 2026-11-12 the read came first and saw '').
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--sh-welcome-room')).toBe('0px'));
    await pressArmed(within(region).getByRole('button', { name: SETUP_WORDS.notNow }));
    expect(step()).toBeNull();
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--sh-welcome-room')).toBe(''));
  });

  it('af1 F3: “Not now” puts it away for this visit, with the focus on the page’s heading; the next visit offers it again', async () => {
    const { api } = server(approved());
    renderAt('/', api);
    await pressArmed(await screen.findByRole('button', { name: SETUP_WORDS.notNow }));
    expect(step()).toBeNull();
    expect(document.activeElement?.id).toBe(PAGE_TITLE_ID);
    expect(readSetupHint('tester')).toBeNull();
    cleanup();
    renderAt('/', server(approved()).api);
    expect(await screen.findByRole('button', { name: SETUP_WORDS.start })).toBeTruthy();
  });

  it('after a setup this device left midway: no sheet; the chip in the top bar offers “Finish setup” in its details, and nothing resumes by itself', async () => {
    writeSetupHint({ handle: 'tester', state: 'started', claimId: ID });
    const { api, calls } = server(approved(receipt('queued')));
    const privy = privyDouble();
    renderAt('/box/sepolia/0x1', api, privy.load);
    const button = await waitFor(() => { const found = chip(); if (!found) throw new Error('no chip yet'); return found; });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(within(button).getByText(SETUP_WORDS.finish)).toBeTruthy();
    expect(step()).toBeNull();
    await settle();
    expect(calls).toEqual(['me']);
    expect(privy.load).not.toHaveBeenCalled();
    expect(wallet.requests).toEqual([]);
    // Its details, on a press: "Finish setup" (one press), today's steps, "Not now"; still nothing asked.
    await pressArmed(button);
    const details = within(bar()).getByRole('group', { name: SETUP_WORDS.title });
    expect(within(details).getByRole('button', { name: SETUP_WORDS.finish })).toBeTruthy();
    expect(within(details).getByRole('link', { name: SETUP_WORDS.manualThere })).toBeTruthy();
    expect(within(details).getByRole('button', { name: SETUP_WORDS.notNow })).toBeTruthy();
    expect(privy.load).not.toHaveBeenCalled();
    // Escape closes the details and gives the keyboard back to the chip.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(within(bar()).queryByRole('group')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('nothing for a tester who finished, chose to do it themselves or ended, has a claim this device’s setup did not make, or a wallet of their own (connected or still asking); nor for anyone not approved', async () => {
    const OTHER_CLAIM = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
    const cases: ReadonlyArray<readonly [string, AlphaResult<AlphaMe>, { state: SetupHintState; claimId?: string } | null, 'connected' | 'connecting' | null]> = [
      ['done', approved(receipt('sent')), { state: 'done', claimId: ID }, null],
      ['manual', approved(), { state: 'manual' }, null],
      ['manual, with a claim made by hand', approved(receipt('queued')), { state: 'manual' }, null],
      ['ended', approved(), { state: 'ended' }, null],
      ['a claim without the hint', approved(receipt('queued')), null, null],
      ['a claim another setup made', approved(receipt('queued')), { state: 'started', claimId: OTHER_CLAIM }, null],
      ['a browser wallet connected', approved(), null, 'connected'],
      ['a browser wallet still asking', approved(), null, 'connecting'],
      ['a browser wallet asking, after a setup left midway', approved(), { state: 'started', claimId: ID }, 'connecting'],
      ['pending', { ok: true, value: { status: 'pending', handle: 'tester', claim: null } }, null, null],
      ['removed', { ok: true, value: { status: 'removed', handle: 'tester', claim: null } }, null, null],
      ['signed out', { ok: false, status: 401, error: 'sign in required' }, null, null],
      ['no answer', { ok: false, status: 0, error: 'no answer' }, null, null],
    ];
    for (const [name, me, hint, browserWallet] of cases) {
      cleanup();
      window.localStorage.clear();
      if (hint) writeSetupHint({ handle: 'tester', ...hint });
      if (browserWallet === 'connected') Object.assign(wallet, { status: 'connected', account: ADDRESS, signer: { walletName: 'Browser wallet', request: async () => null } });
      else if (browserWallet === 'connecting') Object.assign(wallet, { status: 'connecting', account: null, signer: null });
      else Object.assign(wallet, { status: 'disconnected', account: null, signer: null });
      const { api } = server(me);
      renderAt('/', api);
      await waitFor(() => expect(api.me).toHaveBeenCalled());
      await settle();
      expect(step(), name).toBeNull();
    }
  });

  it('not on the test-coin page, whose Claim card holds the same choice: nothing shown and nothing asked', async () => {
    const { api } = server(approved());
    renderAt('/test-coins', api);
    await settle();
    expect(step()).toBeNull();
    expect(api.me).not.toHaveBeenCalled();
  });

  it('“I’ll do it myself on Test coins”: the test-coin page opens on today’s steps, on purpose, and the app’s pages ask no more on this device', async () => {
    const { api } = server(approved());
    renderAt('/', api);
    await pressArmed(await screen.findByRole('link', { name: SETUP_WORDS.manualThere }));
    await waitFor(() => expect(where()).toBe('/test-coins'));
    expect(readSetupHint('tester')?.state).toBe('manual');
    expect(manualChosen()).toBe(true);
  });

  it('af2: “Set me up” runs in the background: the sheet goes at once and the chip in the top bar shows the run on every page; a stop shows on the chip, its details hold Try again and Close', async () => {
    const { api, calls } = server(approved());
    const privy = privyDouble({ fails: 1 });
    const view = renderAt('/', api, privy.load);
    const region = await screen.findByRole('region', { name: SETUP_WORDS.title });
    await pressArmed(within(region).getByRole('button', { name: SETUP_WORDS.start }));
    // The sheet is gone; the chip took its place in the top bar, and the keyboard with it.
    expect(step()).toBeNull();
    const button = chip();
    expect(button).not.toBeNull();
    expect(document.activeElement).toBe(button);
    // Privy could not make the wallet: the chip shows the stop (and says it once), its details the line and Try again.
    await waitFor(() => expect(bar().querySelector('[data-phase]')?.getAttribute('data-phase')).toBe('stopped'));
    expect(within(bar()).getByRole('status').textContent).toBe(CLAIM_WORDS.madeWalletFailed);
    expect(within(chip() as HTMLElement).getByText(SETUP_WORDS.chipStopped)).toBeTruthy();
    expect([...bar().querySelectorAll('.sh-setup-chip__tick')].map((tick) => tick.getAttribute('data-mark'))).toEqual(['failed', 'todo', 'todo', 'todo']);
    expect(readSetupHint('tester')).toEqual({ state: 'started', claimId: null });
    await pressArmed(chip() as HTMLElement);
    const details = within(bar()).getByRole('group', { name: SETUP_WORDS.title });
    const steps = within(details).getByRole('list', { name: SETUP_WORDS.stepsLabel });
    expect(within(steps).getAllByRole('listitem')[0]?.textContent).toBe(`${SETUP_WORDS.stepWallet}: ${SETUP_WORDS.markFailed}`);
    expect(within(details).getByText(CLAIM_WORDS.madeWalletFailed)).toBeTruthy();
    expect(within(details).getByRole('button', { name: SETUP_WORDS.close })).toBeTruthy();
    await pressArmed(within(details).getByRole('button', { name: SETUP_WORDS.tryAgain }));
    // The second press: the wallet, the claim signed by it, and the sender's dry run, which ends the run in test mode.
    await waitFor(() => expect(bar().querySelector('[data-phase]')?.getAttribute('data-phase')).toBe('test'));
    expect(calls).toEqual(['me', 'me', 'me', 'message', 'claim', 'state']);
    expect(wallet.requests.map(({ method }) => method)).toEqual(['personal_sign']);
    // The end, said once in a toast; the details keep the line and the test-coin page.
    const toast = await screen.findByText(SETUP_WORDS.testMode, { selector: '.sh-setup-toast__text' });
    expect(toast.closest('[role="status"]')).not.toBeNull();
    expect(within(details).queryByRole('button', { name: SETUP_WORDS.tryAgain })).toBeNull();
    expect(within(details).getByRole('link', { name: SETUP_WORDS.coinsPage }).getAttribute('href')).toBe('/test-coins');
    expect(appCopyFraming(renderedCopy(details))).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: SETUP_WORDS.dismiss }));
    expect(screen.queryByText(SETUP_WORDS.testMode, { selector: '.sh-setup-toast__text' })).toBeNull();
    // Close puts the run away: the chip goes, the keyboard to the page's heading.
    fireEvent.click(within(details).getByRole('button', { name: SETUP_WORDS.close }));
    await waitFor(() => expect(chip()).toBeNull());
    expect(document.activeElement?.id).toBe(PAGE_TITLE_ID);
    // af1 F4: the dry run freed the claim; this device's setup stays open, so the next visit offers "Finish setup".
    expect(readSetupHint('tester')).toEqual({ state: 'started', claimId: ID });
    expect(claimLine(DRY)).toBe('Not sent: a dry run. Claim again later.');
    view.unmount();
    resetSetupForTests();
    renderAt('/', server(approved(DRY)).api);
    await waitFor(() => expect(within(chip() as HTMLElement).getByText(SETUP_WORDS.finish)).toBeTruthy());
    expect(step()).toBeNull();
  });

  it('af2: the end’s toast says the numbers once and goes by itself; the chip’s words follow the run', () => {
    expect(toastWords({ phase: 'done', figures: { sepEth: 5n * 10n ** 16n, teth: 10n ** 18n } })).toBe('You’re set: 0.05 SepETH · 1 tETH');
    expect(toastWords({ phase: 'done', figures: null })).toBe(SETUP_WORDS.done);
    expect(toastWords({ phase: 'test', figures: null })).toBe(SETUP_WORDS.testMode);
    for (const phase of ['idle', 'running', 'stopped'] as const) expect(toastWords({ phase, figures: null }), phase).toBeNull();
    expect(['running', 'stopped', 'test', 'done', 'idle'].map((phase) => chipWords({ phase: phase as never })))
      .toEqual([SETUP_WORDS.chipRunning, SETUP_WORDS.chipStopped, SETUP_WORDS.chipTest, SETUP_WORDS.chipDone, SETUP_WORDS.finish]);
  });

  it('af2: the toast goes by itself after a while (its words stay in the chip’s details)', async () => {
    vi.useFakeTimers();
    try {
      const done = vi.fn();
      render(<SetupToast text="You’re set: 0.05 SepETH · 1 tETH" onDone={done} />);
      act(() => { vi.advanceTimersByTime(TOAST_MS - 1); });
      expect(done).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(1); });
      expect(done).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

import { ACCOUNT_A, ACCOUNT_B } from '@squarehole/chain/write/test-support';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlphaApi, AlphaMe, AlphaResult } from '../alpha-sepolia/alpha-api';
import { CLAIM_WORDS, SETUP_WORDS } from '../alpha-sepolia/alpha-words';
import type { MadeWallet, PrivyBridge } from '../alpha-sepolia/privy-bridge';
import { WalletError, WalletProvider, createDemoWalletAdapter, useWallet, type InjectedWalletAdapter, type ProvidedWallet, type WalletConnection, type WalletContextValue } from '../wallet';
import { AlphaWelcome } from './AlphaWelcome';
import { ClaimCard } from './ClaimCard';
import { resetMadeWalletForTests } from './made-wallet';
import { chooseManual, resetSetupForTests } from './setup-run';

/**
 * F161 (4), SH-ALPHA-SITE, XR-ALPHA-SITE af2: "Make me a wallet" waits for Privy (its code, readiness, the wallet it
 * makes); a browser wallet the person connects meanwhile (the top bar's, the faucet or swap card's) must stay. The real
 * WalletProvider and its ticket (`resumeProvidedWallet`), over an adapter double with the seam present, as in a
 * Sepolia trade build.
 */
const SEPOLIA = 11_155_111;
const APP_ID = 'cmtestappid00000000000000';

function adapterDouble() {
  let signer: InjectedWalletAdapter['signer'] = null;
  const calls: string[] = [];
  const browserConnection = (): WalletConnection => { signer = { request: vi.fn(), walletName: 'Browser wallet' }; return { account: ACCOUNT_B, chainId: SEPOLIA, personaId: null, walletName: 'Browser wallet' }; };
  const adapter: InjectedWalletAdapter = {
    kind: 'injected',
    connect: vi.fn(async (request = {}) => { calls.push(`connect ${request.walletId ?? ''}`); return browserConnection(); }),
    connectProvider: vi.fn(async (wallet: ProvidedWallet): Promise<WalletConnection> => {
      calls.push(`provided ${wallet.id}`);
      signer = { request: vi.fn(), walletName: wallet.name, confirmsInPage: true };
      return { account: ACCOUNT_A, chainId: SEPOLIA, personaId: null, walletName: wallet.name };
    }),
    disconnect: vi.fn(() => { calls.push('disconnect'); signer = null; }),
    switchChain: vi.fn(async () => undefined),
    onAccountsChanged: () => () => undefined,
    onChainChanged: () => () => undefined,
    discover: () => () => undefined,
    resume: vi.fn(async () => null),
    release: vi.fn(),
    get signer() { return signer; },
  };
  /** Holds the person's next connect (its wallet's window open) until the returned function answers it: yes, or no. */
  const holdConnect = () => {
    let answer: (yes: boolean) => void = () => undefined;
    const held = new Promise<boolean>((resolve) => { answer = resolve; });
    vi.mocked(adapter.connect).mockImplementationOnce(async (request = {}) => {
      calls.push(`connect ${request.walletId ?? ''}`);
      if (!(await held)) throw new WalletError('rejected', 'You declined the request in the wallet.');
      return browserConnection();
    });
    return (yes = true) => answer(yes);
  };
  return { adapter, calls, holdConnect };
}

/** Privy's bridge, its makeWallet() held until `release`. */
function privyDouble() {
  const made: MadeWallet = { address: ACCOUNT_A, provider: { request: vi.fn() } };
  let release: () => void = () => undefined;
  const held = new Promise<MadeWallet>((resolve) => { release = () => resolve(made); });
  const bridge: PrivyBridge = {
    ready: vi.fn(async () => undefined), authenticated: vi.fn(() => true), signIn: vi.fn(), finishSignIn: vi.fn(), identityToken: vi.fn(), signOut: vi.fn(),
    madeWallet: vi.fn(async () => null), makeWallet: vi.fn(() => held), exportWallet: vi.fn(),
  };
  return { bridge, load: vi.fn(async () => bridge), release: () => act(async () => { release(); await held; await new Promise((resolve) => setTimeout(resolve, 0)); }) };
}

const approved: AlphaResult<AlphaMe> = { ok: true, value: { status: 'approved', handle: 'tester', claim: null } };
const api = (): AlphaApi => ({ intake: vi.fn(async () => ({ ok: true as const, value: { open: true, returning: false } })), me: vi.fn(async () => approved), session: vi.fn(), signOut: vi.fn(), claimMessage: vi.fn(), claim: vi.fn(), claimState: vi.fn(), signups: vi.fn(), decide: vi.fn() });

const live = {} as { wallet: WalletContextValue };
function Probe() {
  const wallet = useWallet();
  useEffect(() => { live.wallet = wallet; });
  return null;
}
function renderCard(adapter: InjectedWalletAdapter, load: (appId: string) => Promise<PrivyBridge>) {
  return render(
    <WalletProvider adapter={createDemoWalletAdapter({ latencyMs: 0 })} injectedAdapter={adapter} defaultDialog="browser" walletKinds="browser" targetChainId={SEPOLIA}>
      <ClaimCard api={api()} loadPrivy={load} appId={APP_ID} />
      <Probe />
    </WalletProvider>,
  );
}
const card = () => screen.getByRole('region', { name: CLAIM_WORDS.title });
/** "Make me a wallet" pressed; Privy is now making it (makeWallet held). */
async function pressMake(privy: ReturnType<typeof privyDouble>) {
  const make = await within(card()).findByRole('button', { name: CLAIM_WORDS.makeOne });
  await act(async () => { fireEvent.click(make); });
  await waitFor(() => expect(privy.bridge.makeWallet).toHaveBeenCalledTimes(1));
}

// F166: today's "Make me a wallet", as the tester meets it after "I'll do it myself" (the flag that press sets).
beforeEach(() => { resetMadeWalletForTests(); resetSetupForTests(); chooseManual(); try { window.localStorage.clear(); } catch { /* none */ } });
afterEach(cleanup);

describe('“Make me a wallet” never takes the place of a wallet connected meanwhile (XR-ALPHA-SITE af2)', () => {
  it('with nothing connected meanwhile, the wallet Privy made connects', async () => {
    const double = adapterDouble();
    const privy = privyDouble();
    renderCard(double.adapter, privy.load);
    await pressMake(privy);
    await privy.release();
    expect(double.calls).toEqual(['provided privy']);
    expect(live.wallet).toMatchObject({ status: 'connected', account: ACCOUNT_A, walletName: 'Wallet Privy made' });
  });

  it('a browser wallet the person connected while Privy was making one stays, and nothing is revoked or forgotten', async () => {
    const double = adapterDouble();
    const privy = privyDouble();
    renderCard(double.adapter, privy.load);
    await pressMake(privy);
    await act(async () => { await live.wallet.connectBrowserWallet('org.example.wallet'); });
    await privy.release();
    expect(double.calls).toEqual(['connect org.example.wallet']);
    expect(double.adapter.connectProvider).not.toHaveBeenCalled();
    expect(live.wallet).toMatchObject({ status: 'connected', account: ACCOUNT_B, walletName: 'Browser wallet' });
    expect(within(card()).getByRole('button', { name: CLAIM_WORDS.getText })).toBeTruthy();
    // XR-ALPHA-SITE af4: no "Press Make me a wallet" while the card offers no such button.
    expect(within(card()).queryByRole('status')).toBeNull();
  });

  it('“Your wallet is made” waits while that browser wallet is in use, and shows beside “Make me a wallet” after a Disconnect, whose press connects it (XR-ALPHA-SITE af4)', async () => {
    const double = adapterDouble();
    const privy = privyDouble();
    renderCard(double.adapter, privy.load);
    await pressMake(privy);
    await act(async () => { await live.wallet.connectBrowserWallet('org.example.wallet'); });
    await privy.release();
    expect(within(card()).queryByRole('status')).toBeNull();
    expect(within(card()).queryByRole('button', { name: CLAIM_WORDS.makeOne })).toBeNull();
    act(() => { live.wallet.disconnect(); });
    expect(live.wallet.status).toBe('disconnected');
    expect(within(card()).getByRole('status').textContent).toBe(CLAIM_WORDS.madeWalletWaits);
    const make = within(card()).getByRole('button', { name: CLAIM_WORDS.makeOne }) as HTMLButtonElement;
    expect(make.disabled).toBe(false);
    await act(async () => { fireEvent.click(make); });
    await waitFor(() => expect(live.wallet).toMatchObject({ status: 'connected', account: ACCOUNT_A, walletName: 'Wallet Privy made' }));
    expect(double.calls).toEqual(['connect org.example.wallet', 'disconnect', 'provided privy']);
    expect(within(card()).queryByRole('status')).toBeNull();
  });

  it('a browser wallet the person declined while Privy was making one: the card says the wallet is made, and the next press connects it (XR-ALPHA-SITE af3)', async () => {
    const double = adapterDouble();
    const privy = privyDouble();
    renderCard(double.adapter, privy.load);
    await pressMake(privy);
    const answer = double.holdConnect();
    let pressed: Promise<void> = Promise.resolve();
    act(() => { pressed = live.wallet.connectBrowserWallet('org.example.wallet'); });
    const settled = pressed.then(() => 'yes', () => 'no');
    await act(async () => { answer(false); await settled; });
    await privy.release();
    expect(double.adapter.connectProvider).not.toHaveBeenCalled();
    expect(live.wallet.status).toBe('disconnected');
    expect(within(card()).getByRole('status').textContent).toBe(CLAIM_WORDS.madeWalletWaits);
    await act(async () => { fireEvent.click(within(card()).getByRole('button', { name: CLAIM_WORDS.makeOne })); });
    await waitFor(() => expect(double.adapter.connectProvider).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(live.wallet).toMatchObject({ status: 'connected', account: ACCOUNT_A, walletName: 'Wallet Privy made' }));
    expect(within(card()).queryByRole('status')).toBeNull();
  });

  it('a connect the person started before Privy answered, and that ends after it, still wins', async () => {
    const double = adapterDouble();
    const privy = privyDouble();
    renderCard(double.adapter, privy.load);
    await pressMake(privy);
    const free = double.holdConnect();
    let pressed: Promise<void> = Promise.resolve();
    act(() => { pressed = live.wallet.connectBrowserWallet('org.example.wallet'); });
    await privy.release();
    await act(async () => { free(); await pressed; });
    expect(double.calls).toEqual(['connect org.example.wallet']);
    expect(double.adapter.connectProvider).not.toHaveBeenCalled();
    expect(live.wallet).toMatchObject({ status: 'connected', account: ACCOUNT_B, walletName: 'Browser wallet' });
  });

  it('waits while a browser wallet’s own window is open, and is offered again after its no (XR-ALPHA-SITE af3)', async () => {
    const double = adapterDouble();
    const privy = privyDouble();
    renderCard(double.adapter, privy.load);
    const make = () => within(card()).getByRole('button', { name: CLAIM_WORDS.makeOne }) as HTMLButtonElement;
    await within(card()).findByRole('button', { name: CLAIM_WORDS.makeOne });
    expect(make().disabled).toBe(false);
    const answer = double.holdConnect();
    let pressed: Promise<void> = Promise.resolve();
    act(() => { pressed = live.wallet.connectBrowserWallet('org.example.wallet'); });
    const settled = pressed.then(() => 'yes', () => 'no');
    expect(live.wallet.status).toBe('connecting');
    expect(make().disabled).toBe(true);
    await act(async () => { fireEvent.click(make()); });
    expect(privy.bridge.makeWallet).not.toHaveBeenCalled();
    await act(async () => { answer(false); await settled; });
    expect(await settled).toBe('no');
    expect(live.wallet.status).toBe('disconnected');
    expect(make().disabled).toBe(false);
    expect(double.adapter.connectProvider).not.toHaveBeenCalled();
  });
});

/**
 * F166 af1 F1 (XR-ALPHA-SITE af3 order C): "Set me up" waits for a browser wallet's own window too. While the real wallet
 * context says `connecting`, the Claim card greys the press and the welcome sheet is not offered; a press in that time
 * reaches nobody, so the claim is never bound to the made wallet while the browser wallet still asks.
 */
describe('“Set me up” never runs while a browser wallet’s window is open (F166 af1 F1, XR-ALPHA-SITE af3)', () => {
  beforeEach(() => { resetSetupForTests(); });

  it('the Claim card: a held connect greys “Set me up”; a press does nothing and Privy is never asked; after its no, the press is back', async () => {
    const double = adapterDouble();
    const privy = privyDouble();
    renderCard(double.adapter, privy.load);
    const start = () => within(card()).getByRole('button', { name: SETUP_WORDS.start }) as HTMLButtonElement;
    await within(card()).findByRole('button', { name: SETUP_WORDS.start });
    await waitFor(() => expect(start().disabled).toBe(false));
    const answer = double.holdConnect();
    let pressed: Promise<void> = Promise.resolve();
    act(() => { pressed = live.wallet.connectBrowserWallet('org.example.wallet'); });
    const settled = pressed.then(() => 'yes', () => 'no');
    expect(live.wallet.status).toBe('connecting');
    expect(start().disabled).toBe(true);
    await act(async () => { fireEvent.click(start()); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(privy.load).not.toHaveBeenCalled();
    expect(privy.bridge.makeWallet).not.toHaveBeenCalled();
    await act(async () => { answer(false); await settled; });
    expect(await settled).toBe('no');
    expect(live.wallet.status).toBe('disconnected');
    expect(start().disabled).toBe(false);
    expect(double.adapter.connectProvider).not.toHaveBeenCalled();
  });

  it('the Claim card: the held connect answered yes leaves today’s steps with that wallet, and nothing of Privy’s', async () => {
    const double = adapterDouble();
    const privy = privyDouble();
    renderCard(double.adapter, privy.load);
    await within(card()).findByRole('button', { name: SETUP_WORDS.start });
    const answer = double.holdConnect();
    let pressed: Promise<void> = Promise.resolve();
    act(() => { pressed = live.wallet.connectBrowserWallet('org.example.wallet'); });
    await act(async () => { fireEvent.click(within(card()).getByRole('button', { name: SETUP_WORDS.start })); });
    await act(async () => { answer(true); await pressed; });
    expect(live.wallet).toMatchObject({ status: 'connected', account: ACCOUNT_B, walletName: 'Browser wallet' });
    expect(await within(card()).findByRole('button', { name: CLAIM_WORDS.getText })).toBeTruthy();
    expect(within(card()).queryByRole('button', { name: SETUP_WORDS.start })).toBeNull();
    expect(privy.load).not.toHaveBeenCalled();
    expect(privy.bridge.makeWallet).not.toHaveBeenCalled();
  });

  it('the welcome sheet: a held connect takes the offer away; a press on it reaches nobody, and it is back after the no', async () => {
    const double = adapterDouble();
    const privy = privyDouble();
    render(
      <WalletProvider adapter={createDemoWalletAdapter({ latencyMs: 0 })} injectedAdapter={double.adapter} defaultDialog="browser" walletKinds="browser" targetChainId={SEPOLIA}>
        <MemoryRouter initialEntries={['/']}>
          <AlphaWelcome api={api()} loadPrivy={privy.load} appId={APP_ID} target={() => ({ ok: false, reason: 'source_unavailable' })} />
        </MemoryRouter>
        <Probe />
      </WalletProvider>,
    );
    const offered = await screen.findByRole('button', { name: SETUP_WORDS.start }) as HTMLButtonElement;
    await waitFor(() => expect(offered.disabled).toBe(false));
    const answer = double.holdConnect();
    let pressed: Promise<void> = Promise.resolve();
    act(() => { pressed = live.wallet.connectBrowserWallet('org.example.wallet'); });
    const settled = pressed.then(() => 'yes', () => 'no');
    expect(live.wallet.status).toBe('connecting');
    expect(screen.queryByRole('button', { name: SETUP_WORDS.start })).toBeNull();
    await act(async () => { fireEvent.click(offered); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(privy.load).not.toHaveBeenCalled();
    expect(privy.bridge.makeWallet).not.toHaveBeenCalled();
    await act(async () => { answer(false); await settled; });
    expect(await screen.findByRole('button', { name: SETUP_WORDS.start })).toBeTruthy();
    expect(double.adapter.connectProvider).not.toHaveBeenCalled();
  });
});

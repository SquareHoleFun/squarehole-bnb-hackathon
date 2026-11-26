import { act, cleanup, render, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MadeWallet, PrivyBridge } from '../alpha-sepolia/privy-bridge';
import { MADE_WALLET_ID, MADE_WALLET_NAME, madeWalletBridge, rememberedMadeWallet, resetMadeWalletForTests, useMadeWalletResume } from './made-wallet';

/**
 * F161 (4), SH-ALPHA-SITE: the made wallet comes back on a page load as a browser wallet does (F135): only for the
 * wallet this device remembers, only while Privy holds the sign-in and the same address, never with a window or a press,
 * and never over the person's own choice (XR-ALPHA-SITE af1). The wallet context's double keeps its rule: a ticket taken
 * while nothing is connected ends at the person's next connect or disconnect (wallet-context.tsx `resumeProvidedWallet`).
 */
const ADDRESS = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed' as const;
const state = vi.hoisted(() => ({
  wallet: { status: 'disconnected', resumeProvidedWallet: null } as { status: string; resumeProvidedWallet: null | (() => { current: () => boolean; connect: (wallet: unknown) => Promise<boolean> }) },
  remembered: null as null | { provider: string; address: string },
  /** The context's connection generation: the person's connects and disconnects move it. */
  generation: 0,
  /** What the context connected through a ticket. */
  connected: [] as unknown[],
}));
vi.mock('../wallet', () => ({ useWallet: () => state.wallet }));
vi.mock('../wallet/injected-adapter', () => ({ rememberedHere: () => state.remembered }));

const walletDouble = () => ({
  status: 'disconnected',
  resumeProvidedWallet: () => {
    const started = state.generation;
    const current = () => started === state.generation;
    return {
      current,
      connect: async (wallet: unknown) => {
        if (!current()) return false;
        state.generation += 1;
        state.connected.push(wallet);
        return true;
      },
    };
  },
});
/** The person connects another wallet: the generation moves at once, the status with the next render. */
const personConnects = (status = 'connected') => {
  state.generation += 1;
  state.wallet = { ...state.wallet, status };
};

function bridgeFor(options: { signedIn?: boolean; address?: `0x${string}` | null } = {}) {
  const made: MadeWallet | null = options.address === null ? null : { address: options.address ?? ADDRESS, provider: { request: vi.fn() } };
  const bridge: PrivyBridge = {
    ready: vi.fn(async () => undefined), authenticated: vi.fn(() => options.signedIn ?? true), signIn: vi.fn(), finishSignIn: vi.fn(), identityToken: vi.fn(), signOut: vi.fn(),
    madeWallet: vi.fn(async () => made), makeWallet: vi.fn(), exportWallet: vi.fn(),
  };
  return { bridge, made, load: vi.fn(async () => bridge) };
}
/** A bridge whose first `madeWallet()` waits for `release` (Privy's wallet frame still loading). */
function heldBridge() {
  const privy = bridgeFor();
  let release: () => void = () => undefined;
  const held = new Promise<MadeWallet | null>((resolve) => { release = () => resolve(privy.made); });
  vi.mocked(privy.bridge.madeWallet).mockImplementationOnce(() => held);
  return { ...privy, release: async () => { await act(async () => { release(); await held; await new Promise((resolve) => setTimeout(resolve, 0)); }); } };
}

function Resume({ load }: { load: (appId: string) => Promise<PrivyBridge> }) {
  useMadeWalletResume(load, 'cmtestappid00000000000000');
  return null;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  resetMadeWalletForTests();
  state.generation = 0;
  state.connected = [];
  state.wallet = walletDouble();
  state.remembered = { provider: 'provided:privy', address: ADDRESS };
});
afterEach(cleanup);

describe('the made wallet’s reconnect on load (F161 (4), SH-ALPHA-SITE)', () => {
  it('comes back for the remembered address, through the wallet context’s ticket, as a resume', async () => {
    const privy = bridgeFor();
    render(<Resume load={privy.load} />);
    await waitFor(() => expect(state.connected).toHaveLength(1));
    expect(state.connected).toEqual([{ id: MADE_WALLET_ID, name: MADE_WALLET_NAME, provider: privy.made?.provider, resume: { address: ADDRESS } }]);
    // Once per page load.
    cleanup();
    render(<Resume load={privy.load} />);
    await settle();
    expect(state.connected).toHaveLength(1);
    expect(privy.bridge.ready).toHaveBeenCalledTimes(1);
  });

  it('loads nothing without the memory, or with another wallet remembered, or with a wallet already connected', async () => {
    for (const set of [() => { state.remembered = null; }, () => { state.remembered = { provider: 'eip6963:io.metamask', address: ADDRESS }; }, () => { state.wallet.status = 'connected'; }]) {
      resetMadeWalletForTests();
      state.wallet = walletDouble();
      state.remembered = { provider: 'provided:privy', address: ADDRESS };
      set();
      const privy = bridgeFor();
      render(<Resume load={privy.load} />);
      await settle();
      expect(privy.load).not.toHaveBeenCalled();
      expect(state.connected).toEqual([]);
      cleanup();
    }
  });

  it('stops for the visit when Privy holds no sign-in, no made wallet, or another address', async () => {
    for (const options of [{ signedIn: false }, { address: null }, { address: '0x0000000000000000000000000000000000000001' as const }]) {
      resetMadeWalletForTests();
      state.wallet = walletDouble();
      const privy = bridgeFor(options);
      render(<Resume load={privy.load} />);
      await waitFor(() => expect(privy.load).toHaveBeenCalled());
      await settle();
      expect(state.connected).toEqual([]);
      cleanup();
      render(<Resume load={privy.load} />);
      await settle();
      expect(privy.bridge.ready).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });

  it.each(['load', 'ready', 'madeWallet', 'connect'] as const)('retries a failed %s on the next mount only', async (step) => {
    const privy = bridgeFor();
    const error = new Error('no answer');
    if (step === 'load') privy.load.mockRejectedValueOnce(error);
    else if (step === 'connect') {
      const takeTicket = walletDouble().resumeProvidedWallet;
      state.wallet.resumeProvidedWallet = vi.fn(takeTicket).mockReturnValueOnce({
        ...takeTicket(),
        connect: async () => { state.generation += 1; throw error; },
      });
    } else vi.mocked(privy.bridge[step]).mockRejectedValueOnce(error);

    const view = render(<Resume load={privy.load} />);
    await settle();
    // Even a changed effect dependency on the same page cannot start another attempt.
    view.rerender(<Resume load={() => privy.load()} />);
    await settle();
    expect(state.connected).toEqual([]);
    expect(privy.load).toHaveBeenCalledTimes(1);
    cleanup();
    render(<Resume load={privy.load} />);
    await waitFor(() => expect(state.connected).toHaveLength(1));
    expect(privy.load).toHaveBeenCalledTimes(step === 'load' ? 2 : 1);
    expect(privy.bridge.ready).toHaveBeenCalledWith({ rejectOnTimeout: true });
  });

  it('a wallet the person connects while Privy is still answering wins: the late answer connects nothing (the review’s regression)', async () => {
    const privy = heldBridge();
    const view = render(<Resume load={privy.load} />);
    await waitFor(() => expect(privy.bridge.madeWallet).toHaveBeenCalledTimes(1));
    personConnects();
    view.rerender(<Resume load={privy.load} />);
    await privy.release();
    await settle();
    expect(state.connected).toEqual([]);
  });

  it('a connect the person started before React drew it is enough: the ticket has ended when Privy answers', async () => {
    const privy = heldBridge();
    render(<Resume load={privy.load} />);
    await waitFor(() => expect(privy.bridge.madeWallet).toHaveBeenCalledTimes(1));
    // The context moved its generation (wallet-context.tsx `run`, `disconnect`); the status has not reached this page.
    state.generation += 1;
    await privy.release();
    await settle();
    expect(state.connected).toEqual([]);
    // That attempt is over for this page load: a later disconnect does not start another one.
    personConnects('disconnected');
    cleanup();
    render(<Resume load={privy.load} />);
    await settle();
    expect(state.connected).toEqual([]);
  });

  it('a device that remembers another wallet by the time Privy answers keeps it', async () => {
    const privy = heldBridge();
    render(<Resume load={privy.load} />);
    await waitFor(() => expect(privy.bridge.madeWallet).toHaveBeenCalledTimes(1));
    state.remembered = { provider: 'eip6963:io.metamask', address: ADDRESS };
    await privy.release();
    await settle();
    expect(state.connected).toEqual([]);
  });

  it('a page left before Privy answers connects nothing, and the next page tries again', async () => {
    const privy = heldBridge();
    render(<Resume load={privy.load} />);
    await waitFor(() => expect(privy.bridge.madeWallet).toHaveBeenCalledTimes(1));
    cleanup();
    await privy.release();
    await settle();
    expect(state.connected).toEqual([]);
    render(<Resume load={privy.load} />);
    await waitFor(() => expect(state.connected).toHaveLength(1));
    // The same page load's bridge: Privy was loaded once.
    expect(privy.load).toHaveBeenCalledTimes(1);
  });

  it('waits for an unmounted page’s pending attempt before starting the next one', async () => {
    const privy = heldBridge();
    const first = render(<Resume load={privy.load} />);
    await waitFor(() => expect(privy.bridge.madeWallet).toHaveBeenCalledTimes(1));
    first.unmount();
    render(<Resume load={privy.load} />);
    await settle();
    expect(privy.bridge.madeWallet).toHaveBeenCalledTimes(1);
    expect(state.connected).toEqual([]);
    await privy.release();
    await waitFor(() => expect(state.connected).toHaveLength(1));
    expect(privy.bridge.madeWallet).toHaveBeenCalledTimes(2);
  });

  it('StrictMode’s second run takes over from the first: one connect, after Privy answers late', async () => {
    const privy = heldBridge();
    render(<StrictMode><Resume load={privy.load} /></StrictMode>);
    await waitFor(() => expect(privy.bridge.madeWallet).toHaveBeenCalled());
    await privy.release();
    await waitFor(() => expect(state.connected).toHaveLength(1));
    await settle();
    expect(state.connected).toHaveLength(1);
  });

  it('reads the memory by its kind only, and loads Privy once per page, never with the placeholder app ID', async () => {
    expect(rememberedMadeWallet({ provider: 'provided:privy', address: ADDRESS })).toBe(ADDRESS);
    expect(rememberedMadeWallet({ provider: 'window.ethereum', address: ADDRESS })).toBeNull();
    expect(rememberedMadeWallet(null)).toBeNull();
    const privy = bridgeFor();
    expect(madeWalletBridge(privy.load, null)).toBeNull();
    const first = madeWalletBridge(privy.load, 'cmtestappid00000000000000');
    expect(madeWalletBridge(privy.load, 'cmtestappid00000000000000')).toBe(first);
    expect(privy.load).toHaveBeenCalledTimes(1);
  });

  it('F166 af1: a load that failed (Privy’s code did not come) is forgotten, so the next press loads it again', async () => {
    const privy = bridgeFor();
    const failing = vi.fn(async () => { throw new Error('the chunk did not load'); });
    const lost = madeWalletBridge(failing, 'cmtestappid00000000000000');
    await expect(lost).rejects.toThrow('the chunk did not load');
    const next = madeWalletBridge(privy.load, 'cmtestappid00000000000000');
    expect(next).not.toBe(lost);
    await expect(next).resolves.toBe(privy.bridge);
    expect(madeWalletBridge(privy.load, 'cmtestappid00000000000000')).toBe(next);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(privy.load).toHaveBeenCalledTimes(1);
  });
});

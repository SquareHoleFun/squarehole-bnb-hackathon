import { act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrivyBridge } from '../alpha-sepolia/privy-bridge';

/**
 * F161 (4), SH-ALPHA-SITE: the bridge over Privy's React SDK (privy-live.tsx), with the SDK's hooks played here (the
 * browser suite runs the real SDK: e2e/alpha-access/privy-sdk.spec.mjs). XR-ALPHA-SITE af1 and af2: the sign-in waits
 * for Privy's sign-in state only; the wallet steps wait for the wallet frame only for a wallet Privy's account record
 * lists, and a record or frame that never answers is a failure, never "no wallet". Privy's own "wallets ready" never
 * comes with the alpha's config (SH-179: no external-wallet connector starts, so SDK 3.51.0 never sets it), so every case
 * but one plays it as false. SH-179 af1: "none" is asked of Privy's service again before it is said, and "Make me a
 * wallet" asks Privy for a wallet only from a render after the wallet frame answered (Privy holds the frame from then
 * on; here the wallet list's update plays that render), within a time limit.
 */
const sdk = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    privy: { ready: true, authenticated: true, user: null as unknown, getAccessToken: async () => 'access' },
    wallets: { wallets: [] as unknown[], ready: false },
    listeners,
    createWallet: (async () => ({ address: '0x0' })) as () => Promise<{ address: string }>,
    exportWallet: (async () => undefined) as (input: { address: string }) => Promise<void>,
    refreshUser: (async () => null) as () => Promise<unknown>,
  };
});
vi.mock('@privy-io/react-auth', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    PrivyProvider: ({ children }: { children: unknown }) => children,
    usePrivy: () => sdk.privy,
    useWallets: () => useSyncExternalStore((listener) => {
      sdk.listeners.add(listener);
      return () => { sdk.listeners.delete(listener); };
    }, () => sdk.wallets),
    useUser: () => ({ user: sdk.privy.user, refreshUser: () => sdk.refreshUser() }),
    useCreateWallet: () => ({ createWallet: () => sdk.createWallet() }),
    useExportWallet: () => ({ exportWallet: (input: { address: string }) => sdk.exportWallet(input) }),
    useLogout: () => ({ logout: async () => undefined }),
    useLoginWithOAuth: () => ({ initOAuth: async () => undefined, state: { status: 'initial' } }),
    getIdentityToken: async () => 'identity',
  };
});

const ADDRESS = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const X_ACCOUNT = { type: 'twitter_oauth', subject: '1', username: 'ada_builds' };
/** Privy's account record entry for the wallet it made (WalletWithMetadata). */
const MADE_ENTRY = { type: 'wallet', walletClientType: 'privy', connectorType: 'embedded', chainType: 'ethereum', walletIndex: 0, imported: false, address: ADDRESS };
/** The user as Privy's account record has it: the X account, and the made wallet when Privy made one. */
const userWith = (...wallets: unknown[]) => ({ id: 'did:privy:cmtest', linkedAccounts: [X_ACCOUNT, ...wallets] });
/** Privy's wallet list entry for a wallet (ConnectedWallet). */
const listedWallet = (walletClientType: string, provider: unknown = {}) => ({ walletClientType, address: ADDRESS, getEthereumProvider: async () => provider });
const setWallets = (wallets: unknown[], ready = false) => {
  sdk.wallets = { wallets, ready };
  for (const listener of [...sdk.listeners]) listener();
};
/** The wallet frame's answer to the SDK's ready check, as it reaches the page (a message from Privy's origin). */
const frameAnswers = (origin = 'https://auth.privy.io', data: unknown = { id: 'ready-1', event: 'privy:iframe:ready', data: {} }) => {
  window.dispatchEvent(new MessageEvent('message', { origin, data }));
};
/** Whether `promise` has settled (resolved or rejected) by now. */
const settledYet = async (promise: Promise<unknown>) => {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  await Promise.resolve();
  return settled;
};

async function mount(): Promise<PrivyBridge> {
  vi.resetModules();
  const { liveBridge } = await import('./privy-live');
  let bridge: PrivyBridge | null = null;
  await act(async () => { bridge = await liveBridge('cmtestappid00000000000000'); });
  if (!bridge) throw new Error('no bridge');
  return bridge;
}

beforeEach(() => {
  sdk.privy = { ready: true, authenticated: true, user: userWith(), getAccessToken: async () => 'access' };
  sdk.wallets = { wallets: [], ready: false };
  sdk.listeners.clear();
  sdk.createWallet = async () => ({ address: '0x0' });
  sdk.exportWallet = async () => undefined;
  sdk.refreshUser = async () => sdk.privy.user;
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  document.body.innerHTML = '';
});

describe('the bridge over Privy’s SDK (F161 (4), SH-ALPHA-SITE)', () => {
  it('signed in, with the wallet frame not ready: ready() and the identity token do not wait for it (af1)', async () => {
    const bridge = await mount();
    await expect(bridge.ready()).resolves.toBeUndefined();
    await expect(bridge.identityToken()).resolves.toBe('identity');
  });

  it('reports a readiness timeout to a silent restore that needs a definite sign-in answer', async () => {
    sdk.privy = { ...sdk.privy, ready: false, authenticated: false };
    const bridge = await mount();
    vi.useFakeTimers();
    const settled = expect(bridge.ready({ rejectOnTimeout: true })).rejects.toThrow('Privy is not ready');
    await vi.advanceTimersByTimeAsync(60_000);
    await settled;
  });

  it('Privy’s own “wallets ready” never comes (SH-179): an account with no made wallet is “no wallet” at once, asked of Privy again first', async () => {
    const refreshUser = vi.fn(async () => sdk.privy.user);
    sdk.refreshUser = refreshUser;
    const bridge = await mount();
    vi.useFakeTimers();
    const asked = bridge.madeWallet();
    // No wait: nothing of the wallet frame's is needed to say so (before SH-179 this took the full minute and failed).
    await vi.advanceTimersByTimeAsync(0);
    await expect(asked).resolves.toBeNull();
    expect(refreshUser).toHaveBeenCalledTimes(1);
  });

  it('the record the page loaded predates a wallet made since: asked again, the made wallet, never “no wallet” (SH-179 af1)', async () => {
    const provider = { request: vi.fn() };
    sdk.refreshUser = async () => userWith(MADE_ENTRY);
    sdk.wallets = { wallets: [listedWallet('privy', provider)], ready: false };
    const bridge = await mount();
    await expect(bridge.madeWallet()).resolves.toEqual({ address: ADDRESS, provider });
  });

  it('Privy’s service cannot be asked again: madeWallet() fails, it never says “no wallet” (af2, SH-179 af1)', async () => {
    sdk.refreshUser = async () => { throw new Error('network'); };
    const failing = await mount();
    await expect(failing.madeWallet()).rejects.toThrow('network');
    cleanup();
    document.body.innerHTML = '';
    sdk.refreshUser = async () => null;
    const empty = await mount();
    await expect(empty.madeWallet()).rejects.toThrow('Privy’s wallets did not load');
    cleanup();
    document.body.innerHTML = '';
    sdk.refreshUser = () => new Promise(() => undefined);
    const silent = await mount();
    vi.useFakeTimers();
    const asked = silent.madeWallet();
    const settled = expect(asked).rejects.toThrow('Privy’s wallets did not load');
    await vi.advanceTimersByTimeAsync(60_000);
    await settled;
  });

  it('a made wallet the wallet frame lists late: madeWallet() waits for it and gives it (af2: the wait is real)', async () => {
    const provider = { request: vi.fn() };
    sdk.privy = { ...sdk.privy, user: userWith(MADE_ENTRY) };
    const bridge = await mount();
    vi.useFakeTimers();
    const asked = bridge.madeWallet();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await settledYet(asked)).toBe(false);
    await act(async () => { setWallets([listedWallet('privy', provider)]); });
    await expect(asked).resolves.toEqual({ address: ADDRESS, provider });
  });

  it('a made wallet the wallet frame never lists: madeWallet() fails only after its minute, it never says “no wallet” (af2)', async () => {
    sdk.privy = { ...sdk.privy, user: userWith(MADE_ENTRY) };
    const bridge = await mount();
    vi.useFakeTimers();
    const asked = bridge.madeWallet();
    const settled = expect(asked).rejects.toThrow('Privy’s wallets did not load');
    await vi.advanceTimersByTimeAsync(59_000);
    expect(await settledYet(asked)).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
  });

  it('an account record that never loads: madeWallet() fails after its wait, it never says “no wallet” (af2)', async () => {
    sdk.privy = { ...sdk.privy, user: null };
    const bridge = await mount();
    vi.useFakeTimers();
    const asked = bridge.madeWallet();
    const settled = expect(asked).rejects.toThrow('Privy’s wallets did not load');
    await vi.advanceTimersByTimeAsync(60_000);
    await settled;
  });

  it('Privy never gets ready: madeWallet() fails after its wait, it never says “no wallet” (af2)', async () => {
    sdk.privy = { ...sdk.privy, ready: false };
    const bridge = await mount();
    vi.useFakeTimers();
    const asked = bridge.madeWallet();
    const settled = expect(asked).rejects.toThrow('Privy’s wallets did not load');
    await vi.advanceTimersByTimeAsync(60_000);
    await settled;
  });

  it('the made wallet listed: madeWallet() gives it with its provider, without Privy’s “wallets ready”', async () => {
    const provider = { request: vi.fn() };
    sdk.privy = { ...sdk.privy, user: userWith(MADE_ENTRY) };
    sdk.wallets = { wallets: [listedWallet('metamask'), listedWallet('privy', provider)], ready: false };
    const bridge = await mount();
    await expect(bridge.madeWallet()).resolves.toEqual({ address: ADDRESS, provider });
  });

  it('a browser wallet only, in the list and on the account: still “no wallet” (only Privy’s made wallet counts)', async () => {
    sdk.privy = { ...sdk.privy, user: userWith({ ...MADE_ENTRY, walletClientType: 'metamask', connectorType: 'injected' }) };
    sdk.wallets = { wallets: [listedWallet('metamask')], ready: true };
    const bridge = await mount();
    await expect(bridge.madeWallet()).resolves.toBeNull();
  });

  it('“Make me a wallet” with none made: Privy is asked only from a render after the wallet frame answered, and the bridge gives the wallet once listed (SH-179 af1)', async () => {
    const provider = { request: vi.fn() };
    const createWallet = vi.fn(async () => ({ address: ADDRESS }));
    sdk.createWallet = createWallet;
    const bridge = await mount();
    const making = bridge.makeWallet();
    await act(async () => { await Promise.resolve(); });
    // Another origin's message, or the frame's refusal, is not the answer, even with a render after it.
    frameAnswers('https://evil.example');
    frameAnswers('https://auth.privy.io', { id: 'ready-0', event: 'privy:iframe:ready', error: { type: 'x', message: 'no' } });
    await act(async () => { setWallets([]); });
    expect(createWallet).not.toHaveBeenCalled();
    // The answer alone is not enough: Privy holds the frame only from its next render on (review wf_60067ecf-965).
    frameAnswers();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(createWallet).not.toHaveBeenCalled();
    // Privy's render with the frame (played here by the wallet list's update): now Privy is asked.
    await act(async () => { setWallets([]); });
    await vi.waitFor(() => expect(createWallet).toHaveBeenCalledTimes(1));
    await act(async () => {
      sdk.privy = { ...sdk.privy, user: userWith(MADE_ENTRY) };
      setWallets([listedWallet('privy', provider)]);
    });
    await expect(making).resolves.toEqual({ address: ADDRESS, provider });
  });

  it('the wallet frame never answers: “Make me a wallet” fails after its minute and never asks Privy for a wallet (SH-179 af1)', async () => {
    const createWallet = vi.fn(async () => ({ address: ADDRESS }));
    sdk.createWallet = createWallet;
    const bridge = await mount();
    vi.useFakeTimers();
    const making = bridge.makeWallet();
    const settled = expect(making).rejects.toThrow('Privy’s wallet frame did not load');
    await vi.advanceTimersByTimeAsync(60_000);
    await settled;
    expect(createWallet).not.toHaveBeenCalled();
  });

  it('Privy never finishes making the wallet: “Make me a wallet” fails after its time limit (SH-179 af1)', async () => {
    sdk.createWallet = () => new Promise(() => undefined);
    const bridge = await mount();
    frameAnswers();
    await act(async () => { setWallets([]); });
    vi.useFakeTimers();
    const making = bridge.makeWallet();
    const settled = expect(making).rejects.toThrow('Privy made no wallet');
    await vi.advanceTimersByTimeAsync(60_000);
    await settled;
  });

  it('“Make me a wallet” with one made: the made one, and Privy is not asked to make another', async () => {
    const provider = { request: vi.fn() };
    const createWallet = vi.fn(async () => ({ address: ADDRESS }));
    sdk.createWallet = createWallet;
    sdk.privy = { ...sdk.privy, user: userWith(MADE_ENTRY) };
    sdk.wallets = { wallets: [listedWallet('privy', provider)], ready: false };
    const bridge = await mount();
    await expect(bridge.makeWallet()).resolves.toEqual({ address: ADDRESS, provider });
    expect(createWallet).not.toHaveBeenCalled();
  });

  it('export: Privy’s export window for the made wallet’s address; with none made, no window', async () => {
    const exportWallet = vi.fn(async () => undefined);
    sdk.exportWallet = exportWallet;
    const none = await mount();
    await expect(none.exportWallet()).rejects.toThrow('Privy made no wallet for this account');
    expect(exportWallet).not.toHaveBeenCalled();
    cleanup();
    document.body.innerHTML = '';
    sdk.privy = { ...sdk.privy, user: userWith(MADE_ENTRY) };
    sdk.wallets = { wallets: [listedWallet('privy')], ready: false };
    const made = await mount();
    await expect(made.exportWallet()).resolves.toBeUndefined();
    expect(exportWallet).toHaveBeenCalledWith({ address: ADDRESS });
  });

  it('a sign-out while Privy never got ready fails after its wait, so the join page can say Privy’s sign-in may still be on (af2)', async () => {
    sdk.privy = { ...sdk.privy, ready: false };
    const bridge = await mount();
    vi.useFakeTimers();
    const asked = bridge.signOut();
    const settled = expect(asked).rejects.toThrow('Privy is not ready');
    await vi.advanceTimersByTimeAsync(60_000);
    await settled;
  });

  it('signed out: madeWallet() needs no wallet frame and finds none', async () => {
    const refreshUser = vi.fn(async () => null);
    sdk.refreshUser = refreshUser;
    sdk.privy = { ready: true, authenticated: false, user: null, getAccessToken: async () => 'access' };
    const bridge = await mount();
    await expect(bridge.madeWallet()).resolves.toBeNull();
    expect(refreshUser).not.toHaveBeenCalled();
  });
});

describe('SH-275: the made wallet’s chain follows the test network', () => {
  it('Sepolia keeps viem’s own chain; BNB Chain testnet gets chain 97 from its profile, the profile’s endpoints, tBNB', async () => {
    const { TESTNET_PROFILES } = await import('@squarehole/chain/write/wallet');
    const { sepolia } = await import('viem/chains');
    const { PRIVY_CLIENT_CONFIG, privyClientConfigOf } = await import('./privy-live');
    expect(PRIVY_CLIENT_CONFIG.defaultChain).toBe(sepolia);
    expect(PRIVY_CLIENT_CONFIG.supportedChains).toEqual([sepolia]);
    const bnb = privyClientConfigOf(TESTNET_PROFILES.bnb);
    const chain = bnb.defaultChain;
    expect(bnb.supportedChains).toEqual([chain]);
    expect([chain?.id, chain?.name, chain?.nativeCurrency, chain?.rpcUrls.default.http, chain?.blockExplorers?.default.url]).toEqual([
      97, 'BNB Chain Testnet', { name: 'BNB', symbol: 'tBNB', decimals: 18 }, [...TESTNET_PROFILES.bnb.publicRpcUrls], 'https://testnet.bscscan.com',
    ]);
    // Every other setting is Sepolia's, unchanged.
    expect({ ...bnb, defaultChain: null, supportedChains: null }).toEqual({ ...PRIVY_CLIENT_CONFIG, defaultChain: null, supportedChains: null });
  });
});


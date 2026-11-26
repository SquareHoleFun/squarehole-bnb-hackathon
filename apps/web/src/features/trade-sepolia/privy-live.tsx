/**
 * F161 (4), SH-ALPHA-SITE: Privy's React SDK behind the alpha's small bridge (features/alpha-sepolia/privy-bridge.ts).
 * This module and everything only it pulls in (`@privy-io/*` and its own dependencies) is trade code for
 * `pnpm check:production`: never in a mainnet build, and only in lazily loaded chunks of a Sepolia build (the join
 * page's sign-in, the Claim card's made wallet). docs/design/alpha-access-privy.md § 5 is the plan:
 * - X is the only login method, on Privy's own X keys (`initOAuth({ provider: 'twitter' })`, a full-page redirect to X
 *   and back to the same address; Privy finishes the sign-in itself on that page).
 * - No wallet is made at sign-in (`createOnLogin: 'off'`); "Make me a wallet" makes one. Privy's own wallet windows are
 *   off (`showWalletUIs: false`): our page's press is the one confirmation, and it signs exactly what the page shows.
 *   Privy's external-wallet list is off as well: browser wallets stay on our own EIP-6963 path.
 * - Privy's cookie mirror of its tokens is off (`cookieWriteBehavior: 'never'`): its tokens stay in this browser's
 *   local storage and are never sent to our server; our server sets its own sign-in cookie.
 * - Export opens Privy's own window, the only Privy screen the alpha shows.
 * One hidden React root holds the provider for the page's whole life, so the made wallet keeps working from page to
 * page; a module-level snapshot hands its state to the bridge's plain functions.
 */
import {
  PrivyProvider,
  getIdentityToken,
  useCreateWallet,
  useExportWallet,
  useLoginWithOAuth,
  useLogout,
  usePrivy,
  useUser,
  useWallets,
  type ConnectedWallet,
  type PrivyClientConfig,
  type User,
  type WalletWithMetadata,
} from '@privy-io/react-auth';
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { defineChain, type Chain } from 'viem';
import { sepolia } from 'viem/chains';
import { TESTNET, type Eip1193Provider, type TestnetProfile } from '@squarehole/chain/write/wallet';
import type { MadeWallet, PrivyBridge } from '../alpha-sepolia/privy-bridge';

/**
 * SH-275: the chain the made wallet lives on: Sepolia as viem names it (as before), or another test network from its
 * profile (BNB Chain testnet: chain 97, tBNB, the profile's own read endpoints and explorer), so Privy's wallet answers
 * that chain and broadcasts there. The site's sends reach it through the wallet context like any wallet's, so each one
 * passes the chain package's send rules first (packages/chain/src/write/executor.ts: the gas price read right before,
 * both fee fields, the ceiling).
 */
export function privyChainOf(profile: TestnetProfile): Chain {
  if (profile.name === 'sepolia') return sepolia;
  const [explorer] = profile.explorers;
  return defineChain({
    id: profile.chainId,
    name: profile.networkName,
    nativeCurrency: { name: profile.coin.name, symbol: profile.coin.walletSymbol, decimals: 18 },
    rpcUrls: { default: { http: [...profile.publicRpcUrls] } },
    ...(explorer ? { blockExplorers: { default: { name: explorer.name, url: explorer.origin } } } : {}),
    testnet: true,
  });
}

/** The client settings for a test network (they override the dashboard's where both set one). */
export function privyClientConfigOf(profile: TestnetProfile): PrivyClientConfig {
  const chain = privyChainOf(profile);
  return Object.freeze({
    loginMethods: ['twitter'],
    appearance: { theme: 'dark', walletChainType: 'ethereum-only' },
    embeddedWallets: { ethereum: { createOnLogin: 'off' }, showWalletUIs: false },
    externalWallets: { walletConnect: { enabled: false }, disableAllExternalWallets: true },
    defaultChain: chain,
    supportedChains: [chain],
    sessions: { cookieWriteBehavior: 'never' },
  }) as PrivyClientConfig;
}

/** This build's client settings. */
export const PRIVY_CLIENT_CONFIG: PrivyClientConfig = privyClientConfigOf(TESTNET);

/** How long a sign-in X sent back may take Privy to finish before the page says it did not work. */
export const FINISH_TIMEOUT_MS = 60_000;

/** Privy's service, and the origin its wallet frame answers this page from (the SDK's default; the CSP names it). */
const PRIVY_ORIGIN = 'https://auth.privy.io';

interface Snapshot {
  readonly ready: boolean;
  readonly authenticated: boolean;
  /** Privy's account record for the signed-in user has loaded (false while signed out). */
  readonly userLoaded: boolean;
  /** The Ethereum wallet Privy made for this account, as its account record lists it, or null. */
  readonly madeAddress: string | null;
  readonly wallets: readonly ConnectedWallet[];
  /** The OAuth flow's state: 'initial', 'loading', 'done' or 'error'. */
  readonly login: string;
  readonly initOAuth: (input: { provider: 'twitter' }) => Promise<void>;
  readonly createWallet: () => Promise<{ address: string }>;
  readonly exportWallet: (input: { address: string }) => Promise<void>;
  readonly logout: () => Promise<void>;
  readonly getAccessToken: () => Promise<string | null>;
  /** Asks Privy's service for the account record again; null when Privy has none to give. */
  readonly refreshUser: () => Promise<User | null>;
  /** Rendered after Privy's wallet frame answered this page, so Privy's own functions here hold the frame. */
  readonly frameSeen: boolean;
}

let snapshot: Snapshot | null = null;
const listeners = new Set<() => void>();
const publish = (next: Snapshot) => {
  snapshot = next;
  for (const listener of [...listeners]) listener();
};

/** The first snapshot that meets `test`, or null after `ms`. */
function waitFor(test: (current: Snapshot) => boolean, ms: number): Promise<Snapshot | null> {
  return new Promise((resolve) => {
    const check = () => {
      if (snapshot && test(snapshot)) {
        clearTimeout(timer);
        listeners.delete(check);
        resolve(snapshot);
      }
    };
    const timer = setTimeout(() => { listeners.delete(check); resolve(null); }, ms);
    listeners.add(check);
    check();
  });
}

/**
 * The Ethereum wallet Privy made for this account, as Privy's account record lists it (by Privy's own filter for the
 * wallets it lists, the first by its index), or null.
 */
function madeAddressOf(user: User | null): string | null {
  const made = (user?.linkedAccounts ?? []).filter((account): account is WalletWithMetadata =>
    account.type === 'wallet' && account.walletClientType === 'privy' && account.chainType === 'ethereum' && account.walletIndex !== null);
  made.sort((a, b) => (a.walletIndex ?? 0) - (b.walletIndex ?? 0));
  return made[0]?.address ?? null;
}

function Bridge() {
  const privy = usePrivy();
  const { wallets } = useWallets();
  const { createWallet } = useCreateWallet();
  const { exportWallet } = useExportWallet();
  const { logout } = useLogout();
  const { initOAuth, state } = useLoginWithOAuth();
  const { refreshUser } = useUser();
  // Read while rendering: Privy keeps the frame in a state update the frame's answer makes, so a render after the
  // answer is a render with it (Privy's functions are this render's).
  const frameSeen = frameAnswered;
  useEffect(() => {
    publish({
      ready: privy.ready,
      authenticated: privy.authenticated,
      userLoaded: privy.authenticated && privy.user !== null,
      madeAddress: madeAddressOf(privy.user),
      wallets,
      login: state.status,
      initOAuth: (input) => initOAuth(input),
      createWallet: async () => createWallet(),
      exportWallet: (input) => exportWallet(input),
      logout: () => logout(),
      getAccessToken: () => privy.getAccessToken(),
      refreshUser: async () => (await refreshUser()) ?? null,
      frameSeen,
    });
  }, [privy, wallets, state.status, initOAuth, createWallet, exportWallet, logout, refreshUser, frameSeen]);
  return null;
}

const isMade = (wallet: ConnectedWallet): boolean => wallet.walletClientType === 'privy';

/** `promise`, or a rejection with `message` once `ms` have passed. */
function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

async function made(wallet: ConnectedWallet): Promise<MadeWallet> {
  const provider = await wallet.getEthereumProvider() as unknown as Eip1193Provider;
  return Object.freeze({ address: wallet.address as `0x${string}`, provider });
}

let mounted: Promise<PrivyBridge> | null = null;
/** Whether Privy's wallet frame has answered the SDK's ready check on this page (set once, never cleared: Privy keeps it). */
let frameAnswered = false;

/** The bridge over Privy's SDK, mounted once per page (a second call gets the same one). */
export function liveBridge(appId: string): Promise<PrivyBridge> {
  mounted ??= (async () => {
    const host = document.createElement('div');
    host.dataset.shPrivy = '';
    document.body.append(host);
    // The wallet frame's answer to the SDK's ready check, a message from Privy's origin to this page, heard from before
    // the frame exists (SH-179 af1). Privy asked for a wallet before it holds the frame waits 30 s for it, then opens
    // its own "Creating your wallet" screen, so "Make me a wallet" waits for a render after this answer (`frameSeen`).
    window.addEventListener('message', (event: MessageEvent) => {
      const data: unknown = event.data;
      if (frameAnswered || event.origin !== PRIVY_ORIGIN || typeof data !== 'object' || data === null) return;
      const message = data as { event?: unknown; error?: unknown };
      if (message.event === 'privy:iframe:ready' && !message.error) frameAnswered = true;
    });
    createRoot(host).render(<PrivyProvider appId={appId} config={PRIVY_CLIENT_CONFIG}><Bridge /></PrivyProvider>);
    const current = (): Snapshot => {
      if (!snapshot) throw new Error('Privy is not ready');
      return snapshot;
    };
    // Privy's own "wallets ready" (`useWallets().ready`) never comes with this config: SDK 3.51.0 sets it only after one
    // of its external-wallet connectors reports, and with those off (`disableAllExternalWallets`) none starts. That is
    // the minute the alpha-access suite's run of the real SDK once saw a sign-in held, and the minute every "Make me a
    // wallet" and "Export wallet key" press waited before it failed (ship 12). So Privy's account record says whether
    // it made a wallet, and only a made wallet waits, for Privy's wallet frame to list it.
    const listedWallet = async (address: string): Promise<ConnectedWallet | null> => {
      const find = (s: Snapshot) => s.wallets.find((w) => isMade(w) && w.address.toLowerCase() === address.toLowerCase());
      const listed = await waitFor((s) => find(s) !== undefined, FINISH_TIMEOUT_MS);
      return (listed && find(listed)) ?? null;
    };
    const bridge: PrivyBridge = {
      async ready(options) {
        const ready = await waitFor((s) => s.ready, FINISH_TIMEOUT_MS);
        if (!ready && options?.rejectOnTimeout) throw new Error('Privy is not ready');
      },
      authenticated: () => snapshot?.authenticated === true,
      async signIn() {
        await bridge.ready();
        await current().initOAuth({ provider: 'twitter' });
      },
      async finishSignIn() {
        const done = await waitFor((s) => s.ready && (s.login === 'done' || s.login === 'error' || s.authenticated), FINISH_TIMEOUT_MS);
        if (!done || !done.authenticated) return null;
        return bridge.identityToken();
      },
      async identityToken() {
        await bridge.ready();
        if (!current().authenticated) return null;
        // An access token renewed when it expired renews the identity token with it (Privy's sessions).
        await current().getAccessToken();
        return (await getIdentityToken()) ?? null;
      },
      async signOut() {
        // Privy that never got ready has not signed out (XR-ALPHA-SITE af2): the caller says so.
        if ((await waitFor((s) => s.ready, FINISH_TIMEOUT_MS)) === null) throw new Error('Privy is not ready');
        if (current().authenticated) await current().logout();
      },
      async madeWallet() {
        // An account record that never loaded or could not be asked again, or a made wallet the wallet frame never
        // lists, is not "no wallet" (XR-ALPHA-SITE af2): the caller says it did not open.
        const known = await waitFor((s) => s.ready && (!s.authenticated || s.userLoaded), FINISH_TIMEOUT_MS);
        if (known === null) throw new Error('Privy’s wallets did not load');
        if (!known.authenticated) return null;
        let address = known.madeAddress;
        if (address === null) {
          // The record came with the page and can predate a wallet made since (another tab): "none" is asked again.
          const fresh = await within(current().refreshUser(), FINISH_TIMEOUT_MS, 'Privy’s wallets did not load');
          if (fresh === null) throw new Error('Privy’s wallets did not load');
          address = madeAddressOf(fresh);
          if (address === null) return null;
        }
        const wallet = await listedWallet(address);
        if (!wallet) throw new Error('Privy’s wallets did not load');
        return made(wallet);
      },
      async makeWallet() {
        const existing = await bridge.madeWallet();
        if (existing) return existing;
        // A snapshot rendered after the frame answered: Privy's createWallet from an earlier render would wait for the
        // frame 30 s and open Privy's own screen (review wf_60067ecf-965).
        if ((await waitFor((s) => s.frameSeen, FINISH_TIMEOUT_MS)) === null) throw new Error('Privy’s wallet frame did not load');
        // A time limit as well: a wallet Privy never finishes making is a failure the person can try again.
        const { address } = await within(current().createWallet(), FINISH_TIMEOUT_MS, 'Privy made no wallet');
        const wallet = await listedWallet(address);
        if (!wallet) throw new Error('Privy made no wallet');
        return made(wallet);
      },
      async exportWallet() {
        const wallet = await bridge.madeWallet();
        if (!wallet) throw new Error('Privy made no wallet for this account');
        await current().exportWallet({ address: wallet.address });
      },
    };
    return bridge;
  })();
  return mounted;
}

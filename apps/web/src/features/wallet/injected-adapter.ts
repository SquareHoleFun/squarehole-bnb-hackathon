/**
 * Injected (browser) wallet adapter (Stage C; UI-09). Implements `WalletAdapter` over `InjectedWalletSession` from
 * `@squarehole/chain/write`:
 * - Nothing on load. `discover()` (called when the person opens the browser-wallet window) lists EIP-6963 wallets.
 * - `connect({ walletId })` (the person's Connect click) connects the picked wallet. `window.ethereum` is read only when
 *   the person explicitly picks "Browser wallet" (`BROWSER_WALLET_ID`); it is never probed otherwise.
 * - Account and chain changes arrive as the wallet's EIP-1193 events; `disconnect` forgets the wallet (and asks it to
 *   revoke the permission where supported). "Last used wallet" is remembered per browser as a hint only: connecting
 *   still needs a click.
 * - F135 (founder 2026-10-11: a refresh keeps the wallet connected): a connect is remembered on this device (the wallet
 *   and the address, `REMEMBERED_KEY`). `resume()`, on load, then looks for that one wallet and asks it `eth_accounts`
 *   (and `eth_chainId`), which never opens a wallet window; if the remembered address is still authorised and active,
 *   the visitor is connected again. Never `eth_requestAccounts` or any other prompting method. Disconnect, or a wallet
 *   that shares accounts but no longer the remembered one, forgets it; a locked wallet (no account shared) keeps it for
 *   a later load. Without the memory, `resume()` touches nothing: no discovery, no `window.ethereum`.
 */
import {
  InjectedWalletError,
  InjectedWalletSession,
  discoverWallets,
  parseAccounts,
  type DiscoveredWallet,
  type InjectedConnection,
  type Eip1193Provider,
  type Eip1193Request,
} from '@squarehole/chain/write/wallet';
import { isChainId, sameAddress, type Address } from '@squarehole/domain';
import { WalletError, type WalletAdapter, type WalletConnection } from './wallet-adapter';

export const BROWSER_WALLET_ID = 'browser';
const LAST_WALLET_KEY = 'sh.wallet.last-rdns';
/** F135: the browser wallet this device connected and its address, so a refresh can reconnect without a click. */
export const REMEMBERED_KEY = 'sh.wallet.connected.v1';
/** The remembered provider of `window.ethereum` ("Browser wallet"); an announced wallet is `eip6963:<its rdns>`. */
const WINDOW_ETHEREUM = 'window.ethereum';
const EIP6963_PREFIX = 'eip6963:';
const RDNS = /^[a-z0-9](?:[a-z0-9-]{0,62})(?:\.[a-z0-9](?:[a-z0-9-]{0,62}))+$/;
/**
 * F161 (4), SH-ALPHA-SITE: a wallet the page itself holds (the Sepolia alpha's wallet Privy made, whose EIP-1193
 * provider the trade folder hands over), remembered as `provided:<id>`. Only builds with the trade literal know the
 * kind: everywhere else this code and the memory's kind fold away.
 */
const SEPOLIA_TRADE = import.meta.env?.SH_SEPOLIA_TRADE === true;
const PROVIDED_PREFIX = 'provided:';
const PROVIDED_ID = /^[a-z][a-z0-9-]{0,31}$/;
/** How long a remembered EIP-6963 wallet may take to announce itself on load before the page stays disconnected. */
const RESUME_DISCOVERY_MS = 1500;

/** What a connect leaves on this device (F135): which wallet, by a provider id that survives a reload, and the address. */
export interface RememberedWallet {
  /** `eip6963:<rdns>` (an announcement's uuid changes with every page load) or `window.ethereum`. */
  readonly provider: string;
  readonly address: Address;
}

type WalletStorage = Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>;

export interface BrowserWalletOption {
  readonly id: string;
  readonly name: string;
  /** Safe `data:image/…` URI or null. */
  readonly icon: string | null;
  readonly rdns: string;
  /** This browser connected this wallet last time (a hint; nothing connects without a click). */
  readonly lastUsed: boolean;
}

/** F161 (4): a wallet the page holds itself, by its EIP-1193 provider (see `connectProvider`). */
export interface ProvidedWallet {
  /** Short and fixed (`privy`): remembered as `provided:<id>`. */
  readonly id: string;
  /** What the wallet window and the top bar show. */
  readonly name: string;
  readonly provider: Eip1193Provider;
  /**
   * A reconnect on load (F135's rule): only if the provider already shares `address` through `eth_accounts`, and never
   * an account request to it.
   */
  readonly resume?: { readonly address: Address };
}

export interface InjectedWalletAdapter extends WalletAdapter {
  readonly kind: 'injected';
  /**
   * F161 (4), Sepolia trade builds only (null elsewhere): connects a wallet the page holds itself, as a press on a
   * listed wallet connects one; its signing needs no window of its own (the page's press is the confirmation).
   */
  readonly connectProvider: ((wallet: ProvidedWallet) => Promise<WalletConnection>) | null;
  /** Starts EIP-6963 discovery (the chooser window); returns a function that stops it. */
  discover(onChange: (wallets: readonly BrowserWalletOption[]) => void): () => void;
  /**
   * F135, on load: reconnects the remembered wallet if it still shares the remembered address, asking it only
   * `eth_accounts` and `eth_chainId`. Null (and nothing touched) without a memory; null when the wallet is not found,
   * fails or no longer shares the address (then the memory is forgotten). A connect or disconnect meanwhile wins.
   */
  resume(): Promise<WalletConnection | null>;
  /**
   * The provider that used this adapter is gone (a data-source switch re-keys the app): stop any resume and let go of
   * the session's listeners, without asking the wallet anything and without forgetting the memory.
   */
  release(): void;
  /**
   * The connected wallet's EIP-1193 request function for the chain executor, or null. `confirmsInPage`: a wallet the
   * page holds itself (F161 (4)), which opens no window: the page's own press is the one confirmation.
   */
  readonly signer: { readonly request: Eip1193Request; readonly walletName: string; readonly confirmsInPage?: true } | null;
}

export interface InjectedWalletAdapterOptions {
  /** Where EIP-6963 events and `window.ethereum` live (tests pass a fake). */
  readonly target?: Window | (EventTarget & { ethereum?: unknown });
  /** RPC URL the wallet is given when it adds the local anvil chain. */
  readonly localRpcUrl?: string;
  readonly storage?: WalletStorage | null;
}

function readLast(storage: Pick<Storage, 'getItem'> | null): string | null {
  try {
    return storage?.getItem(LAST_WALLET_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeLast(storage: Pick<Storage, 'setItem'> | null, rdns: string | null): void {
  try {
    if (rdns) storage?.setItem(LAST_WALLET_KEY, rdns);
  } catch {
    // Storage unavailable (private window, blocked site data): the hint is simply not kept.
  }
}

/** The remembered wallet, or null when there is none or it is not well formed (it is never trusted as more). */
export function readRemembered(storage: Pick<Storage, 'getItem'> | null): RememberedWallet | null {
  let raw: string | null;
  try {
    raw = storage?.getItem(REMEMBERED_KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { provider, address } = value as { provider?: unknown; address?: unknown };
  if (typeof provider !== 'string' || !(provider === WINDOW_ETHEREUM || (provider.startsWith(EIP6963_PREFIX) && RDNS.test(provider.slice(EIP6963_PREFIX.length)))
    || (SEPOLIA_TRADE && provider.startsWith(PROVIDED_PREFIX) && PROVIDED_ID.test(provider.slice(PROVIDED_PREFIX.length))))) return null;
  const [account] = parseAccounts([address]);
  return account === undefined ? null : Object.freeze({ provider, address: account });
}

/** The wallet this browser remembers (F135), read from its own local storage; null when none or unreadable. */
export function rememberedHere(): RememberedWallet | null {
  try {
    return readRemembered(window.localStorage);
  } catch {
    return null;
  }
}

function writeRemembered(storage: WalletStorage | null, value: RememberedWallet | null): void {
  try {
    if (value) storage?.setItem(REMEMBERED_KEY, JSON.stringify(value));
    else if (storage?.removeItem) storage.removeItem(REMEMBERED_KEY);
    else storage?.setItem(REMEMBERED_KEY, '');
  } catch {
    // Storage unavailable: nothing is remembered, so a refresh simply starts disconnected.
  }
}

/**
 * The wallet as a resumed session sees it (F135). `InjectedWalletSession.connect()` starts with `eth_requestAccounts`;
 * while the session resumes, that request is answered here with the accounts the wallet already shared through
 * `eth_accounts`, `eth_chainId` goes to the wallet (it never opens a window), and any other method is refused without
 * reaching the wallet, so a later change to `connect()` cannot make a resume prompt. Once the session is adopted
 * (`live()`), every request goes to the wallet unchanged.
 */
function resumedProvider(provider: Eip1193Provider, accounts: readonly Address[]): { readonly provider: Eip1193Provider; readonly live: () => void } {
  let resuming = true;
  const wrapped: Eip1193Provider = {
    request: (args) => {
      if (!resuming) return provider.request(args);
      if (args.method === 'eth_requestAccounts') return Promise.resolve([...accounts]);
      if (args.method === 'eth_chainId') return provider.request(args);
      return Promise.reject(new InjectedWalletError('wallet_error', `A silent reconnect does not ask the wallet ${args.method}.`));
    },
  };
  if (typeof provider.on === 'function') wrapped.on = (event, listener) => provider.on?.(event, listener);
  if (typeof provider.removeListener === 'function') wrapped.removeListener = (event, listener) => provider.removeListener?.(event, listener);
  return Object.freeze({ provider: wrapped, live: () => { resuming = false; } });
}

function asWalletError(error: unknown): WalletError {
  if (error instanceof WalletError) return error;
  if (error instanceof InjectedWalletError) {
    const code = error.code === 'rejected' ? 'rejected' : error.code === 'unsupported_chain' ? 'invalid_chain' : error.code === 'not_connected' ? 'not_connected' : 'wallet_error';
    return new WalletError(code, error.message);
  }
  return new WalletError('wallet_error', error instanceof Error ? error.message : 'The wallet request failed');
}

export function createInjectedWalletAdapter(options: InjectedWalletAdapterOptions = {}): InjectedWalletAdapter {
  const target = () => options.target ?? window;
  const storage = (): WalletStorage | null => {
    if (options.storage !== undefined) return options.storage;
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  };
  const accountListeners = new Set<(accounts: readonly Address[]) => void>();
  const chainListeners = new Set<(chainId: number) => void>();
  const discovered = new Map<string, DiscoveredWallet>();
  let session: InjectedWalletSession | null = null;
  let current: WalletConnection | null = null;
  let detach: (() => void)[] = [];
  // Bumped by every connect and disconnect: a resume that started before one of them gives way to it.
  let generation = 0;
  let resuming: Promise<WalletConnection | null> | null = null;

  const emitAccounts = (accounts: readonly Address[]) => accountListeners.forEach((listener) => listener(accounts));
  const emitChain = (chainId: number) => chainListeners.forEach((listener) => listener(chainId));

  function drop(): void {
    detach.forEach((off) => off());
    detach = [];
    session = null;
    current = null;
  }

  /** The connected session from now on: its events, and the memory a refresh reconnects from (F135). */
  function adopt(next: InjectedWalletSession, connection: InjectedConnection, rememberAs: string, walletName: string): WalletConnection {
    session = next;
    current = Object.freeze({ account: connection.account, chainId: connection.chainId, personaId: null, walletName });
    detach = [
      next.onAccountsChanged((accounts) => {
        if (session !== next) return;
        const account = accounts[0];
        if (account === undefined) {
          // The wallet stopped sharing an account (it locked, or the site was disconnected in it): shown disconnected.
          // The memory stays, so a later load reconnects once the wallet shares the address again; Disconnect forgets it.
          drop();
        } else {
          if (current) current = Object.freeze({ ...current, account });
          writeRemembered(storage(), { provider: rememberAs, address: account });
        }
        emitAccounts(accounts);
      }),
      next.onChainChanged((chainId) => {
        if (session !== next) return;
        if (current) current = Object.freeze({ ...current, chainId });
        emitChain(chainId);
      }),
      next.onDisconnect(() => {
        if (session !== next) return;
        // The wallet lost its connection (EIP-1193 `disconnect`): shown disconnected; the memory stays for a refresh.
        drop();
        emitAccounts([]);
      }),
    ];
    writeRemembered(storage(), { provider: rememberAs, address: connection.account });
    return current;
  }

  /** A remembered EIP-6963 wallet, found by its rdns among this page's announcements, or null after a short wait. */
  function announced(rdns: string): Promise<DiscoveredWallet | null> {
    return new Promise((resolve) => {
      let done = false;
      let stop: (() => void) | null = null;
      const finish = (wallet: DiscoveredWallet | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        stop?.();
        resolve(wallet);
      };
      const timer = setTimeout(() => finish(null), RESUME_DISCOVERY_MS);
      stop = discoverWallets(target(), (wallets) => {
        wallets.forEach((wallet) => discovered.set(wallet.id, wallet));
        const match = wallets.find((wallet) => wallet.rdns === rdns);
        if (match) finish(match);
      });
      // A wallet that announced while discovery started has already finished it: stop listening now.
      if (done) stop();
    });
  }

  /** The provider a remembered wallet stands for on this page: `window.ethereum`, or an announced wallet by rdns. */
  async function rememberedProvider(remembered: RememberedWallet): Promise<{ provider: Eip1193Provider; id: string; name: string; rdns: string | null; source: 'eip6963' | 'window_ethereum' } | null> {
    // F161 (4): a wallet the page holds itself comes back only through its owner (`connectProvider` with `resume`).
    if (SEPOLIA_TRADE && remembered.provider.startsWith(PROVIDED_PREFIX)) return null;
    if (remembered.provider === WINDOW_ETHEREUM) {
      // Read only because this device connected "Browser wallet" before (F135); never probed otherwise.
      const injected = (target() as { ethereum?: unknown }).ethereum;
      if (typeof injected !== 'object' || injected === null || typeof (injected as { request?: unknown }).request !== 'function') return null;
      return { provider: injected as Eip1193Provider, id: BROWSER_WALLET_ID, name: 'Browser wallet', rdns: null, source: 'window_ethereum' };
    }
    const wallet = await announced(remembered.provider.slice(EIP6963_PREFIX.length));
    return wallet ? { provider: wallet.provider, id: wallet.id, name: wallet.name, rdns: wallet.rdns, source: 'eip6963' } : null;
  }

  async function resumeRemembered(remembered: RememberedWallet, started: number): Promise<WalletConnection | null> {
    const found = await rememberedProvider(remembered);
    if (found === null || started !== generation) return null;
    let accounts: Address[];
    try {
      accounts = parseAccounts(await found.provider.request({ method: 'eth_accounts' }));
    } catch {
      // The wallet could not answer now: stay disconnected, and try again on the next load.
      return null;
    }
    if (started !== generation) return null;
    // No account shared now (a locked wallet answers so too): stay disconnected and keep the memory for a later load.
    if (accounts.length === 0) return null;
    // The wallet shares accounts but not the remembered one: no longer authorised for it here, so forget it.
    if (!accounts.some((account) => sameAddress(account, remembered.address))) {
      writeRemembered(storage(), null);
      return null;
    }
    // Only as that account: when the wallet has another one active (the one it signs with), a click connects that.
    if (!sameAddress(accounts[0] ?? '', remembered.address)) return null;
    const resumed = resumedProvider(found.provider, accounts);
    const next = new InjectedWalletSession(resumed.provider, { id: found.id, name: found.name, rdns: found.rdns, source: found.source }, { localRpcUrl: options.localRpcUrl });
    let connection: InjectedConnection;
    try {
      connection = await next.connect();
    } catch {
      return null;
    }
    // Never `next.disconnect()` here: that would ask the wallet to revoke a permission the visitor gave.
    if (started !== generation) return null;
    resumed.live();
    return adopt(next, connection, remembered.provider, found.name);
  }

  function pick(walletId: string | undefined): { provider: Eip1193Provider; name: string; rdns: string | null; source: 'eip6963' | 'window_ethereum' } {
    if (walletId === BROWSER_WALLET_ID) {
      // Read only now, on the person's explicit choice of "Browser wallet".
      const injected = (target() as { ethereum?: unknown }).ethereum;
      if (typeof injected !== 'object' || injected === null || typeof (injected as { request?: unknown }).request !== 'function') {
        throw new WalletError('no_browser_wallet', 'No browser wallet was found in this browser.');
      }
      return { provider: injected as Eip1193Provider, name: 'Browser wallet', rdns: null, source: 'window_ethereum' };
    }
    const wallet = walletId === undefined ? undefined : discovered.get(walletId);
    if (!wallet) throw new WalletError('unknown_wallet', 'Choose one of the wallets listed.');
    return { provider: wallet.provider, name: wallet.name, rdns: wallet.rdns, source: 'eip6963' };
  }

  return {
    kind: 'injected',

    discover(onChange) {
      const last = readLast(storage());
      return discoverWallets(target(), (wallets) => {
        wallets.forEach((wallet) => discovered.set(wallet.id, wallet));
        onChange(
          Object.freeze(
            wallets.map((wallet) => Object.freeze({ id: wallet.id, name: wallet.name, icon: wallet.icon, rdns: wallet.rdns, lastUsed: last !== null && wallet.rdns === last })),
          ),
        );
      });
    },

    get signer() {
      const live = session;
      if (!live || !live.isConnected) return null;
      if (SEPOLIA_TRADE && live.meta.id.startsWith(PROVIDED_PREFIX)) return Object.freeze({ request: live.request, walletName: live.meta.name, confirmsInPage: true as const });
      return Object.freeze({ request: live.request, walletName: live.meta.name });
    },

    connectProvider: SEPOLIA_TRADE ? async (wallet: ProvidedWallet): Promise<WalletConnection> => {
      if (!PROVIDED_ID.test(wallet.id)) throw new WalletError('unknown_wallet', 'Unknown wallet.');
      // A reconnect on load never takes the place of a wallet that is connected now: that one was the person's choice.
      if (wallet.resume && session?.isConnected) throw new WalletError('not_connected', 'Another wallet was chosen meanwhile.');
      generation += 1;
      const started = generation;
      const id = `${PROVIDED_PREFIX}${wallet.id}`;
      let provider = wallet.provider;
      let resumed: { readonly live: () => void } | null = null;
      if (wallet.resume) {
        // F135's rule for a reconnect on load: the account the provider already shares, and no account request to it.
        let accounts: Address[];
        try { accounts = parseAccounts(await wallet.provider.request({ method: 'eth_accounts' })); } catch { throw new WalletError('wallet_error', 'The wallet could not answer.'); }
        if (started !== generation || !sameAddress(accounts[0] ?? '', wallet.resume.address)) throw new WalletError('not_connected', 'The wallet no longer shares that address.');
        const wrapped = resumedProvider(wallet.provider, accounts);
        provider = wrapped.provider;
        resumed = wrapped;
      }
      const previous = session;
      if (previous) {
        drop();
        if (previous.meta.id !== id) {
          void previous.disconnect();
          writeRemembered(storage(), null);
        }
      }
      const next = new InjectedWalletSession(provider, { id, name: wallet.name, rdns: null, source: 'eip6963' }, { localRpcUrl: options.localRpcUrl });
      let connection: InjectedConnection;
      try {
        connection = await next.connect();
      } catch (error) {
        throw asWalletError(error);
      }
      if (started !== generation) throw new WalletError('not_connected', 'Another wallet was chosen meanwhile.');
      resumed?.live();
      const adopted = adopt(next, connection, id, wallet.name);
      if (previous && previous.meta.id !== id) emitAccounts([connection.account]);
      return adopted;
    } : null,

    resume(): Promise<WalletConnection | null> {
      if (session?.isConnected && current) return Promise.resolve(current);
      if (resuming) return resuming;
      const remembered = readRemembered(storage());
      if (remembered === null) return Promise.resolve(null);
      const attempt = resumeRemembered(remembered, generation).finally(() => {
        if (resuming === attempt) resuming = null;
      });
      resuming = attempt;
      return attempt;
    },

    release() {
      generation += 1;
      resuming = null;
      drop();
    },

    async connect(request = {}): Promise<WalletConnection> {
      generation += 1;
      const started = generation;
      const chosen = pick(request.walletId);
      const previous = session;
      if (previous) {
        drop();
        // Another wallet: let go of the old one (revoke where supported) and of its memory, so a refresh after a failed
        // switch does not bring it back silently (F135). The same wallet again: just reconnect.
        if (previous.meta.id !== (request.walletId ?? BROWSER_WALLET_ID)) {
          void previous.disconnect();
          writeRemembered(storage(), null);
        }
      }
      const next = new InjectedWalletSession(
        chosen.provider,
        { id: request.walletId ?? BROWSER_WALLET_ID, name: chosen.name, rdns: chosen.rdns, source: chosen.source },
        { localRpcUrl: options.localRpcUrl },
      );
      let connection: { account: Address; chainId: number };
      try {
        connection = await next.connect();
      } catch (error) {
        throw asWalletError(error);
      }
      // A wallet's yes that comes after a later choice (another connect, the page's own wallet, a disconnect) changes
      // nothing (XR-ALPHA-SITE af3): that choice stands. The late session is not adopted, and not revoked either, which
      // would take back the permission the person just gave in their wallet.
      if (started !== generation) throw new WalletError('not_connected', 'A later choice took its place.');
      const adopted = adopt(next, connection, chosen.source === 'window_ethereum' || chosen.rdns === null ? WINDOW_ETHEREUM : `${EIP6963_PREFIX}${chosen.rdns}`, chosen.name);
      writeLast(storage(), chosen.rdns);
      if (previous && previous.meta.id !== next.meta.id) emitAccounts([connection.account]);
      return adopted;
    },

    disconnect() {
      generation += 1;
      // The person's Disconnect (or a switch to the sample wallet): no silent reconnect after a refresh any more.
      writeRemembered(storage(), null);
      const live = session;
      if (live === null) return;
      drop();
      void live.disconnect();
      emitAccounts([]);
    },

    async switchChain(chainId) {
      if (!isChainId(chainId)) throw new WalletError('invalid_chain', 'Chain id must be a positive integer');
      const live = session;
      if (live === null) throw new WalletError('not_connected', 'Connect a browser wallet first');
      try {
        await live.switchChain(chainId);
      } catch (error) {
        throw asWalletError(error);
      }
    },

    onAccountsChanged(listener) {
      accountListeners.add(listener);
      return () => accountListeners.delete(listener);
    },

    onChainChanged(listener) {
      chainListeners.add(listener);
      return () => chainListeners.delete(listener);
    },
  };
}

import type { Eip1193Request } from '@squarehole/chain/write/wallet';
import { DEMO_CHAIN_ID, type Address } from '@squarehole/domain';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createInjectedWalletAdapter, type BrowserWalletOption, type InjectedWalletAdapter, type ProvidedWallet } from './injected-adapter';
import { WalletError, createDemoWalletAdapter, personaForAccount, type WalletAdapter, type WalletKind } from './wallet-adapter';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export type WalletStatus = 'disconnected' | 'connecting' | 'connected';

export interface WalletConnectOptions {
  /** Demo only: the chain the demo wallet reports ("simulate wrong network"). */
  readonly chainId?: number;
}

/** The connected browser wallet as the chain transaction flow uses it (never the demo wallet). */
export interface ConnectedSigner {
  readonly request: Eip1193Request;
  readonly walletName: string;
  /**
   * F161 (4): a wallet the page holds itself (the Sepolia alpha's wallet Privy made), which opens no window of its own:
   * the page's press is the one confirmation, so its lines say "Signing…", never "Confirm in your wallet…".
   */
  readonly confirmsInPage?: true;
}

/**
 * F161 (4): a connect of a wallet the page holds itself after a wait (the made wallet's reconnect on load,
 * made-wallet.ts, and "Make me a wallet" while Privy makes it, ClaimCard.tsx), taken while nothing is connected. It
 * stands for the connection as it was then: any connect or disconnect the person starts afterwards, or any wallet that
 * connects meanwhile, ends it, and its `connect` then does nothing (XR-ALPHA-SITE af1, af2).
 */
export interface ProvidedResume {
  /** Whether nothing was connected, chosen or let go since the ticket was taken. */
  readonly current: () => boolean;
  /** Connects the wallet when the ticket is still current, checked in the same step; false (and nothing done) otherwise. */
  readonly connect: (wallet: ProvidedWallet) => Promise<boolean>;
}

export interface WalletContextValue {
  readonly status: WalletStatus;
  readonly account: Address | null;
  readonly chainId: number | null;
  readonly personaId: string | null;
  /** Demo wallet: explicit user action only (UI-09). Connecting again while connected switches persona and/or chain. */
  connect(personaId: string, options?: WalletConnectOptions): Promise<void>;
  /** Browser wallet: the person's Connect click on a listed wallet (or `BROWSER_WALLET_ID`). */
  connectBrowserWallet(walletId: string): Promise<void>;
  /** EIP-6963 discovery while the browser-wallet window is open; returns a function that stops it. */
  discoverBrowserWallets(onChange: (wallets: readonly BrowserWalletOption[]) => void): () => void;
  /**
   * F161 (4), Sepolia trade builds only (null elsewhere): connects a wallet the page holds itself (the alpha's wallet
   * Privy made, handed over by the trade folder), as a press on a listed wallet connects one.
   */
  readonly connectProvidedWallet: ((wallet: ProvidedWallet) => Promise<void>) | null;
  /** F161 (4), the same builds: a ticket for connecting such a wallet after a wait, never over the person (`ProvidedResume`). */
  readonly resumeProvidedWallet: (() => ProvidedResume) | null;
  disconnect(): void;
  switchChain(chainId: number): Promise<void>;
  /**
   * SH-203: the browser wallet's own account and chain events, as its adapter emits them (EIP-1193), for a page whose
   * long-running work must stop at the event itself (the reveal session). Returns a function that stops listening.
   */
  onAccountsChanged(listener: (accounts: readonly Address[]) => void): () => void;
  onChainChanged(listener: (chainId: number) => void): () => void;
  /** The wallet in use: 'demo' (also while disconnected) or 'injected' (a browser wallet). */
  readonly kind: WalletKind;
  /** Browser wallets: the wallet's announced name. Null for the demo wallet. */
  readonly walletName: string | null;
  /** Browser wallets only: what the chain transaction flow sends through. Null for the demo wallet. */
  readonly signer: ConnectedSigner | null;
  /** The chain the app's pages expect (the top bar marks any other network). */
  readonly targetChainId: number;
  /** Which window "Connect wallet" opens: the demo wallet (demo data) or the browser-wallet chooser (live chains). */
  readonly defaultDialog: 'demo' | 'browser';
  /**
   * Which wallets the menu offers (SH-C): the demo wallet only with the demo fixtures, browser wallets only on a chain
   * data source (a real wallet cannot act on demo data, and the demo wallet cannot sign on a chain). `both` is the
   * default for isolated feature tests.
   */
  readonly walletKinds: WalletKinds;
}

export type WalletKinds = 'demo' | 'browser' | 'both';

interface WalletSnapshot {
  readonly status: WalletStatus;
  readonly account: Address | null;
  readonly chainId: number | null;
  readonly personaId: string | null;
  readonly kind: WalletKind;
  readonly walletName: string | null;
}

// The production site has no Demo wallet: a disconnected wallet there is a browser wallet not connected yet.
const DISCONNECTED: WalletSnapshot = Object.freeze({ status: 'disconnected', account: null, chainId: null, personaId: null, kind: DEMO_BUILD ? 'demo' : 'injected', walletName: null });

/** The production site's stand-in for the Demo wallet: it never connects (nothing offers it there). */
const NO_DEMO_WALLET: WalletAdapter = Object.freeze({
  kind: 'injected',
  connect: () => Promise.reject(new WalletError('unknown_wallet', 'No such wallet on this site')),
  disconnect: () => undefined,
  switchChain: () => Promise.reject(new WalletError('not_connected', 'Not connected')),
  onAccountsChanged: () => () => undefined,
  onChainChanged: () => () => undefined,
});

const WalletContext = createContext<WalletContextValue | null>(null);

export interface WalletProviderProps {
  children: ReactNode;
  /** Test seam: the demo adapter (production uses the built-in one). Must be stable for the provider's lifetime. */
  adapter?: WalletAdapter;
  /** Test seam: the browser-wallet adapter. Must be stable for the provider's lifetime. */
  injectedAdapter?: InjectedWalletAdapter;
  /** The chain the app's pages expect (default: the local demo chain 31337). */
  targetChainId?: number;
  /** "Connect wallet" opens the demo wallet (default, demo data) or the browser-wallet chooser (live chains). */
  defaultDialog?: 'demo' | 'browser';
  /** Which wallets the menu offers (default both; the app passes the data source's). */
  walletKinds?: WalletKinds;
  /** RPC URL a browser wallet is given if it has to add the local anvil chain (the app passes the data source's). */
  localRpcUrl?: string;
  /**
   * F135: reconnect a browser wallet this device connected before, once, without a click (the app passes whether the
   * Terms are accepted). Only where browser wallets are offered. Default off.
   */
  reconnect?: boolean;
}

/**
 * Wallet state for the whole app. Starts disconnected on every load and never connects or probes a browser wallet by
 * itself (UI-09), with one exception (F135, founder 2026-10-11: a refresh keeps the wallet connected): when this
 * device connected a browser wallet before and `reconnect` is on, it asks that one wallet `eth_accounts` once and, if
 * the remembered address is still authorised, shows the visitor connected again. Nothing that opens a wallet window is
 * ever asked without a click, and without the memory nothing is touched. One wallet at a time: connecting the demo
 * wallet disconnects a browser wallet and vice versa; Disconnect forgets the memory.
 */
export function WalletProvider({
  children,
  adapter: demoInjected,
  injectedAdapter: browserInjected,
  targetChainId = DEMO_CHAIN_ID,
  defaultDialog = DEMO_BUILD ? 'demo' : 'browser',
  walletKinds = 'both',
  localRpcUrl,
  reconnect = false,
}: WalletProviderProps) {
  const [demo] = useState<WalletAdapter>(() => demoInjected ?? (DEMO_BUILD ? createDemoWalletAdapter() : NO_DEMO_WALLET));
  const [browser] = useState<InjectedWalletAdapter>(() => browserInjected ?? createInjectedWalletAdapter({ localRpcUrl }));
  const [snapshot, setSnapshot] = useState<WalletSnapshot>(DISCONNECTED);
  // Increments on every connect/disconnect so a connect that resolves after a later disconnect is dropped.
  const request = useRef(0);
  const wantsConnection = useRef(false);

  useEffect(() => {
    const listen = (adapter: WalletAdapter, kind: WalletKind) => {
      const offAccounts = adapter.onAccountsChanged((accounts) => {
        const account = accounts[0] ?? null;
        setSnapshot((current) => {
          if (current.kind !== kind || current.status === 'disconnected') return current;
          if (account === null) return DISCONNECTED;
          return { ...current, account, personaId: DEMO_BUILD && kind === 'demo' ? (personaForAccount(account)?.id ?? null) : null };
        });
      });
      const offChain = adapter.onChainChanged((chainId) => {
        setSnapshot((current) => (current.kind !== kind || current.status === 'disconnected' ? current : { ...current, chainId }));
      });
      return () => {
        offAccounts();
        offChain();
      };
    };
    const offDemo = DEMO_BUILD ? listen(demo, 'demo') : () => undefined;
    const offBrowser = listen(browser, 'injected');
    return () => {
      offDemo();
      offBrowser();
    };
  }, [demo, browser]);

  // F135: once per provider (a new data source starts a new one), when the Terms are accepted and browser wallets are
  // offered. The adapter gives way to any connect or disconnect the person starts meanwhile.
  useEffect(() => {
    // The sample data offers the sample wallet only (a development build's choice; the production site has none).
    if (!reconnect || (DEMO_BUILD && walletKinds === 'demo')) return undefined;
    let live = true;
    const started = request.current;
    browser.resume().then(
      (connection) => {
        if (!live || connection === null || started !== request.current) return;
        wantsConnection.current = true;
        setSnapshot(Object.freeze({ status: 'connected', kind: 'injected', account: connection.account, chainId: connection.chainId, personaId: null, walletName: connection.walletName ?? null }));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [browser, reconnect, walletKinds]);
  // A provider that goes away (the app is re-keyed by its data source) lets go of its browser wallet session quietly.
  useEffect(() => () => browser.release(), [browser]);

  const run = useCallback(async (kind: WalletKind, connectWith: () => Promise<{ account: Address; chainId: number; personaId: string | null; walletName?: string | null }>) => {
    const id = ++request.current;
    wantsConnection.current = true;
    // One wallet at a time: the other adapter lets go first (a no-op when it is not connected).
    (kind === 'injected' ? demo : browser).disconnect();
    setSnapshot((current) => (current.status === 'connected' && current.kind === kind ? current : { ...DISCONNECTED, status: 'connecting', kind }));
    try {
      const connection = await connectWith();
      if (id !== request.current) {
        // Disconnected while this was in flight: keep the adapter in line with what the person last asked for.
        if (!wantsConnection.current) (kind === 'injected' ? browser : demo).disconnect();
        return;
      }
      setSnapshot(Object.freeze({ status: 'connected', kind, account: connection.account, chainId: connection.chainId, personaId: connection.personaId, walletName: connection.walletName ?? null }));
    } catch (error) {
      // A failed connect leaves what the adapter still holds: nothing after a first try; the earlier wallet after a
      // failed switch to another persona; but not a browser wallet the adapter let go of to try another one
      // (injected-adapter.ts `connect` drops the old session first), so the top bar never shows a connection that is gone.
      if (id === request.current) setSnapshot((current) => (current.status === 'connecting' || (kind === 'injected' && current.kind === 'injected' && browser.signer === null) ? DISCONNECTED : current));
      throw error;
    }
  }, [demo, browser]);

  const connect = useCallback(
    (personaId: string, options: WalletConnectOptions = {}) => (DEMO_BUILD ? run('demo', () => demo.connect({ personaId, chainId: options.chainId })) : demo.connect().then(() => undefined)),
    [run, demo],
  );
  const connectBrowserWallet = useCallback((walletId: string) => run('injected', () => browser.connect({ walletId })), [run, browser]);
  const connectProvider = browser.connectProvider;
  const connectProvidedWallet = useMemo(() => (connectProvider ? (wallet: ProvidedWallet) => run('injected', () => connectProvider(wallet)) : null), [run, connectProvider]);
  // The person's own connects and disconnects move `request`; a wallet that came back by itself (F135) shows in the
  // adapter's signer. A ticket checks both in the step that would connect, so nothing can come between.
  const resumeProvidedWallet = useMemo(() => (connectProvider ? (): ProvidedResume => {
    const started = request.current;
    const current = () => started === request.current && browser.signer === null;
    return Object.freeze({
      current,
      connect: async (wallet: ProvidedWallet) => {
        if (!current()) return false;
        await run('injected', () => connectProvider(wallet));
        return true;
      },
    });
  } : null), [run, connectProvider, browser]);
  const discoverBrowserWallets = useCallback((onChange: (wallets: readonly BrowserWalletOption[]) => void) => browser.discover(onChange), [browser]);

  const disconnect = useCallback(() => {
    request.current += 1;
    wantsConnection.current = false;
    demo.disconnect();
    browser.disconnect();
    setSnapshot(DISCONNECTED);
  }, [demo, browser]);

  const switchChain = useCallback((chainId: number) => (snapshot.kind === 'injected' ? browser : demo).switchChain(chainId), [snapshot.kind, browser, demo]);
  const onAccountsChanged = useCallback((listener: (accounts: readonly Address[]) => void) => { const off = browser.onAccountsChanged(listener); return () => { off(); }; }, [browser]);
  const onChainChanged = useCallback((listener: (chainId: number) => void) => { const off = browser.onChainChanged(listener); return () => { off(); }; }, [browser]);

  const value = useMemo<WalletContextValue>(() => {
    const signer = snapshot.kind === 'injected' && snapshot.status === 'connected' ? browser.signer : null;
    return {
      ...snapshot,
      connect,
      connectBrowserWallet,
      discoverBrowserWallets,
      connectProvidedWallet,
      resumeProvidedWallet,
      disconnect,
      switchChain,
      onAccountsChanged,
      onChainChanged,
      signer,
      targetChainId,
      defaultDialog,
      walletKinds,
    };
  }, [snapshot, connect, connectBrowserWallet, discoverBrowserWallets, connectProvidedWallet, resumeProvidedWallet, disconnect, switchChain, onAccountsChanged, onChainChanged, browser, targetChainId, defaultDialog, walletKinds]);
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

/** The wallet context, or null outside a <WalletProvider> (a page part that is simply absent there). */
export function useOptionalWallet(): WalletContextValue | null {
  return useContext(WalletContext);
}

export function useWallet(): WalletContextValue {
  const value = useContext(WalletContext);
  if (!value) throw new Error('useWallet needs <WalletProvider> (see AppProviders)');
  return value;
}

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createWalletClient, custom, numberToHex, type Address, type WalletClient } from 'viem';
import { CHAIN_ID, chainFor } from './chain';
import { loadMadeWallet, shouldLoadPrivy } from './privy-load';
import type { MadeWallet } from './privy-made';
import { useSiteSignIn } from './site-signin';

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, fn: (...a: unknown[]) => void): void;
  removeListener?(event: string, fn: (...a: unknown[]) => void): void;
}

/** The browser's injected wallet (Privy's types declare `window.ethereum` as `any`; this page reads it as EIP-1193). */
const injectedWallet = (): Eip1193 | undefined => (typeof window !== 'undefined' ? (window as { ethereum?: Eip1193 }).ethereum : undefined);

/** SH-280: which wallet the page uses: the browser's own, or the one Privy made for the site's X sign-in. */
export type WalletKind = 'browser' | 'made';

export interface Wallet {
  present: boolean;
  /** The wallet in use (null without one). */
  kind: WalletKind | null;
  /** SH-280: the made wallet is still being read from Privy (the page says nothing about a missing wallet meanwhile). */
  pending: boolean;
  /** The other choice the wallet place offers: the browser wallet while the made one is in use, and back. */
  other: WalletKind | null;
  /** Use the other wallet (voids what was prepared, as any wallet change does). */
  useOther(): void;
  account?: Address;
  chainId?: number;
  onRightChain: boolean;
  /** Grows with every change the wallet reports (account, chain): what was prepared before it is void. */
  epoch: number;
  currentEpoch(): number;
  connect(): Promise<void>;
  /** Switches the wallet to chain 97, adding it first when the wallet does not know it. */
  ensureChain(): Promise<void>;
  client(): WalletClient;
  provider(): Eip1193 | undefined;
}

const WalletContext = createContext<Wallet | null>(null);

export function useWallet(): Wallet {
  const w = useContext(WalletContext);
  if (!w) throw new Error('WalletProvider missing');
  return w;
}

/**
 * SH-280: which wallet to use, as the platform decides it (apps/web/src/features/trade-sepolia/made-wallet.ts: the made
 * wallet is one more wallet of the app's wallet context, connected again without a window where the site's sign-in
 * holds it, and never over a wallet the person chose): the made wallet when this browser's sign-in holds one, unless
 * the person chose the browser wallet on this page; else the browser wallet; else none.
 */
export function walletKindOf(made: boolean, browser: boolean, chose: WalletKind | null): WalletKind | null {
  if (chose === 'browser' && browser) return 'browser';
  if (made) return 'made';
  return browser ? 'browser' : null;
}

/**
 * The browser's injected wallet, and (SH-280) the wallet Privy made for the site's X sign-in. Nothing is asked of the
 * browser wallet on load or navigation, not even which account it holds: the page starts disconnected and asks only at
 * Connect. The made wallet comes from Privy's own record, without a window and without a request to any wallet: where
 * the site's sign-in and Privy's token are in this browser, it is ready at once (as the platform reconnects it).
 * Afterwards the page listens to the wallet's change events (listening sends no request); every change voids what was
 * prepared (`epoch`).
 */
export function WalletProvider({ rpcUrls, explorer, children }: { rpcUrls: string[]; explorer: string; children: ReactNode }) {
  const injected = injectedWallet();
  const signIn = useSiteSignIn();
  const [made, setMade] = useState<MadeWallet | null>(null);
  const [pending, setPending] = useState(false);
  const [chose, setChose] = useState<WalletKind | null>(null);
  const kind = walletKindOf(made !== null, Boolean(injected), chose);
  const eth = kind === 'made' ? made?.provider : kind === 'browser' ? injected : undefined;
  const [browserAccount, setAccount] = useState<Address | undefined>();
  const [browserChainId, setChainId] = useState<number | undefined>();
  const account = kind === 'made' ? made?.address : browserAccount;
  const chainId = kind === 'made' ? CHAIN_ID : browserChainId;
  const [epoch, setEpoch] = useState(0);
  const epochRef = useRef(0);
  const connected = useRef(false);
  const bumpEpoch = useCallback(() => {
    epochRef.current += 1;
    setEpoch(epochRef.current);
  }, []);

  // SH-280: Privy, only where the site's sign-in is on and Privy's token is in this browser (privy-load.ts).
  useEffect(() => {
    if (!shouldLoadPrivy(signIn, typeof window !== 'undefined' ? window.localStorage : null)) return undefined;
    let live = true;
    setPending(true);
    void loadMadeWallet().then((wallet) => {
      if (!live) return;
      setPending(false);
      if (wallet === null) return;
      setMade(wallet);
      bumpEpoch();
    }, () => { if (live) setPending(false); });
    return () => { live = false; };
  }, [signIn, bumpEpoch]);

  useEffect(() => {
    if (!eth || kind !== 'browser') return;
    const onAccounts = (a: unknown) => {
      if (!connected.current) return;
      const next = (a as Address[])[0];
      setAccount(next);
      if (!next) connected.current = false;
      bumpEpoch();
    };
    const onChain = (c: unknown) => {
      if (!connected.current) return;
      setChainId(Number(c as string));
      bumpEpoch();
    };
    eth.on?.('accountsChanged', onAccounts);
    eth.on?.('chainChanged', onChain);
    return () => {
      eth.removeListener?.('accountsChanged', onAccounts);
      eth.removeListener?.('chainChanged', onChain);
    };
  }, [eth, kind, bumpEpoch]);

  const connect = useCallback(async () => {
    // The made wallet is connected already (no window, no request).
    if (!eth || kind === 'made') return;
    const a = (await eth.request({ method: 'eth_requestAccounts' })) as Address[];
    const c = Number((await eth.request({ method: 'eth_chainId' })) as string);
    connected.current = Boolean(a[0]);
    setAccount(a[0]);
    setChainId(c);
    bumpEpoch();
  }, [eth, kind, bumpEpoch]);

  const ensureChain = useCallback(async () => {
    // The made wallet lives on chain 97 (Privy's settings name no other): it is never asked to switch.
    if (!eth || kind === 'made') return;
    const hex = numberToHex(CHAIN_ID);
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
    } catch (e) {
      const code = (e as { code?: number }).code;
      if (code !== 4902 && code !== -32603) throw e;
      const chain = chainFor({ rpcUrls, explorer });
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [{ chainId: hex, chainName: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls, blockExplorerUrls: [explorer] }],
      });
    }
    setChainId(Number((await eth.request({ method: 'eth_chainId' })) as string));
    bumpEpoch();
  }, [eth, kind, rpcUrls, explorer, bumpEpoch]);

  const other: WalletKind | null = kind === 'made' && injected ? 'browser' : kind === 'browser' && made ? 'made' : null;
  const useOther = useCallback(() => {
    if (other === null) return;
    setChose(other);
    bumpEpoch();
  }, [other, bumpEpoch]);

  const client = useCallback(() => {
    if (!eth) throw new Error('no wallet');
    return createWalletClient({ account, chain: chainFor({ rpcUrls, explorer }), transport: custom(eth) });
  }, [eth, account, rpcUrls, explorer]);

  const value = useMemo<Wallet>(
    () => ({
      present: Boolean(eth),
      kind,
      pending,
      other,
      useOther,
      account,
      chainId,
      onRightChain: chainId === CHAIN_ID,
      epoch,
      currentEpoch: () => epochRef.current,
      connect,
      ensureChain,
      client,
      provider: () => eth,
    }),
    [eth, kind, pending, other, useOther, account, chainId, epoch, connect, ensureChain, client],
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

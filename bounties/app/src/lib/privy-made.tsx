/**
 * SH-280: the wallet Privy made for the visitor's X account, on the launch pages, from Privy's React SDK. Loaded lazily
 * (privy-load.ts) and only when this browser holds the site's sign-in and Privy's own token. It is the platform's bridge
 * (apps/web/src/features/trade-sepolia/privy-live.tsx) cut to the one thing this page needs: the made wallet's address
 * and its EIP-1193 provider. This page never signs anyone in or out and never makes a wallet: those stay on the
 * platform. The client settings are the platform's `privyClientConfigOf` for BNB Chain testnet: X only, no wallet made
 * at sign-in, no wallet windows, no external wallets, no cookie copies, chain 97 (privy-settings.ts).
 */
import { PrivyProvider, usePrivy, useWallets, type ConnectedWallet, type User, type WalletWithMetadata } from '@privy-io/react-auth';
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { PRIVY_CLIENT_CONFIG } from './privy-settings';
import type { Eip1193 } from './wallet';

export interface MadeWallet {
  readonly address: `0x${string}`;
  readonly provider: Eip1193;
}

/** How long Privy may take to say who is signed in and to list the made wallet. */
const WAIT_MS = 60_000;

interface Snapshot {
  readonly ready: boolean;
  readonly authenticated: boolean;
  readonly user: User | null;
  readonly wallets: readonly ConnectedWallet[];
}
let snapshot: Snapshot | null = null;
const listeners = new Set<() => void>();

function waitFor(test: (s: Snapshot) => boolean, ms: number): Promise<Snapshot | null> {
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

/** The made wallet as Privy's account record lists it (the platform's `madeAddressOf`). */
export function madeAddressOf(user: User | null): string | null {
  const made = (user?.linkedAccounts ?? []).filter((account): account is WalletWithMetadata =>
    account.type === 'wallet' && account.walletClientType === 'privy' && account.chainType === 'ethereum' && account.walletIndex !== null);
  made.sort((a, b) => (a.walletIndex ?? 0) - (b.walletIndex ?? 0));
  return made[0]?.address ?? null;
}

function Bridge() {
  const privy = usePrivy();
  const { wallets } = useWallets();
  useEffect(() => {
    snapshot = { ready: privy.ready, authenticated: privy.authenticated, user: privy.user, wallets };
    for (const listener of [...listeners]) listener();
  }, [privy.ready, privy.authenticated, privy.user, wallets]);
  return null;
}

let mounted: Promise<MadeWallet | null> | null = null;

/** The made wallet of this browser's Privy sign-in, or null (no sign-in, no made wallet, or Privy did not answer). */
export function madeWallet(appId: string): Promise<MadeWallet | null> {
  mounted ??= (async () => {
    const host = document.createElement('div');
    host.dataset.shPrivy = '';
    document.body.append(host);
    createRoot(host).render(<PrivyProvider appId={appId} config={PRIVY_CLIENT_CONFIG}><Bridge /></PrivyProvider>);
    const known = await waitFor((s) => s.ready && (!s.authenticated || s.user !== null), WAIT_MS);
    if (!known?.authenticated) return null;
    const address = madeAddressOf(known.user);
    if (address === null) return null;
    const same = (w: ConnectedWallet) => w.walletClientType === 'privy' && w.address.toLowerCase() === address.toLowerCase();
    const listed = await waitFor((s) => s.wallets.some(same), WAIT_MS);
    const wallet = listed?.wallets.find(same);
    if (!wallet) return null;
    const provider = (await wallet.getEthereumProvider()) as unknown as Eip1193;
    return Object.freeze({ address: wallet.address as `0x${string}`, provider });
  })();
  return mounted;
}

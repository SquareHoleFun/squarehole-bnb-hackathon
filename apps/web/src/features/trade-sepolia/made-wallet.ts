/**
 * F161 (4), SH-ALPHA-SITE, work package E: the wallet Privy makes for a tester, as one more wallet of the app's own
 * wallet context (features/wallet, `connectProvidedWallet`): its EIP-1193 provider goes in, and from then on the trade
 * box, the test-coin page and the Claim card send through it exactly as through a browser wallet. It opens no window of
 * its own (Privy's `showWalletUIs: false`): our page's press is the one confirmation and signs exactly what the page
 * shows; nothing signs without a press, and there is no server or delegated signer.
 *
 * Offered, never forced: "Make me a wallet" on the Claim card makes it (Privy's `createOnLogin` stays off). A device
 * that connected it remembers it as the app remembers any wallet (`sh.wallet.connected.v1`, `provided:privy`), and the
 * next load connects it again without a window, when Privy still holds the X sign-in (`useMadeWalletResume`).
 */
import { useEffect, useRef } from 'react';
import type { PrivyBridge } from '../alpha-sepolia/privy-bridge';
import { privyAppIdOf } from '../alpha-sepolia/privy-config';
import { MADE_WALLET_ID, rememberedMadeWallet } from '../alpha-sepolia/made-wallet-memory';
import { useWallet } from '../wallet';
import { WalletError } from '../wallet/wallet-adapter';
import { loadPrivyBridge } from './privy-load';
import { ALPHA_ON } from '../alpha-sepolia/alpha-on';

/** SH-275: the alpha's switch (alpha-on.ts): Sepolia's `alphaGate`; on BNB Chain testnet only with its own Privy app. */
const ALPHA_GATE = ALPHA_ON;

export { MADE_WALLET_ID, rememberedMadeWallet };
/** How the wallet window and the top bar name it. */
export const MADE_WALLET_NAME = 'Wallet Privy made';

let bridge: Promise<PrivyBridge> | null = null;
/**
 * Privy's bridge for this page (one per page load), or null while the Privy app ID is the placeholder. A load that failed
 * (a dropped connection while Privy's code came) is forgotten, so the next press loads it again (F166 af1: "Try again").
 */
export function madeWalletBridge(load: (appId: string) => Promise<PrivyBridge> = loadPrivyBridge, appId: string | null = privyAppIdOf()): Promise<PrivyBridge> | null {
  if (appId === null) return null;
  if (bridge === null) {
    const loading = load(appId);
    bridge = loading;
    loading.catch(() => {
      if (bridge === loading) bridge = null;
    });
  }
  return bridge;
}

let resumed = false;
let resumeQueue = Promise.resolve();

/**
 * The shell, Test coins and the trade slot can each try once. They take turns, and a definite provider answer
 * finishes the restore for the visit. A provider failure leaves the next mount free to try.
 *
 * It never overrides the person (XR-ALPHA-SITE af1): the wallet context's ticket (`resumeProvidedWallet`), taken while
 * nothing is connected, ends at any connect or disconnect the person starts and at any wallet that connects meanwhile;
 * after each wait for Privy (its code, its readiness, its wallet frame) the attempt also stops if the page left or this
 * device remembers another wallet now; and the ticket is checked again in the very step that would connect. An attempt
 * the page ended (StrictMode's second run, a page left early) leaves the next mount free to try again; one the person
 * ended does not.
 */
export function useMadeWalletResume(load?: (appId: string) => Promise<PrivyBridge>, appId?: string | null): void {
  const { resumeProvidedWallet, status } = useWallet();
  const attempted = useRef(false);
  useEffect(() => {
    // SH-258: a wallet Privy made exists only where the test network has the alpha (SH-275: on BNB Chain testnet only
    // with its own Privy app).
    if (!ALPHA_GATE || resumed || attempted.current || status !== 'disconnected' || !resumeProvidedWallet) return undefined;
    const address = rememberedMadeWallet();
    const id = appId === undefined ? privyAppIdOf() : appId;
    if (address === null || id === null) return undefined;
    const ticket = resumeProvidedWallet();
    let live = true;
    const wanted = () => live && ticket.current() && rememberedMadeWallet()?.toLowerCase() === address.toLowerCase();
    resumeQueue = resumeQueue.then(async () => {
      if (resumed || !wanted()) return;
      attempted.current = true;
      let connecting = false;
      try {
        const privy = await madeWalletBridge(load, id);
        if (!privy || !wanted()) return;
        await privy.ready({ rejectOnTimeout: true });
        if (!wanted()) return;
        const made = privy.authenticated() ? await privy.madeWallet() : null;
        if (!wanted()) return;
        if (made !== null && made.address.toLowerCase() === address.toLowerCase()) {
          connecting = true;
          await ticket.connect({ id: MADE_WALLET_ID, name: MADE_WALLET_NAME, provider: made.provider, resume: { address } });
        }
        resumed = true;
      } catch (error) {
        // The adapter can also find a different address in eth_accounts. A missing answer stays retryable.
        resumed = error instanceof WalletError && error.code === 'not_connected';
      } finally {
        // Only our own connect may move the ticket and still leave a transient failure to retry.
        if (!connecting && !ticket.current()) resumed = true;
      }
    });
    return () => { live = false; };
  }, [resumeProvidedWallet, status, load, appId]);
}

/** For the tests: forget this page load's bridge and resume. */
export function resetMadeWalletForTests(): void {
  bridge = null;
  resumed = false;
  resumeQueue = Promise.resolve();
}

/** The page-level restore, mounted where the test network has the alpha. */
export function MadeWalletResume(): null {
  useMadeWalletResume();
  return null;
}

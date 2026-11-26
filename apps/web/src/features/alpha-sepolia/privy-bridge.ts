/**
 * F161 (4), SH-ALPHA-SITE: what the alpha's pages need from Privy, as one small interface. Two implementations, both in
 * the trade folder (features/trade-sepolia, so `TRADE_SOURCE` and the source audits cover them) and both reached only
 * lazily, behind the trade literal:
 * - privy-live.tsx: Privy's React SDK (`@privy-io/react-auth`), X sign-in on Privy's own X keys, the embedded wallet
 *   with Privy's windows off (`showWalletUIs: false`), its export window;
 * - test-support/privy-standin.ts: the browser suites' stand-in (Privy has no test X login), in development builds
 *   opted in with `SH_ALPHA_STANDIN=1` only; every production build refuses that opt-in (build-target.ts).
 * The join page and the Claim card see only this interface. Nothing here signs or sends without the person's press:
 * the made wallet's provider answers our own pages' requests, and each of those follows a press.
 */
import type { Eip1193Provider } from '@squarehole/chain/write/wallet';

/** The wallet Privy made for the signed-in X account: its address and its EIP-1193 provider (no Privy window). */
export interface MadeWallet {
  readonly address: `0x${string}`;
  readonly provider: Eip1193Provider;
}

export interface PrivyBridge {
  /** Waits for the sign-in state. A caller that needs a definite answer can distinguish a timeout. */
  ready(options?: { rejectOnTimeout: boolean }): Promise<void>;
  /** Whether Privy holds a signed-in user in this browser. */
  authenticated(): boolean;
  /** Starts X sign-in through Privy: the page goes to X and comes back to the same address. */
  signIn(): Promise<void>;
  /**
   * On the page X sent the visitor back to (`returnedFromSignIn`): waits for Privy to finish the sign-in and gives its
   * identity token, or null when the sign-in did not complete.
   */
  finishSignIn(): Promise<string | null>;
  /** A current identity token for the signed-in user (renewed when it expired), or null. */
  identityToken(): Promise<string | null>;
  /** Ends Privy's session in this browser; rejects when Privy did not answer or its sign-out failed. */
  signOut(): Promise<void>;
  /** The wallet Privy made for this user, or null. Never makes one. */
  madeWallet(): Promise<MadeWallet | null>;
  /**
   * The person's "Make me a wallet" press, or the first step of "Set me up" (F166, trade-sepolia/setup-run.ts): the
   * wallet Privy made before, or a new one. A failure throws (the caller offers the press again).
   */
  makeWallet(): Promise<MadeWallet>;
  /** The person's "Export key" press: Privy's own export window for the made wallet. */
  exportWallet(): Promise<void>;
}

/** Privy's three query parameters on the page X sends the visitor back to (Privy reads and removes them itself). */
export const SIGN_IN_RETURN_PARAMETERS = Object.freeze(['privy_oauth_code', 'privy_oauth_state', 'privy_oauth_provider']);

/** Whether this page is the one X sent the visitor back to after a sign-in started here. */
export const returnedFromSignIn = (search: string): boolean => {
  const params = new URLSearchParams(search);
  return SIGN_IN_RETURN_PARAMETERS.every((name) => (params.get(name) ?? '') !== '');
};

/**
 * The join page for a sign-in with X that comes back to it, not into the app (XR-ALPHA-SITE af2, af3): opened from the
 * Claim card while it asks for that sign-in, and kept by the join page's own "Sign in with X" in a signed-in account's
 * view (an export that found Privy's sign-in lapsed). Opened so, and not as the return from X, the page offers that
 * sign-in at once.
 */
export const JOIN_THEN_EXPORT = '/join?then=export';
/** Whether the join page was opened as `JOIN_THEN_EXPORT` (or is the return from X to it). */
export const staysOnJoin = (search: string): boolean => new URLSearchParams(search).get('then') === 'export';

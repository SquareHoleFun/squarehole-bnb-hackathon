import { useApp } from '../lib/app-context';
import { chainFor, shortAddress } from '../lib/chain';
import { decodeError } from '../lib/errors';
import { JOIN_PATH, useSiteSignIn, type SiteSignIn } from '../lib/site-signin';
import { useWallet } from '../lib/wallet';
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';

/**
 * SH-280 STEP 1: the words where no wallet can be used here, in the platform's own words. The platform's join page
 * ("Sign in with X", its button's text) where the site's sign-in is on, and the platform's line for a browser without a
 * wallet (apps/web/src/features/wallet/injected-adapter.ts, `no_browser_wallet`).
 */
export const NO_WALLET_WORDS = Object.freeze({
  signIn: 'Sign in with X',
  noBrowserWallet: 'No browser wallet was found in this browser.',
  // SH-280 STEP 2: signed in with X but no wallet Privy made yet: the platform's own press ("Set me up",
  // apps/web/src/features/alpha-sepolia/alpha-words.ts SETUP_WORDS.start), on the page whose Claim card offers it.
  setUp: 'Set me up',
});
/** The platform's test-coin page: its Claim card offers "Set me up" (apps/web/src/features/trade-sepolia/ClaimCard.tsx). */
export const SET_UP_PATH = '/test-coins';

/**
 * SH-280 STEP 2: one place per screen. A screen with several write gates and no wallet says it once, in the last of them
 * (document order); the others stay empty.
 */
const places = new Set<HTMLElement>();
const placeListeners = new Set<() => void>();
const placesChanged = () => { for (const l of [...placeListeners]) l(); };
const lastPlace = (): HTMLElement | null => {
  let last: HTMLElement | null = null;
  for (const el of places) if (last === null || last.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) last = el;
  return last;
};
const subscribePlaces = (l: () => void) => { placeListeners.add(l); return () => { placeListeners.delete(l); }; };

/** What stands where the button would: the way to a wallet (the platform's), and the browser-wallet line. */
export function NoWallet({ signIn, pending = false }: { signIn: SiteSignIn; pending?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    places.add(el);
    placesChanged();
    return () => { places.delete(el); placesChanged(); };
  }, []);
  const last = useSyncExternalStore(subscribePlaces, () => lastPlace(), () => null);
  // Before the page has laid out its places (and on the server) the first render says it; then only the last place.
  const speaks = last === null || last === ref.current;
  const quiet = signIn.state === 'checking' || pending;
  return (
    <span ref={ref} className="nowallet" data-testid={speaks ? 'no-wallet' : 'no-wallet-quiet'} data-signin={signIn.state}>
      {speaks && !quiet && signIn.state === 'on' ? (
        signIn.handle === null ? (
          <a className="btn btn-primary" href={JOIN_PATH} data-testid="join">
            {NO_WALLET_WORDS.signIn}
          </a>
        ) : (
          <a className="btn btn-primary" href={SET_UP_PATH} data-testid="set-up">
            {NO_WALLET_WORDS.setUp}
          </a>
        )
      ) : null}
      {speaks && !quiet ? <span className="muted small">{NO_WALLET_WORDS.noBrowserWallet}</span> : null}
    </span>
  );
}

export function WalletBar() {
  const w = useWallet();
  const { config } = useApp();
  const signIn = useSiteSignIn();
  const [problem, setProblem] = useState<string | null>(null);
  if (!w.present) return <div className="walletbar"><NoWallet signIn={signIn} pending={w.pending} /></div>;
  const act = (f: () => Promise<void>) => () => {
    setProblem(null);
    f().catch((e) => setProblem(decodeError(e).sentence));
  };
  return (
    <div className="walletbar">
      {!w.account ? (
        <button type="button" className="btn btn-primary" onClick={act(w.connect)} data-testid="connect">
          Connect wallet
        </button>
      ) : !w.onRightChain ? (
        <button type="button" className="btn btn-primary" onClick={act(w.ensureChain)} data-testid="switch-chain">
          Switch to {chainFor(config).name}
        </button>
      ) : (
        <span className="pill mono" data-testid="account">
          {shortAddress(w.account)}
        </span>
      )}
      {problem ? <span className="muted small">{problem}</span> : null}
    </div>
  );
}

/** For a write: returns null when the wallet is ready, else the one button that makes it ready. */
export function useWriteGate(): { ready: boolean; gate: ReactElement | null } {
  const w = useWallet();
  const { config } = useApp();
  const signIn = useSiteSignIn();
  // SH-280: no wallet here is not an empty frame: the way to one (the site's sign-in, a browser wallet).
  if (!w.present) return { ready: false, gate: <NoWallet signIn={signIn} pending={w.pending} /> };
  if (!w.account)
    return {
      ready: false,
      gate: (
        <button type="button" className="btn btn-primary" onClick={() => void w.connect().catch(() => undefined)}>
          Connect wallet
        </button>
      ),
    };
  if (!w.onRightChain)
    return {
      ready: false,
      gate: (
        <button type="button" className="btn btn-primary" onClick={() => void w.ensureChain().catch(() => undefined)}>
          Switch to {chainFor(config).name}
        </button>
      ),
    };
  return { ready: true, gate: null };
}

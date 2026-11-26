import BRIDGE from 'virtual:privy-bridge';
import type { SiteSignIn } from './site-signin';
import type { MadeWallet } from './privy-made';

/**
 * SH-280 STEP 2: when the launch page loads Privy at all. Only where the site's sign-in is on AND Privy's own sign-in
 * token is in this browser (`privy:token`, apps/web/src/features/alpha-sepolia/privy-storage.ts): every other visitor
 * downloads nothing of Privy, and nothing asks any wallet anything on load.
 */
export const PRIVY_TOKEN_ITEM = 'privy:token';

/** The site's Privy app id (vite.config.ts takes it from the platform's own file), or null without one. */
export const PRIVY_APP_ID: string | null = import.meta.env.PILE_PRIVY_APP_ID && /^[a-z0-9]{20,40}$/.test(import.meta.env.PILE_PRIVY_APP_ID) ? import.meta.env.PILE_PRIVY_APP_ID : null;
/** The development server's stand-in for Privy (vite.config.ts: `PILE_PRIVY_STANDIN=1`, never in a build). */
const STANDIN = import.meta.env.PILE_PRIVY_STANDIN === true;

export function shouldLoadPrivy(signIn: SiteSignIn, storage: Pick<Storage, 'getItem'> | null, appId: string | null = PRIVY_APP_ID, standin = STANDIN): boolean {
  if (signIn.state !== 'on') return false;
  if (standin) return true;
  if (appId === null || storage === null) return false;
  try { return storage.getItem(PRIVY_TOKEN_ITEM) !== null; } catch { return false; }
}

/**
 * Privy's code (the bridge, a build of its own: build/privy-bridge.ts, its address relative to the page), or the
 * stand-in in the development server opted in for the browser tests.
 */
export const loadMadeWallet = (): Promise<MadeWallet | null> => (STANDIN
  ? import('./privy-standin').then((module) => module.madeWallet())
  : PRIVY_APP_ID === null ? Promise.resolve(null)
    : (import(/* @vite-ignore */ new URL(BRIDGE, document.baseURI).href) as Promise<typeof import('./privy-made')>).then((module) => module.madeWallet(PRIVY_APP_ID as string)));

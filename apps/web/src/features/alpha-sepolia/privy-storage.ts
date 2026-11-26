/**
 * F161 (4), SH-ALPHA-SITE: what the Sepolia alpha's sign-in keeps in the browser besides the app's own items
 * (features/legal/privacy.ts `STORED_ON_DEVICE`, which lists these in Sepolia trade builds only):
 * - our server's sign-in cookie, `__Host-alpha_session` (infra/server/services/alpha/auth.mjs `COOKIE`): HttpOnly, so
 *   no page script can read it; seven days;
 * - Privy's own items (`@privy-io/react-auth` 3.51.0 writes them, not our code), as the alpha-access suite's run of the
 *   real SDK found them on this site at each step of a sign-in, with Privy's service stood in
 *   (e2e/alpha-access/privy-sdk.spec.mjs, docs/evidence/SH-ALPHA-SITE/privy-storage-*.json): each key is the SDK's own
 *   (privy-storage.test.ts finds each one in the installed SDK; `<…>` marks the part that varies). `privy:connections`
 *   is the one the run cannot show: the SDK writes it once Privy's wallet frame reports the wallets (the suite's frame
 *   reports none). Privy's cookie copies of its tokens are off (privy-live.tsx `cookieWriteBehavior: 'never'`, which
 *   Privy's provider honours with build/privy-fixes.ts), so none of these is sent to our server; the page itself sends
 *   us the identity token once, at sign-in.
 */
import type { StoredItem } from '../legal/privacy';

const PRIVY_SOURCE = 'apps/web/src/features/alpha-sepolia/privy-storage.ts';
const privy = (key: string, store: StoredItem['store'], what: string): StoredItem => Object.freeze({ key, store, what, source: PRIVY_SOURCE, writer: 'privy' as const });

/** Our server's sign-in cookie (alpha/auth.mjs: `__Host-alpha_session`, HttpOnly, Secure, SameSite=Lax, seven days). */
export const ALPHA_SESSION_COOKIE: StoredItem = Object.freeze({
  key: '__Host-alpha_session',
  store: 'cookie',
  what: 'Your alpha sign-in for seven days: a random number our server checks with each page. Your browser sends it to our server; no page can read it. Sign out removes it.',
  source: 'infra/server/services/alpha/auth.mjs',
  writer: 'server',
});

/** Privy's items, as the SDK names them. */
export const PRIVY_BROWSER_STORAGE: readonly StoredItem[] = Object.freeze([
  privy('privy:token', 'localStorage', 'Privy’s sign-in token for this browser, renewed every hour.'),
  privy('privy:refresh_token', 'localStorage', 'Privy’s token that renews that sign-in.'),
  privy('privy:id_token', 'localStorage', 'Privy’s identity token: your X account’s number, handle, name and picture. The page sends it to our server once, at sign-in.'),
  privy('privy:pat', 'localStorage', 'Privy’s own access token for its service.'),
  privy('privy:caid', 'localStorage', 'A random number Privy uses to tell this browser apart.'),
  privy('privy:connections', 'localStorage', 'Which wallets Privy has connected on this browser.'),
  privy('privy:<app ID>:recent-login-method', 'localStorage', 'How you last signed in through Privy here (X). It stays after you sign out.'),
  privy('privy:sent:<app ID>:<number>', 'localStorage', 'That this browser already sent Privy its one start-up report. It stays after you sign out.'),
  privy('privy:state_code', 'localStorage', 'During an X sign-in only: Privy’s one-time check for it.'),
  privy('privy:code_verifier', 'localStorage', 'During an X sign-in only: Privy’s one-time secret for it.'),
  privy('privy:headless_oauth', 'localStorage', 'During an X sign-in only: that it started on this page.'),
]);

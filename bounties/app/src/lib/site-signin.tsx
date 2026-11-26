import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * SH-280: the site's own sign-in with X (the platform's alpha: apps/web/src/features/alpha-sepolia), as this page learns
 * it. The page asks the platform's sign-in service once on load, `GET /alpha/me` on its own origin (the same request the
 * platform's shell makes, apps/web/src/features/alpha-sepolia/welcome-gate.ts `welcomeVisitor`; the browser sends the
 * service's own cookie, which this page never reads), and decides:
 * - 200 with a well-formed answer: the sign-in is on, and this browser is signed in (the account's X handle);
 * - 401: the sign-in is on, nobody is signed in here;
 * - anything else (the stack's switch off, so the site's own page answers, or no answer): the sign-in is off.
 * It asks nothing of any wallet. The page never signs anyone in or out: the platform's join page does.
 */
export type SiteSignIn =
  | { readonly state: 'checking' }
  | { readonly state: 'off' }
  | { readonly state: 'on'; readonly handle: string | null };

/** The platform's join page (its own build at the site's `/join`; apps/web/build/alpha-pages.ts). */
export const JOIN_PATH = '/join';
/** The sign-in service's "who is signed in here" (same origin). */
export const ME_PATH = '/alpha/me';

const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/** Reads the answer of `/alpha/me` (apps/web/src/features/alpha-sepolia/alpha-api.ts checks the same shape). */
export async function readSiteSignIn(fetcher: typeof fetch = fetch): Promise<Exclude<SiteSignIn, { state: 'checking' }>> {
  let response: Response;
  try {
    response = await fetcher(ME_PATH, { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
  } catch {
    return { state: 'off' };
  }
  const json = (response.headers.get('content-type') ?? '').includes('application/json');
  if (!json) return { state: 'off' };
  if (response.status === 401) return { state: 'on', handle: null };
  if (response.status !== 200) return { state: 'off' };
  try {
    const value = (await response.json()) as { status?: unknown; handle?: unknown };
    const handle = typeof value.handle === 'string' && HANDLE.test(value.handle) ? value.handle : null;
    if (handle === null || !['pending', 'approved', 'removed'].includes(String(value.status))) return { state: 'off' };
    return { state: 'on', handle };
  } catch {
    return { state: 'off' };
  }
}

const SiteSignInContext = createContext<SiteSignIn>({ state: 'off' });

export const useSiteSignIn = (): SiteSignIn => useContext(SiteSignInContext);

/** Asks once per page load; `initial` is for the tests. */
export function SiteSignInProvider({ children, initial, fetcher }: { children: ReactNode; initial?: SiteSignIn; fetcher?: typeof fetch }) {
  const [value, setValue] = useState<SiteSignIn>(initial ?? { state: 'checking' });
  useEffect(() => {
    if (initial) return undefined;
    let live = true;
    void readSiteSignIn(fetcher).then((answer) => { if (live) setValue(answer); });
    return () => { live = false; };
  }, [initial, fetcher]);
  return <SiteSignInContext.Provider value={value}>{children}</SiteSignInContext.Provider>;
}

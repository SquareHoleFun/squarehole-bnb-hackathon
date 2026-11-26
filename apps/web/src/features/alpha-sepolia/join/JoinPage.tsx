/**
 * F161 (4), SH-ALPHA-SITE, work package L: the Sepolia alpha's public join page (`/join`, its own build:
 * build/alpha-pages.ts). Strangers and pending accounts only ever get this page: our server's page lock (Caddy's
 * `forward_auth` on `/alpha/check`) sends every other request here until the founder approves their X account
 * (docs/design/alpha-access-privy.md § 5, "The page lock"). It shows:
 * - to a stranger: the test network notice, its box to tick and "Sign in with X" (Privy, loaded lazily on the press);
 * - after sign-in: "You're on the list" with the handle (pending), the way into the app (approved), or "Your access has
 *   ended" (removed); and in each, sign-out and the made wallet's export, which stays here for removed testers too.
 * The sign-in goes to X and comes back here, where Privy finishes it; the page then sends Privy's identity token to our
 * server once (`POST /alpha/session`, header `privy-id-token`), which sets our own 7-day sign-in cookie. The page reads
 * where it stands from `/alpha/me` on every load; it never reads the cookie.
 *
 * Minimal text (the founder's rule): one status line, the actions, the notice behind its box. Privy's code never sits
 * in this page's first paint: the door below loads it, behind the trade literal (build-target.test.ts pins the door).
 */
import { useEffect, useId, useRef, useState } from 'react';
import { TermsText } from '../../legal/TermsText';
import { STORED_ON_DEVICE } from '../../legal/privacy';
import { termsAcceptance, type TermsAcceptanceStore } from '../../legal/terms-acceptance';
import { TEST_NETWORK_NOTICE } from '../../legal/test-network';
import { StoredItems } from '../../../pages/stored-items';
import { alphaApi, type AlphaApi, type AlphaMe, type Intake } from '../alpha-api';
import { JOIN_WORDS, refusalLine } from '../alpha-words';
import { JOIN_THEN_EXPORT, returnedFromSignIn, staysOnJoin, type PrivyBridge } from '../privy-bridge';
import { privyAppIdOf } from '../privy-config';

/**
 * The join page's door into the trade folder (F156, SH-ALPHA-SITE): Privy's bridge, lazily, in builds with the trade
 * literal only. The third door of build-target.test.ts's pin, after the box page's slot (TradeSlotMount.tsx) and the
 * test-coin route (routes.tsx); it opens privy-load.ts, never the trade box.
 */
const LOAD_PRIVY = import.meta.env?.SH_SEPOLIA_TRADE === true ? (appId: string) => import('../../trade-sepolia/privy-load').then((module) => module.loadPrivyBridge(appId)) : null;

type View =
  | { readonly kind: 'loading' }
  | { readonly kind: 'stranger' }
  | { readonly kind: 'finishing' }
  | { readonly kind: 'member'; readonly me: AlphaMe };

export interface JoinPageProps {
  /** Test seam: our server (the browser's own same-origin requests otherwise). */
  readonly api?: AlphaApi;
  /** Test seam: Privy (the door above otherwise; null when this build has none). */
  readonly loadPrivy?: ((appId: string) => Promise<PrivyBridge>) | null;
  /** Test seam: the Privy app ID (privy-config.ts otherwise; null while it is the placeholder). */
  readonly appId?: string | null;
  /** Test seam: where the page is and where it goes. */
  readonly page?: { readonly search: string; readonly assign: (url: string) => void; readonly replace: (url: string) => void };
  /** Test seam: where the notice's acceptance is kept (the app's own store otherwise, so its gate is passed). */
  readonly acceptance?: TermsAcceptanceStore;
}

/**
 * The design's square-hole mark (packages/design/src/art/SquareHoleGlyph.tsx), drawn here: the design package's own
 * entry brings its art registry along, whose pictures this page does not show.
 */
function Mark() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
      <rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="none" stroke="currentColor" strokeWidth="1.75" />
      <rect x="8" y="8" width="8" height="8" rx="1.5" fill="currentColor" opacity="0.55" />
    </svg>
  );
}

const browserPage = () => ({ search: window.location.search, assign: (url: string) => window.location.assign(url), replace: (url: string) => window.history.replaceState(null, '', url) });

export function JoinPage({ api = alphaApi(), loadPrivy = LOAD_PRIVY, appId = privyAppIdOf(), page = browserPage(), acceptance = termsAcceptance }: JoinPageProps) {
  const [view, setView] = useState<View>({ kind: returnedFromSignIn(page.search) ? 'finishing' : 'loading' });
  const [line, setLine] = useState<string | null>(null);
  const [busy, setBusy] = useState<'sign-in' | 'sign-out' | 'export' | null>(null);
  const [intake, setIntake] = useState<Intake | null>(null);
  const [agreed, setAgreed] = useState(false);
  // Privy's sign-in in this browser has lapsed while ours is still on: the member view offers the sign-in. Known from
  // the export here, or from the Claim card's link (JOIN_THEN_EXPORT) before the trip to X (XR-ALPHA-SITE af3).
  const [privyLapsed, setPrivyLapsed] = useState(() => staysOnJoin(page.search) && !returnedFromSignIn(page.search));
  const headingRef = useRef<HTMLHeadingElement>(null);
  const agreeId = useId();
  const signInAvailable = loadPrivy !== null && appId !== null;
  const bridge = useRef<Promise<PrivyBridge> | null>(null);
  const privy = (): Promise<PrivyBridge> => {
    if (!loadPrivy || !appId) return Promise.reject(new Error('no Privy in this build'));
    bridge.current ??= loadPrivy(appId);
    return bridge.current;
  };

  // Where a load or a sign-in leaves the page: a signed-in account's view, or straight into the app after a fresh
  // sign-in that our server approved.
  const arrive = (me: AlphaMe, fresh: boolean) => {
    if (fresh && me.status === 'approved' && !staysOnJoin(page.search)) {
      page.assign('/');
      return;
    }
    if (staysOnJoin(page.search)) page.replace('/join');
    setView({ kind: 'member', me });
  };

  // Once per page load (StrictMode's second effect run awaits the same work instead of starting it again).
  const boot = useRef<Promise<{ readonly me: AlphaMe | null; readonly fresh: boolean; readonly line: string | null }> | null>(null);
  useEffect(() => {
    let live = true;
    boot.current ??= (async () => {
      const availability = await api.intake();
      if (availability.ok) setIntake(availability.value);
      if (returnedFromSignIn(page.search)) {
        // X sent the visitor back: Privy finishes the sign-in, then our server gets its identity token once.
        let token: string | null;
        try { token = await (await privy()).finishSignIn(); } catch { token = null; }
        if (token === null) return { me: null, fresh: true, line: 'Sign-in did not complete. Try again.' };
        const session = await api.session(token);
        return session.ok ? { me: session.value, fresh: true, line: null } : { me: null, fresh: true, line: refusalLine(session) };
      }
      const me = await api.me();
      if (me.ok) return { me: me.value, fresh: false, line: null };
      return { me: null, fresh: false, line: me.status === 401 ? null : refusalLine(me) };
    })();
    void boot.current.then(({ me, fresh, line: said }) => {
      if (!live) return;
      setLine(said);
      if (me) arrive(me, fresh);
      else setView({ kind: 'stranger' });
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per page load
  }, []);

  useEffect(() => {
    if (view.kind === 'member' || view.kind === 'stranger') headingRef.current?.focus({ preventScroll: true });
  }, [view.kind]);

  async function signIn() {
    if (!agreed) { setLine(JOIN_WORDS.agreeFirst); return; }
    setBusy('sign-in');
    setLine(null);
    // Recheck immediately before loading Privy: a previously open page must respect a newly closed intake.
    const availability = await api.intake();
    setIntake(availability.ok ? availability.value : null);
    if (!availability.ok || (!availability.value.open && !availability.value.returning)) {
      setLine(availability.ok ? JOIN_WORDS.closed : JOIN_WORDS.intakeUnknown); setBusy(null); return;
    }
    // The box ticked is the notice accepted: the app's gate reads the same record and asks nothing more.
    acceptance.accept();
    try {
      const privyBridge = await privy();
      await privyBridge.ready();
      if (privyBridge.authenticated()) {
        // Privy still holds this browser's X sign-in: its identity token goes to our server without a trip to X.
        const token = await privyBridge.identityToken();
        if (token !== null) {
          const session = await api.session(token);
          if (session.ok) { arrive(session.value, true); setBusy(null); return; }
          setLine(refusalLine(session));
          setBusy(null);
          return;
        }
      }
      await privyBridge.signIn();
    } catch {
      setLine('Sign-in could not start. Try again.');
      setBusy(null);
    }
  }

  /**
   * The member view's "Sign in with X": Privy's sign-in again, back to this page (JOIN_THEN_EXPORT). The return from X
   * renews our own sign-in too: the boot above sends Privy's fresh identity token to our server once, and its
   * `/alpha/session` issues a new 7-day cookie (infra/server/services/alpha-api.mjs).
   */
  async function renewPrivy() {
    setBusy('sign-in');
    setLine(null);
    try {
      const privyBridge = await privy();
      await privyBridge.ready();
      if (privyBridge.authenticated()) { setPrivyLapsed(false); setBusy(null); return; }
      page.replace(JOIN_THEN_EXPORT);
      await privyBridge.signIn();
    } catch {
      setLine('Sign-in could not start. Try again.');
      setBusy(null);
    }
  }

  async function signOut() {
    setBusy('sign-out');
    setLine(null);
    const result = await api.signOut();
    // Privy's own session in this browser ends too (only where Privy runs in this build); if it did not, the line says
    // so rather than "Signed out." for both.
    let privyEnded = true;
    if (signInAvailable) { try { await (await privy()).signOut(); } catch { privyEnded = false; } }
    setBusy(null);
    if (result.ok) { const availability = await api.intake(); setIntake(availability.ok ? availability.value : null); setView({ kind: 'stranger' }); setAgreed(false); setLine(privyEnded ? JOIN_WORDS.signedOut : JOIN_WORDS.signedOutHere); }
    else setLine(refusalLine(result));
  }

  async function exportKey() {
    setBusy('export');
    setLine(null);
    try {
      const privyBridge = await privy();
      await privyBridge.ready();
      if (!privyBridge.authenticated()) { setPrivyLapsed(true); setLine(JOIN_WORDS.exportSignIn); }
      else if ((await privyBridge.madeWallet()) === null) setLine(JOIN_WORDS.noMadeWallet);
      else await privyBridge.exportWallet();
    } catch {
      setLine(JOIN_WORDS.exportFailed);
    }
    setBusy(null);
  }

  const notice = TEST_NETWORK_NOTICE;
  const lineUi = line ? <p className="sh-join__line" role="status">{line}</p> : null;
  // SH-220: under each row with "Sign in with X": X's own login page asks a phone for the X login. Shown on phones only,
  // by join.css's `(pointer: coarse)`; elsewhere `display: none`, so neither seen nor announced.
  const phoneLine = <p className="sh-join__subtle sh-join__phone">{JOIN_WORDS.phoneLogin}</p>;
  const noticeBody = (
    <>
      <div className="sh-join__notice" role="region" aria-label="Test network notice" tabIndex={0}>
        <p className="sh-join__lede">{notice.lede}</p>
        <ul className="sh-join__points">
          {notice.points.map((point) => <li key={point}><TermsText text={point} /></li>)}
        </ul>
      </div>
      <details className="sh-join__details">
        <summary>{notice.privacy.title}</summary>
        <ul className="sh-legal__bullets">
          {notice.privacy.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}
        </ul>
        <details className="sh-join__details">
          <summary>{notice.privacy.deviceTitle}</summary>
          <p>{notice.privacy.device}</p>
          <StoredItems items={STORED_ON_DEVICE} />
        </details>
      </details>
    </>
  );
  const footer = (
    <p className="sh-join__meta">
      <span>{notice.versionLine}</span>
      {import.meta.env?.SH_PRODUCTION ? <> · <a href="/join/assets/third-party-notices.txt">{JOIN_WORDS.thirdParty}</a></> : null}
    </p>
  );

  return (
    <main className="sh-join" data-view={view.kind}>
      <section className="sh-join__card sh-panel" aria-labelledby="join-title">
        <header className="sh-join__header">
          <span className="sh-join__mark" aria-hidden="true"><Mark /></span>
          <div>
            <h1 id="join-title" ref={headingRef} tabIndex={-1} className="sh-join__title">{JOIN_WORDS.title}</h1>
            <p className="sh-join__status">{notice.gate.status}</p>
          </div>
        </header>

        {view.kind === 'loading' ? <p className="sh-join__line" aria-busy="true">{JOIN_WORDS.checking}</p> : null}
        {view.kind === 'finishing' ? <p className="sh-join__line" aria-busy="true">{JOIN_WORDS.signingIn}</p> : null}

        {view.kind === 'stranger' ? (
          <>
            {noticeBody}
            {signInAvailable && intake && (intake.open || intake.returning) ? (
              <>
                <label className="sh-join__check" htmlFor={agreeId}>
                  <input id={agreeId} type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.currentTarget.checked)} />
                  <span>{notice.gate.checkbox}</span>
                </label>
                <div className="sh-join__actions">
                  <button type="button" className="sh-button sh-button--primary sh-join__x" disabled={!agreed || busy !== null} aria-busy={busy === 'sign-in' || undefined} onClick={() => void signIn()}>
                    {busy === 'sign-in' ? JOIN_WORDS.signingIn : JOIN_WORDS.signIn}
                  </button>
                </div>
                {phoneLine}
              </>
            ) : <p className="sh-join__line" role="status">{line ?? (!signInAvailable ? JOIN_WORDS.notSetUp : intake ? JOIN_WORDS.closed : JOIN_WORDS.intakeUnknown)}</p>}
            {signInAvailable && intake && (intake.open || intake.returning) ? lineUi : null}
          </>
        ) : null}

        {view.kind === 'member' ? (
          <>
            <div className="sh-join__state" data-status={view.me.status}>
              <p className="sh-join__big">{view.me.status === 'pending' ? JOIN_WORDS.pending : view.me.status === 'approved' ? JOIN_WORDS.approved : JOIN_WORDS.removed}</p>
              <p className="sh-join__handle">@{view.me.handle}</p>
              {view.me.status === 'pending' ? <p className="sh-join__subtle">{JOIN_WORDS.pendingHint}</p> : null}
              {view.me.status === 'removed' ? <p className="sh-join__subtle">{JOIN_WORDS.removedHint}</p> : null}
            </div>
            {view.me.status === 'approved' ? (
              <div className="sh-join__actions">
                <a className="sh-button sh-button--primary" href="/">{JOIN_WORDS.openApp}</a>
                <a className="sh-button" href="/test-coins">{JOIN_WORDS.claim}</a>
              </div>
            ) : null}
            <div className="sh-join__actions sh-join__actions--quiet">
              {signInAvailable && privyLapsed ? (
                <button type="button" className="sh-button sh-button--primary sh-join__x" disabled={busy !== null} aria-busy={busy === 'sign-in' || undefined} onClick={() => void renewPrivy()}>
                  {busy === 'sign-in' ? JOIN_WORDS.signingIn : JOIN_WORDS.signIn}
                </button>
              ) : null}
              {signInAvailable ? (
                <button type="button" className="sh-button" disabled={busy !== null} aria-busy={busy === 'export' || undefined} onClick={() => void exportKey()}>{JOIN_WORDS.exportWallet}</button>
              ) : null}
              <button type="button" className="sh-button" disabled={busy !== null} aria-busy={busy === 'sign-out' || undefined} onClick={() => void signOut()}>{JOIN_WORDS.signOut}</button>
            </div>
            {signInAvailable && privyLapsed ? phoneLine : null}
            {lineUi}
            <details className="sh-join__details">
              <summary>{notice.title}</summary>
              {noticeBody}
            </details>
          </>
        ) : null}

        {footer}
      </section>
    </main>
  );
}

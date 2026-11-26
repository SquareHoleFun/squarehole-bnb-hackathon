import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Link, Outlet, useLocation, useNavigationType } from 'react-router';
import { TEST_NETWORK_LINK } from '../features/legal';
import { DATA_LABELS, useDataSource } from '../features/data-source';
import { useMotionPreferenceEffect } from '../features/settings';
import { PAGE_TITLE_ID } from '../pages/page-parts';
import { AlphaWelcomeMount } from './AlphaWelcomeMount';
import { goToSection, hashTarget } from './hash-target';
import { cancelHeadingFocus, requestHeadingFocus } from './heading-focus';
import { FEED_SEARCH_ID, focusSearchIfRequested } from './search-focus';
import { SideNav } from './SideNav';
import { TopBar } from './TopBar';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;
// F156 (2), SH-ALPHA-SITE: the Sepolia alpha's box pages buy and sell test tokens (the trade literal, build-target.ts).
const SEPOLIA_TRADE_BUILD = import.meta.env?.SH_SEPOLIA_TRADE === true;

const MAIN_ID = 'main';

/**
 * The footer's facts for the current data source, a few words each (text diet, 2026-10-01). The top bar's badge already
 * says Local chain / Testnet (the sample data has none, F130); About & risks says the rest in full.
 */
const FOOTER_FACTS: Readonly<Record<'demo' | 'local' | 'sepolia' | 'twin', readonly string[]>> = {
  demo: DEMO_BUILD ? ['Not audited', 'No in-app trading'] : [],
  local: DEMO_BUILD ? ['Local chain 31337', 'Test tokens only', 'Not audited', 'No in-app trading'] : [],
  sepolia: [DATA_LABELS.sepolia, 'Test tokens only', 'Not audited', SEPOLIA_TRADE_BUILD ? 'Test trades only' : 'No in-app trading'],
  // The local source as core v1's Sepolia twin (S10a): read only, never offered to a wallet.
  twin: DEMO_BUILD ? ['Local chain (Sepolia twin)', 'Read only', 'Not audited', 'No in-app trading'] : [],
};

/** App frame: skip link, top bar, primary navigation, main landmark and the footer for the current data source. */
export function Shell() {
  useMotionPreferenceEffect();
  const { id, coreTwin } = useDataSource();
  const location = useLocation();
  const navigationType = useNavigationType();
  // Any navigation (link, search, Back/Forward) closes the compact menu. Resetting on every location change, rather
  // than remembering where it was opened, means returning to that history entry never reopens it.
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuLocationKey, setMenuLocationKey] = useState(location.key);
  if (menuLocationKey !== location.key) {
    setMenuLocationKey(location.key);
    setMenuOpen(false);
  }
  const toggleRef = useRef<HTMLButtonElement>(null);
  const lastPathname = useRef(location.pathname);
  const firstLocation = useRef(true);

  // After a client-side page change, move focus to the new page's heading so it is announced, or to the feed search
  // when the header search trigger asked for it. A new page (link, not Back/Forward) opens at the top; `preventScroll`
  // leaves Back/Forward scroll restoration alone. A lazy page still loading has no heading yet: it takes the request
  // over once it has rendered (heading-focus.ts, `lazyRoute`). SH-SITE-FIXES-10: a link to a section of the page
  // (`/about/terms#terms-6`) opens at that section instead, its heading focused: on arrival, on a direct load or a
  // reload, and from another section of the same page (hash-target.ts).
  useEffect(() => {
    const first = firstLocation.current;
    firstLocation.current = false;
    const pageChanged = lastPathname.current !== location.pathname;
    lastPathname.current = location.pathname;
    const section = first || navigationType !== 'POP' ? hashTarget(location.hash) : null;
    if (section) {
      cancelHeadingFocus();
      goToSection(section);
      return;
    }
    if (!pageChanged) return;
    cancelHeadingFocus();
    if (navigationType !== 'POP') window.scrollTo(0, 0);
    // A lazy page (the box feed) may already have taken a search focus request over itself.
    if (focusSearchIfRequested() || document.activeElement?.id === FEED_SEARCH_ID) return;
    const heading = document.getElementById(PAGE_TITLE_ID);
    if (heading) heading.focus({ preventScroll: true });
    else requestHeadingFocus();
  }, [location.key, location.pathname, location.hash, navigationType]);

  function skipToMain(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    document.getElementById(MAIN_ID)?.focus();
  }

  function closeMenu() {
    setMenuOpen(false);
    const toggle = toggleRef.current;
    if (toggle) toggle.focus();
  }

  return (
    <div className="sh-app">
      <a className="sh-skip-link" href={`#${MAIN_ID}`} onClick={skipToMain}>
        Skip to content
      </a>
      <TopBar menuOpen={menuOpen} onToggleMenu={() => setMenuOpen(!menuOpen)} onCloseMenu={closeMenu} toggleRef={toggleRef} />
      <SideNav open={menuOpen} onClose={closeMenu} />
      <main id={MAIN_ID} className="sh-main" tabIndex={-1}>
        {/* F166: the Sepolia alpha's welcome step ("Set me up"), above every page; nothing in any other build. */}
        <AlphaWelcomeMount />
        <Outlet />
      </main>
      <footer className="sh-footer">
        <p>
          {FOOTER_FACTS[coreTwin ? 'twin' : id].join(' · ')} · <Link to="/about/risks">About &amp; risks</Link> ·{' '}
          {/* The Sepolia test site has one legal text, the test network notice (SH-TA-02). */}
          {TEST_NETWORK_LINK ? (
            <Link to="/about/terms">{TEST_NETWORK_LINK}</Link>
          ) : (
            <>
              <Link to="/about/terms">Terms of use</Link> · <Link to="/about/privacy">Privacy</Link>
            </>
          )}
        </p>
      </footer>
    </div>
  );
}

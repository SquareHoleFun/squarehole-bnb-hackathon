import { useEffect, useRef, useState, type ReactNode } from 'react';
import logo from '../assets/logo-tile.webp';
import { shortAddress } from '../lib/chain';
import { decodeError } from '../lib/errors';
import { JOIN_PATH, useSiteSignIn } from '../lib/site-signin';
import { useWallet } from '../lib/wallet';
import { NO_WALLET_WORDS } from './WalletBar';

/** The launch app's links to the platform, with the icons from apps/web/src/shell/icons.tsx. */
const NAV = [
  { id: 'boxes', label: 'Boxes', to: '/' },
  { id: 'launch', label: 'Launch', to: '/create' },
  { id: 'test-coins', label: 'Test coins', to: '/test-coins' },
  { id: 'settings', label: 'Settings', to: '/settings' },
  { id: 'risks', label: 'About & risks', to: '/about/risks' },
] as const;
type CurrentEntry = 'boxes' | 'launch';

const Icon = ({ children }: { children: ReactNode }) => (
  <svg
    className="sh-icon"
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {children}
  </svg>
);
const MenuIcon = () => (
  <Icon>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);
const CloseIcon = () => (
  <Icon>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);
const NAV_ICONS: Record<(typeof NAV)[number]['id'], () => ReactNode> = {
  boxes: () => (
    <Icon>
      <path d="M3 8l9-4 9 4-9 4z" />
      <path d="M3 8v8l9 4 9-4V8M12 12v8" />
    </Icon>
  ),
  launch: () => (
    <Icon>
      <path d="M3.5 8.5 12 4.5l8.5 4v8L12 20.5l-8.5-4z" />
      <path d="M3.5 8.5 12 12.5l8.5-4M12 12.5v8" />
      <path d="M16.5 2.5v4M14.5 4.5h4" />
    </Icon>
  ),
  'test-coins': () => (
    <Icon>
      <circle cx="10" cy="13" r="7" />
      <path d="M10 10v6M8 11.5h3a1.5 1.5 0 0 1 0 3H8" />
      <path d="M19 3.5c1.2 1.6 2 2.8 2 3.8a2 2 0 0 1-4 0c0-1 .8-2.2 2-3.8z" />
    </Icon>
  ),
  settings: () => (
    <Icon>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
    </Icon>
  ),
  risks: () => (
    <Icon>
      <path d="M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z" />
      <path d="M12 8v4.5M12 16h.01" />
    </Icon>
  ),
};

/** The navigation's entries, as the platform's side bar draws them. */
function NavList({ current }: { current?: CurrentEntry }) {
  return (
    <ul className="sh-nav__list">
      {NAV.map((i) => {
        const NavIcon = NAV_ICONS[i.id];
        return (
          <li key={i.to}>
            <a className="sh-nav__link" href={i.to} aria-current={i.id === current ? 'page' : undefined}>
              <NavIcon />
              <span className="sh-nav__label">{i.label}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

const WalletIcon = () => (
  <Icon>
    <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3" />
    <rect x="4" y="8" width="16" height="11" rx="2" />
    <path d="M16 13.5h.01" />
  </Icon>
);

/** SH-280: the platform's sign-in entry's icon (apps/web/src/shell/icons.tsx `SignInIcon`, an arrow into a door). */
const SignInIcon = () => (
  <Icon>
    <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
    <path d="M10 16l4-4-4-4" />
    <path d="M14 12H4" />
  </Icon>
);

/** The platform's names for the two wallets (its wallet window and made-wallet.ts). */
const MADE_WALLET_NAME = 'Wallet Privy made';
export const OTHER_WALLET_WORDS = Object.freeze({ browser: 'Connect a browser wallet', made: MADE_WALLET_NAME });

/** SH-280: the wallet place's other choice: the browser wallet while the made one is in use, and back. */
function OtherWallet() {
  const w = useWallet();
  if (w.other === null) return null;
  const label = OTHER_WALLET_WORDS[w.other];
  return (
    <button type="button" className="sh-wallet-button sh-wallet-button--other" aria-label={label} onClick={w.useOther} data-testid="other-wallet">
      <WalletIcon />
      <span className="sh-wallet-button__text">{label}</span>
    </button>
  );
}

function BarSignIn() {
  const w = useWallet();
  const signIn = useSiteSignIn();
  if (w.present || w.pending || signIn.state !== 'on' || signIn.handle !== null) return null;
  return (
    <a className="sh-topbar__join" href={JOIN_PATH} data-testid="bar-join">
      <span className="sh-topbar__join-icon"><SignInIcon /></span>
      <span className="sh-topbar__join-text">{NO_WALLET_WORDS.signIn}</span>
    </a>
  );
}

function WalletButton() {
  const w = useWallet();
  const [, setProblem] = useState<string | null>(null);
  if (!w.present) return null;
  const connected = Boolean(w.account);
  const wrongNetwork = connected && !w.onRightChain;
  const short = w.account ? shortAddress(w.account) : '';
  // SH-280: the platform's names: "Wallet Privy made" (made-wallet.ts MADE_WALLET_NAME) for the made wallet.
  const name = w.kind === 'made' ? MADE_WALLET_NAME : 'Wallet';
  const onClick = () => {
    const f = !connected ? w.connect : wrongNetwork ? w.ensureChain : undefined;
    if (f) f().catch((e) => setProblem(decodeError(e).sentence));
  };
  return (
    <button
      type="button"
      className="sh-wallet-button"
      data-wrong-network={wrongNetwork || undefined}
      aria-label={connected ? `${name} ${short}${wrongNetwork ? ', wrong network' : ''}` : undefined}
      onClick={onClick}
      data-testid={connected ? (wrongNetwork ? 'switch-chain' : 'account') : 'connect'}
    >
      {connected ? (
        <>
          <span className="sh-wallet-button__compact">
            <WalletIcon />
            <span className="sh-wallet-button__dot" />
          </span>
          <span className="sh-wallet-button__name">{name}</span>
          <span className="sh-wallet-button__account sh-numeric">{short}</span>
          {wrongNetwork ? <span className="sh-wallet-button__warning">Wrong network</span> : null}
        </>
      ) : (
        <>
          <WalletIcon />
          <span className="sh-wallet-button__text">Connect wallet</span>
        </>
      )}
    </button>
  );
}

export function PlatformBar({ children, current }: { children?: ReactNode; current?: CurrentEntry }) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        toggle.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <>
      <header className="sh-topbar">
        <button
          ref={toggle}
          type="button"
          className="sh-topbar__menu sh-icon-button"
          aria-expanded={open}
          aria-controls="sh-primary-nav"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <CloseIcon /> : <MenuIcon />}
          <span className="sh-visually-hidden">Menu</span>
        </button>
        <a href="/" className="sh-brand" aria-label="Square Hole home">
          <img className="sh-brand__logo" src={logo} width={40} height={40} alt="" />
          <span className="sh-brand__text">
            <span className="sh-brand__name">Square Hole</span>
            <span className="sh-brand__tagline">Different shapes. Same hole.</span>
          </span>
        </a>
        <div className="sh-topbar__end">
          {children}
          <BarSignIn />
          <p className="sh-source-badge" data-source="sepolia">
            <span className="sh-source-badge__dot" aria-hidden="true" />
            <span>
              <strong>Testnet</strong>
              <span className="sh-source-badge__long"> · BNB Chain</span>
              <span className="sh-source-badge__short" aria-hidden="true">
                {' '}
                · BNB Chain
              </span>
            </span>
          </p>
          <WalletButton />
          <OtherWallet />
        </div>
      </header>
      <nav id="sh-primary-nav" className="sh-nav" aria-label="Primary" data-open={open} data-testid="rail">
        <NavList current={current} />
      </nav>
    </>
  );
}

export function PlatformFooter() {
  return (
    <footer className="sh-footer">
      <p>BNB Chain testnet · Test tokens only · Not audited · Test trades only · <a href="/about/risks">About &amp; risks</a> · <a href="/about/terms">Test network notice</a></p>
    </footer>
  );
}

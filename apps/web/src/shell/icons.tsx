import type { ReactNode } from 'react';
import type { NavId } from './nav-items';

/** Original 24px stroke icons. Always decorative: the adjacent text or aria-label names the control. */
function Icon({ children }: { children: ReactNode }) {
  return (
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
}

export const FeedIcon = () => (
  <Icon>
    <path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z" />
  </Icon>
);

export const LaunchIcon = () => (
  <Icon>
    <path d="M12 3c3 2 4.5 5 4.5 8.5L14 16h-4l-2.5-4.5C7.5 8 9 5 12 3z" />
    <circle cx="12" cy="9.5" r="1.6" />
    <path d="M10 16l-1.5 4M14 16l1.5 4M12 16v5" />
  </Icon>
);

export const CollectionsIcon = () => (
  <Icon>
    <rect x="4" y="4" width="7" height="7" rx="1.5" />
    <rect x="13" y="4" width="7" height="7" rx="1.5" />
    <rect x="4" y="13" width="7" height="7" rx="1.5" />
    <rect x="13" y="13" width="7" height="7" rx="1.5" />
  </Icon>
);

/** Claims: an open tray with an arrow into it (collecting what is credited, F23), deliberately not a gift box. */
export const ClaimsIcon = () => (
  <Icon>
    <path d="M4 12v6.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V12" />
    <path d="M4 12h4.5l1.5 2.5h4l1.5-2.5H20" />
    <path d="M12 3.5v7M9 7.5l3 3 3-3" />
  </Icon>
);

export const PortfolioIcon = () => (
  <Icon>
    <path d="M12 3a9 9 0 1 0 9 9h-9z" />
    <path d="M15 3.5A9 9 0 0 1 20.5 9H15z" />
  </Icon>
);

export const SettingsIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
  </Icon>
);

export const RisksIcon = () => (
  <Icon>
    <path d="M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z" />
    <path d="M12 8v4.5M12 16h.01" />
  </Icon>
);

export const SearchIcon = () => (
  <Icon>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
  </Icon>
);

/** SH-277: the open site's sign-in entry on a phone (an arrow into a door); its text stays its accessible name. */
export const SignInIcon = () => (
  <Icon>
    <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
    <path d="M10 16l4-4-4-4" />
    <path d="M14 12H4" />
  </Icon>
);

export const MenuIcon = () => (
  <Icon>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);

export const CloseIcon = () => (
  <Icon>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);

export const PlusIcon = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const BoxesIcon = () => (
  <Icon>
    <path d="M3 8l9-4 9 4-9 4z" />
    <path d="M3 8v8l9 4 9-4V8M12 12v8" />
  </Icon>
);

export const MyBoxIcon = () => (
  <Icon>
    <rect x="3" y="6" width="18" height="13" rx="2" />
    <path d="M3 10h18M16 14.5h.01" />
  </Icon>
);

/** Launch: a box with a plus (create a box). */
export const LaunchBoxIcon = () => (
  <Icon>
    <path d="M3.5 8.5 12 4.5l8.5 4v8L12 20.5l-8.5-4z" />
    <path d="M3.5 8.5 12 12.5l8.5-4M12 12.5v8" />
    <path d="M16.5 2.5v4M14.5 4.5h4" />
  </Icon>
);

/** Test coins (the Sepolia alpha's builds only, F166 af2): a coin and a drop, the faucet. */
const TestCoinsIcon = () => (
  <Icon>
    <circle cx="10" cy="13" r="7" />
    <path d="M10 10v6M8 11.5h3a1.5 1.5 0 0 1 0 3H8" />
    <path d="M19 3.5c1.2 1.6 2 2.8 2 3.8a2 2 0 0 1-4 0c0-1 .8-2.2 2-3.8z" />
  </Icon>
);

/**
 * The launch set's navigation: Boxes, Launch (create a box), My Box, Settings, About & risks. Collections, Claims and
 * Portfolio left the navigation; their icons stay for their own pages.
 */
export const NAV_ICONS: Readonly<Partial<Record<NavId, () => ReactNode>>> = {
  boxes: BoxesIcon,
  launch: LaunchBoxIcon,
  'my-box': MyBoxIcon,
  // F166 af2: a build literal, so the mainnet build holds neither the key nor the icon.
  ...(import.meta.env?.SH_SEPOLIA_TRADE === true ? { 'test-coins': TestCoinsIcon } : {}),
  settings: SettingsIcon,
  risks: RisksIcon,
};

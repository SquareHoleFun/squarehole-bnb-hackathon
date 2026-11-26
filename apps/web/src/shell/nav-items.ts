/**
 * Primary navigation (F46 launch set, SH-BOX-UI-launch; F69 C1): Boxes · Launch (create a box) · My Box (only once a
 * wallet is connected; navigation never asks for one) · Settings · About & risks. Collections, Claims and Portfolio
 * left the navigation with the launch set and every build with F134 R46B (their links open the boxes and My Box).
 * F166 af2: the Sepolia alpha's builds add Test coins (the faucet and swaps, `/test-coins`), so the page stays one
 * press away once the setup has ended; a build literal, so the mainnet build holds no such item.
 */

export type NavId = 'boxes' | 'launch' | 'my-box' | 'test-coins' | 'settings' | 'risks';

export interface NavItem {
  readonly id: NavId;
  readonly label: string;
  readonly to: string;
  /** Shown only while a wallet is connected. */
  readonly connectedOnly: boolean;
}

/** The Sepolia alpha's items (its test-coin page), or none: `false` in the mainnet build, so the branch folds away. */
const ALPHA_ITEMS: readonly NavItem[] = import.meta.env?.SH_SEPOLIA_TRADE === true
  ? [{ id: 'test-coins', label: 'Test coins', to: '/test-coins', connectedOnly: false }]
  : [];

/**
 * SH-276 B took "My Box" out where the network has no first box generation (BNB Chain testnet): it listed only that
 * generation's inventory and the claims. SH-291: My Box lists the current generation's holdings there
 * (core/v2/HoldingsV2.tsx), so every network shows it again.
 */
export const MY_BOX_SHOWN: boolean = true;

export const NAV_ITEMS: readonly NavItem[] = Object.freeze([
  { id: 'boxes', label: 'Boxes', to: '/', connectedOnly: false },
  { id: 'launch', label: 'Launch', to: '/create', connectedOnly: false },
  ...(MY_BOX_SHOWN ? [{ id: 'my-box' as const, label: 'My Box', to: '/my-box', connectedOnly: true }] : []),
  ...ALPHA_ITEMS,
  { id: 'settings', label: 'Settings', to: '/settings', connectedOnly: false },
  { id: 'risks', label: 'About & risks', to: '/about/risks', connectedOnly: false },
]);

/** The items to show: My Box only for a connected account. */
export function visibleNavItems(connected: boolean): readonly NavItem[] {
  return NAV_ITEMS.filter((item) => connected || !item.connectedOnly);
}

// A Map, not a plain object: the lookup key comes from the URL and must not reach Object.prototype names.
const BY_PATH: ReadonlyMap<string, NavId> = new Map([
  ['/', 'boxes'],
  ['/my-box', 'my-box'],
  ['/settings', 'settings'],
  ['/about/risks', 'risks'],
  ...ALPHA_ITEMS.map((item): [string, NavId] => [item.to, item.id]),
]);

/**
 * The one nav item that represents the current location, or null (the pair pages, the hidden routes, not-found). A box
 * page belongs to Boxes; the connected account's own wallet page belongs to My Box.
 */
export function activeNavId(pathname: string, _search: string, account: string | null = null): NavId | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (path.startsWith('/box/')) return 'boxes';
  if (path === '/create' || path.startsWith('/create/')) return 'launch';
  if (path.startsWith('/wallet/')) {
    const address = path.slice('/wallet/'.length).toLowerCase();
    return account !== null && address === account.toLowerCase() ? 'my-box' : null;
  }
  return BY_PATH.get(path) ?? null;
}

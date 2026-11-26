/**
 * EIP-6963 multi-wallet discovery. Discovery starts only when the person opens the wallet chooser (UI-09): nothing
 * listens or asks on page load. Announcements are untrusted input from browser extensions: names are cleaned text,
 * icons must be bounded `data:image/…` URIs (rendered with <img>, which never runs scripts), and malformed entries are
 * ignored. Discovery never calls the provider; only a click on "Connect" does.
 */
import { cleanText, type Eip1193Provider } from './eip1193';

export interface DiscoveredWallet {
  /** EIP-6963 `uuid` of this announcement (per page session). */
  readonly id: string;
  readonly name: string;
  /** Reverse-DNS id (e.g. `io.metamask`); used for "last used wallet", never as authority. */
  readonly rdns: string;
  /** A safe `data:image/…` URI, or null when the announced icon was rejected. */
  readonly icon: string | null;
  readonly provider: Eip1193Provider;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RDNS = /^[a-z0-9](?:[a-z0-9-]{0,62})(?:\.[a-z0-9](?:[a-z0-9-]{0,62}))+$/i;
const ICON = /^data:image\/(?:png|jpeg|webp|gif|svg\+xml)(?:;base64)?,[A-Za-z0-9+/=%._~:;,!*'()@&$#-]*$/;
export const MAX_ICON_LENGTH = 100_000;

export function safeWalletIcon(icon: unknown): string | null {
  return typeof icon === 'string' && icon.length <= MAX_ICON_LENGTH && ICON.test(icon) ? icon : null;
}

/** A validated wallet from an `eip6963:announceProvider` event detail, or null. */
export function parseAnnouncement(detail: unknown): DiscoveredWallet | null {
  if (typeof detail !== 'object' || detail === null) return null;
  const { info, provider } = detail as { info?: unknown; provider?: unknown };
  if (typeof info !== 'object' || info === null) return null;
  if (typeof provider !== 'object' || provider === null || typeof (provider as { request?: unknown }).request !== 'function') return null;
  const { uuid, name, rdns, icon } = info as Record<string, unknown>;
  if (typeof uuid !== 'string' || !UUID.test(uuid)) return null;
  if (typeof rdns !== 'string' || rdns.length > 128 || !RDNS.test(rdns)) return null;
  if (typeof name !== 'string') return null;
  const cleanName = cleanText(name, 48);
  if (cleanName.length === 0) return null;
  return Object.freeze({ id: uuid, name: cleanName, rdns: rdns.toLowerCase(), icon: safeWalletIcon(icon), provider: provider as Eip1193Provider });
}

export interface DiscoveryTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  dispatchEvent(event: Event): boolean;
}

/**
 * Listens for announcements and asks installed wallets to announce themselves (`eip6963:requestProvider`). `onChange`
 * receives the current list (one entry per uuid, in announcement order). Returns a function that stops listening.
 */
export function discoverWallets(target: DiscoveryTarget, onChange: (wallets: readonly DiscoveredWallet[]) => void): () => void {
  const byId = new Map<string, DiscoveredWallet>();
  const listener = (event: Event) => {
    const wallet = parseAnnouncement((event as CustomEvent<unknown>).detail);
    if (wallet === null) return;
    byId.set(wallet.id, wallet);
    onChange(Object.freeze([...byId.values()]));
  };
  target.addEventListener('eip6963:announceProvider', listener);
  target.dispatchEvent(new Event('eip6963:requestProvider'));
  return () => target.removeEventListener('eip6963:announceProvider', listener);
}

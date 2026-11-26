/**
 * The card service's routes. The request URL is untrusted: it is matched against fixed patterns only, the chain must be
 * one of a fixed list, the address 0x + 40 hex digits, and `v` a short [0-9a-z-] word; nothing from it reaches a file
 * name, a fetch or an object key unchecked.
 *
 *   GET|HEAD /card/item/<chain>/<address>/<id>.png        a revealed item (always no-store)
 *   GET|HEAD /card/healthz                                  200 {"ok":true,...}
 *   GET|HEAD /card/box/<chain>/<address>.png?v=<version>    the box's card (also without `.png`)
 */

/** The chains a card can name: Sepolia only (no mainnet target, G08; the Demo boxes have no chain to read). */
export const CARD_CHAINS: ReadonlyMap<string, number> = new Map([['11155111', 11_155_111]]);

const CARD = /^\/card\/box\/([0-9]{1,9})\/(0x[0-9a-fA-F]{40})(?:\.png)?$/;
const VERSION = /^[0-9a-z][0-9a-z-]{0,63}$/;
/** Longer request targets are not ours. */
export const MAX_TARGET = 512;

export type CardRoute =
  | { readonly kind: 'health' }
  | { readonly kind: 'item'; readonly chainId: number; readonly token: `0x${string}`; readonly id: string }
  | { readonly kind: 'card'; readonly chainId: number; readonly token: `0x${string}`; readonly v: string | null }
  /** Under /card/box/ but no box this service draws (a malformed address, a chain not on the list). */
  | { readonly kind: 'invalid' }
  | { readonly kind: 'none' };

export function routeOf(target: string): CardRoute {
  if (target.length > MAX_TARGET || !target.startsWith('/')) return { kind: 'none' };
  let url: URL;
  try {
    url = new URL(target, 'http://cards.invalid');
  } catch {
    return { kind: 'none' };
  }
  if (url.pathname === '/card/healthz') return { kind: 'health' };
  if (url.pathname.startsWith('/card/item/')) {
    const item = /^\/card\/item\/([0-9]{1,9})\/(0x[0-9a-fA-F]{40})\/([1-9][0-9]{0,77})\.png$/.exec(url.pathname);
    const chainId = item ? CARD_CHAINS.get(item[1] ?? '') : undefined;
    return item?.[2] && item[3] && chainId !== undefined ? { kind: 'item', chainId, token: item[2].toLowerCase() as `0x${string}`, id: item[3] } : { kind: 'invalid' };
  }
  if (!url.pathname.startsWith('/card/box/')) return { kind: 'none' };
  const match = CARD.exec(url.pathname);
  const chainId = match ? CARD_CHAINS.get(match[1] ?? '') : undefined;
  const token = match?.[2];
  if (chainId === undefined || token === undefined) return { kind: 'invalid' };
  const v = url.searchParams.get('v');
  return { kind: 'card', chainId, token: token.toLowerCase() as `0x${string}`, v: v !== null && VERSION.test(v) ? v : null };
}

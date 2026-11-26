/**
 * SH-283: a shop's items as cards with their pictures (the founder, 26 November 2026, on the card shop: "Can the cards
 * be shown here visually? Numbers and text are boring."). The pick list's items and the giver's own items are cards: the
 * item's picture, a short name and, in the pick list, its price.
 *
 * The picture is the item's own, read the way the site reads an outside item's picture (set/set-pictures.ts): its
 * `tokenURI` over the source's RPC, the metadata's `image` from `ipfs://` through our own gateways only (the source's
 * art gateways), size-capped and time-boxed, checked against the withheld list, drawn only when its bytes are a raster
 * picture. A card asks for its picture only once it comes near the window (the shown page only, never the whole shop);
 * until then, and whenever there is none, the site's empty picture tile stands in its fixed place, so the grid never
 * jumps and the card works without it. The picture is decoration: the button's name says which item it is.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPublicClient, http, type Abi, type Address } from 'viem';
import { formatTokenAmount } from '@squarehole/domain';
import { refusedRetryFetch, type FetchLike } from '@squarehole/chain/write';
import { WithheldTile } from '../../pictures/WithheldTile';
import { useItemPicture } from '../../set/set-pictures';
import type { SetReads } from '../../set/set-reads';
import type { V2Source } from './indexer-v2';

/**
 * A shop amount as the site prints token amounts: thousands grouped, every digit the coin has (a price is never cut):
 * 2000000000000000000000000n in CARD is "2,000,000 CARD". (The shop printed `formatUnits`, the exact decimal string
 * without grouping, as its first build did for every figure.)
 */
export const shopAmountV2 = (raw: bigint, unit: string, decimals = 18): string => `${formatTokenAmount(raw, decimals, { maxFractionDigits: decimals })} ${unit}`;

/**
 * The names a card shows: each collection's own name, less the leading words every listed name shares, where the
 * names differ ("Test Trading Cards Common" and "… Rare" read "Common" and "Rare"); one collection, or names that are
 * all the same, keep the whole name. A collection without a name: its short address.
 */
export function shortNamesV2(collections: readonly { readonly address: string; readonly name: string | null }[]): ReadonlyMap<string, string> {
  const named = collections.filter((c): c is { address: string; name: string } => typeof c.name === 'string' && c.name.trim() !== '');
  const words = named.map((c) => c.name.trim().split(/\s+/));
  let shared = 0;
  if (new Set(named.map((c) => c.name.trim())).size > 1) {
    const first = words[0] ?? [];
    while (shared < first.length && words.every((w) => w.length > shared + 1 && w[shared] === first[shared])) shared += 1;
  }
  const out = new Map<string, string>();
  for (const c of collections) {
    const name = typeof c.name === 'string' && c.name.trim() !== '' ? c.name.trim().split(/\s+/).slice(shared).join(' ') : `${c.address.slice(0, 6)}…${c.address.slice(-4)}`;
    out.set(c.address.toLowerCase(), name);
  }
  return out;
}

/**
 * The one read a card's picture needs (`tokenURI`), over the source's RPC. SH-283b: a dozen cards ask at once, and a
 * public endpoint answers HTTP 429 past its share per address (chain 97's, about 16 at once): a refused read goes again
 * to the same endpoint by the site's one rule for it (`refusedRetryFetch`: HTTP 429 only, three more tries at most);
 * viem's own `retryCount` stays 0 (it would repeat other statuses too). `fetchFn`: the tests' endpoint.
 */
export function pictureReadsV2(rpc: string, fetchFn?: FetchLike): Pick<SetReads, 'read'> {
  const client = createPublicClient({ transport: http(rpc, { retryCount: 0, fetchFn: refusedRetryFetch(fetchFn) }), ccipRead: false });
  return { read: (address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) => client.readContract({ address, abi, functionName, args } as never) as Promise<unknown> };
}

/** `pictureReadsV2` on the source's RPC; one client per source. */
export function usePictureReadsV2(source: V2Source): Pick<SetReads, 'read'> {
  return useMemo(() => pictureReadsV2(source.rpc), [source.rpc]);
}

/** Whether the element has come near the window (once true, it stays); without IntersectionObserver, at once. */
function useNearWindow<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (near || !ref.current || typeof IntersectionObserver === 'undefined') return undefined;
    const watch = new IntersectionObserver((seen) => { if (seen.some((entry) => entry.isIntersecting)) setNear(true); }, { rootMargin: '200px' });
    watch.observe(ref.current);
    return () => watch.disconnect();
  }, [near]);
  return [ref, near];
}

export interface ShopCardPictureProps {
  readonly reads: Pick<SetReads, 'read'> | null;
  readonly chainId: number;
  readonly collection: Address;
  readonly id: bigint;
  /** Our own IPFS gateways (the source's art gateways): the only place an `ipfs://` picture is fetched from. */
  readonly ipfs: readonly string[];
}

/** An item's picture in its card: the picture once read and checked, else the empty tile in the same place. */
export function ShopCardPicture({ reads, chainId, collection, id, ipfs }: ShopCardPictureProps) {
  const [ref, near] = useNearWindow<HTMLSpanElement>();
  const { url, withheld } = useItemPicture(near ? reads : null, chainId, collection, id, ipfs);
  return <span ref={ref} className="sh-v2-shop-card__art" aria-hidden="true" data-picture={withheld ? 'withheld' : url ? 'shown' : 'none'}>
    {withheld ? <WithheldTile className="sh-v2-shop-card__picture" decorative />
      : url ? <img className="sh-v2-shop-card__picture" src={url} width={500} height={700} alt="" decoding="async" referrerPolicy="no-referrer" />
        : <span className="sh-v2-shop-card__picture sh-v2-shop-card__picture--none" />}
  </span>;
}

export interface ShopCardProps extends ShopCardPictureProps {
  /** The button's name for assistive technology (the collection's name with its address, the number, the price). */
  readonly label?: string;
  /** The full name with the address, shown on hover. */
  readonly title?: string;
  readonly name: ReactNode;
  readonly price?: ReactNode;
  readonly pressed: boolean;
  readonly disabled?: boolean;
  readonly small?: boolean;
  readonly onPress: () => void;
}

/** One item as a card: its picture, its short name, its price; a toggle (pressed while chosen). */
export function ShopCard({ label, title, name, price, pressed, disabled = false, small = false, onPress, ...picture }: ShopCardProps) {
  return <button type="button" className={`sh-v2-shop-card${small ? ' sh-v2-shop-card--small' : ''}`} aria-pressed={pressed} {...(label ? { 'aria-label': label } : {})} {...(title ? { title } : {})} disabled={disabled} onClick={onPress}>
    <ShopCardPicture {...picture} />
    <span className="sh-v2-shop-card__name">{name}</span>
    {price !== undefined ? <span className="sh-v2-shop-price">{price}</span> : null}
  </button>;
}

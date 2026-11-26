/**
 * SH-288: one card of a shop, as the platform's shop shows its items (apps/web ShopCardsV2.tsx, a small copy: this app
 * imports nothing from apps/web). The card's picture in a fixed 5:7 place, its short name, its price; a toggle, pressed
 * while chosen. The picture (lib/card-picture.ts) is read once a card comes near the window, from the card's own
 * tokenURI, and drawn from the site's own picture address; until then, or without one, or when it does not load, the
 * empty tile stays in the same place, so nothing jumps and the card works. The picture is decoration: the button's name
 * says which card it is.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Address, PublicClient } from 'viem';
import { cardsAbi } from '../abi/shop';
import { useApp } from '../lib/app-context';
import { formatAmount } from '../lib/amounts';
import { shortAddress } from '../lib/chain';
import { cardKey, type ShopInfo, type ShopCardRef } from '../lib/shop';
import { cardNameOf, pictureAddressOf, shortNames } from '../lib/card-picture';

interface Found { url: string | null; name: string | null }
/** One read per card for the visit: a card's tokenURI does not change while the page is open. */
const found = new Map<string, Promise<Found>>();

export function readCardPicture(c: PublicClient, nft: Address, id: bigint): Promise<Found> {
  const key = `${nft.toLowerCase()}:${id}`;
  let job = found.get(key);
  if (!job) {
    job = c.readContract({ address: nft, abi: cardsAbi, functionName: 'tokenURI', args: [id] }).then(
      (uri) => ({ url: pictureAddressOf(uri), name: cardNameOf(uri) }),
      () => ({ url: null, name: null }),
    );
    found.set(key, job);
  }
  return job;
}

/** Test seam: forget every read. */
export function forgetCardPictures(): void {
  found.clear();
}

/** Whether the element has come near the window (once true, it stays); without IntersectionObserver, at once. */
function useNearWindow<T extends Element>() {
  const ref = useRef<T | null>(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (near || !ref.current || typeof IntersectionObserver === 'undefined') return undefined;
    const watch = new IntersectionObserver((seen) => { if (seen.some((e) => e.isIntersecting)) setNear(true); }, { rootMargin: '200px' });
    watch.observe(ref.current);
    return () => watch.disconnect();
  }, [near]);
  return [ref, near] as const;
}

export function CardPicture({ nft, id }: { nft: Address; id: bigint }) {
  const { client } = useApp();
  const [ref, near] = useNearWindow<HTMLSpanElement>();
  const [picture, setPicture] = useState<Found | null>(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    if (!near) return undefined;
    let live = true;
    void readCardPicture(client, nft, id).then((f) => { if (live) setPicture(f); });
    return () => { live = false; };
  }, [near, client, nft, id]);
  const url = picture?.url && !broken ? picture.url : null;
  return (
    <span ref={ref} className="shop-card-art" aria-hidden="true" data-picture={url ? 'shown' : 'none'} title={picture?.name ?? undefined}>
      {url ? <img className="shop-card-picture" src={url} width={500} height={700} alt="" decoding="async" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
        : <span className="shop-card-picture shop-card-picture-none" />}
    </span>
  );
}

export function useCollectionNames(info: ShopInfo) {
  return useMemo(() => shortNames(info.collections.map((c) => ({ address: c.nft, name: c.name }))), [info]);
}

/** Without a selection handler each stocked card links to the shop that holds it. */
export function ShopCards({ info, cards, side = 'pick', selection }: {
  info: ShopInfo;
  cards: ShopCardRef[];
  side?: 'pick' | 'give';
  selection?: { chosen: string | null; disabled: boolean; toggle: (key: string) => void };
}) {
  const names = useCollectionNames(info);
  if (cards.length === 0) return null;
  return (
    <ul className="shop-cards" aria-label={side === 'pick' ? 'Cards inside' : 'Your cards'} data-testid={side === 'give' ? 'own-cards' : undefined}>
      {cards.map((card) => {
        const key = cardKey(card);
        const collection = info.collections.find((c) => c.nft.toLowerCase() === card.nft.toLowerCase());
        const price = side === 'pick' ? collection?.pickPrice : collection?.givePrice;
        const priceText = price === undefined ? null : `${formatAmount(price, info.tokenDecimals, { maxFraction: info.tokenDecimals })} ${info.tokenSymbol}`;
        const title = `${collection?.name ?? 'Cards'} · ${shortAddress(card.nft)} #${card.id}`;
        const label = `${title}, ${priceText ?? 'price unavailable'}`;
        const tile = (
          <>
            <CardPicture nft={card.nft} id={card.id} />
            <span className="shop-card-name">{names.get(card.nft.toLowerCase()) ?? shortAddress(card.nft)} #{card.id.toString()}</span>
            <span className="shop-card-price sh-numeric">{priceText ?? '-'}</span>
          </>
        );
        return (
          <li key={key}>
            {selection ? (
              <button type="button" className="shop-card" aria-pressed={selection.chosen === key} aria-label={label} title={title}
                disabled={selection.disabled} onClick={() => selection.toggle(key)} data-testid={side === 'pick' ? 'shop-card' : 'own-card'}>
                {tile}
              </button>
            ) : (
              <a className="shop-card" href={`#/shop/${info.shop}`} aria-label={label} title={title}>{tile}</a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

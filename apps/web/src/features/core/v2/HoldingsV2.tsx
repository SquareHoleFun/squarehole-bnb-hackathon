/**
 * SH-291: My Box for the current box generation (v2): the box tokens a wallet holds with their worth in each box's price
 * coin, its items as small picture cards (the shop's card look), and what waits for it to claim, each leading to the
 * box page's own claim. Numbers first; a read that failed says so with Retry, never "nothing".
 *
 * Reads: the feed the page already has (boxes, prices, item owners, shop collections); one round of view calls (every
 * token balance, the box items' owners, the card count per collection) and one more for the card ids, folded into
 * Multicall3 calls by the page's read client on the public endpoints; a card's picture is read only near the window.
 * The claims come from the wallet claims index through `useWalletClaimsV2` (one traversal, shared with the Claims tab).
 */
import { useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { createPublicClient, http, type Abi, type Address, type PublicClient } from 'viem';
import { boxPath } from '../../boxes/box-id';
import type { BoxRecord } from '../../boxes/box-model';
import { BoxCover, TokenMark } from '../../boxes/BoxParts';
import { pageClient } from '../../create/v2/view-client';
import { FEED_WORDS } from '../../boxes/feed-words';
import { formatCount } from '../../fit-pair/fit-format';
import { stepP, stepT } from './claim-all';
import type { BoxClaimsV2 } from './claim-reads';
import { holdsNothingV2, readHoldingsV2, valueInPV2, type HeldItemV2, type HoldingsBoxV2, type HoldingsRead, type HoldingsV2 } from './holdings';
import { cardReaderV2, type CardReaderV2 } from './card-reads';
import type { V2Snapshot, V2Source } from './indexer-v2';
import { ShopCardPicture, shopAmountV2, shortNamesV2, usePictureReadsV2 } from './ShopCardsV2';
import { shopOf } from './shop-actions';
import { pAmountV2, tShortV2 } from './stats-v2';
import { useCollectionNamesV2 } from './shop-reads';
import './v2-page.css';

/** The words of this part (the platform's own where they exist). */
export const HOLDINGS_WORDS = Object.freeze({
  coins: 'Coins',
  items: 'Items',
  waiting: 'To claim',
  claim: 'Claim',
  nothing: 'Nothing here yet.',
  boxes: 'Boxes',
  testCoins: 'Test coins',
  reading: 'Reading…',
  unread: 'This wallet did not load.',
  partly: 'Some of this wallet did not load.',
  more: 'More than shown here.',
});

/** The place on a box page its claims sit (V2BoxPage's PLACE.claims). */
export const CLAIMS_PLACE = 'sh-box-place-claims';
const TEST_COINS = import.meta.env?.SH_SEPOLIA_TRADE === true ? '/test-coins' : null;

/** One read client per source (the page client: Multicall3 and JSON-RPC batches on the public endpoints), checked to serve the source's chain. */
const clients = new Map<string, { readonly client: PublicClient; readonly sameChain: () => Promise<void> }>();
function clientOf(source: V2Source) {
  const key = `${source.manifest.chainId}|${source.rpc}`;
  let entry = clients.get(key);
  if (!entry) {
    const client = pageClient(source.rpc, source.manifest.chainId, () => createPublicClient({ transport: http(source.rpc, { retryCount: 0 }), ccipRead: false }));
    let checked: Promise<void> | null = null;
    const sameChain = () => {
      checked ??= client.getChainId().then((id) => { if (id !== source.manifest.chainId) throw new Error('Wrong network'); });
      checked.catch(() => { checked = null; });
      return checked;
    };
    entry = { client, sameChain };
    clients.set(key, entry);
  }
  return entry;
}

export function holdingsReadOf(source: V2Source): HoldingsRead {
  const { client, sameChain } = clientOf(source);
  return async (address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) => {
    await sameChain();
    return client.readContract({ address, abi, functionName, args } as never) as Promise<unknown>;
  };
}

/** The v2 boxes among the page's records (those the feed read, with their source). */
export function holdingsBoxesOf(records: readonly BoxRecord[]): HoldingsBoxV2[] {
  return records.flatMap((record) => {
    const view = record.v2Chain?.snapshot; const source = record.v2Chain?.source;
    return view && source ? [{ record, view, source }] : [];
  });
}

export type HoldingsStateV2 = { readonly status: 'reading' } | { readonly status: 'failed'; readonly retry: () => void } | { readonly status: 'ready'; readonly value: HoldingsV2; readonly retry: () => void };

/** The v2 feed's state as the page's sources give it (null: the source has no v2 feed). */
export interface FeedPartV2 { readonly loading: boolean; readonly answered: boolean; readonly error: string | null }

/**
 * The wallet's holdings, read again when the feed moves to a new block (a buy, a pick) and on Retry (`retryFeed` reads
 * the feed again when it is the feed that failed). With no v2 box the answer is "nothing" only once the feed answered.
 */
export function useHoldingsV2(records: readonly BoxRecord[], account: Address | null, feed: FeedPartV2 | null, retryFeed?: () => void,
  readOf: (source: V2Source) => HoldingsRead = holdingsReadOf, cardsOf: (source: V2Source) => CardReaderV2 = cardReaderV2): HoldingsStateV2 {
  const boxes = useMemo(() => holdingsBoxesOf(records), [records]);
  // Keyed by the wallet and the boxes, not the feed's block: a new block alone reads nothing again (the feed moves every
  // few seconds). A mined send anywhere on the site reads it again (wallet-reads.ts), as does Retry; else once a minute.
  const latest = useRef(boxes);
  useEffect(() => { latest.current = boxes; }, [boxes]);
  const tokens = boxes.map((b) => b.view.token.toLowerCase()).join('|');
  const query = useQuery({
    queryKey: ['v2-holdings', account?.toLowerCase(), tokens],
    queryFn: () => readHoldingsV2(latest.current, account as Address, readOf, cardsOf),
    enabled: account !== null && boxes.length > 0, retry: false, staleTime: 60_000, refetchInterval: 60_000,
    placeholderData: (previous) => previous,
  });
  const retry = () => { void query.refetch(); };
  // The reads' answer, shown with the boxes as the page has them now (a price coin's symbol read after the holdings, a
  // newer price): the read keeps only what this wallet holds.
  const value = useMemo(() => {
    if (!query.data) return null;
    const now = new Map(boxes.map((b) => [b.record.id, b]));
    return {
      ...query.data,
      tokens: query.data.tokens.map((t) => { const b = now.get(t.record.id); return b ? { ...t, record: b.record, view: b.view, valueP: valueInPV2(b.view, t.balanceT) } : t; }),
      items: query.data.items.map((i) => { const b = now.get(i.record.id); return b ? { ...i, record: b.record } : i; }),
    };
  }, [query.data, boxes]);
  if (boxes.length === 0) {
    if (feed?.answered) return { status: 'ready', value: { tokens: [], items: [], failed: 0, more: false }, retry };
    if (feed && !feed.loading && feed.error !== null) return { status: 'failed', retry: retryFeed ?? retry };
    return { status: 'reading' };
  }
  if (value) return { status: 'ready', value, retry };
  if (query.isError) return { status: 'failed', retry };
  return { status: 'reading' };
}

/** One box's claims waiting, per coin: the price coin, the box's own coin; null when nothing waits. */
export function waitingOf(c: BoxClaimsV2): { readonly p: bigint; readonly t: bigint; readonly count: number } | null {
  const steps = c.steps.filter((s) => s.kind !== 'approve');
  if (steps.length === 0) return null;
  return { p: steps.reduce((sum, s) => sum + (stepP(s) ?? 0n), 0n), t: steps.reduce((sum, s) => sum + stepT(s), 0n), count: steps.length };
}

/**
 * A held coin as the Boxes list and the box page's facts print amounts (stats-v2.ts): the box token short and cut
 * ("5.82M VRAM", `tShortV2`), its worth in the price coin cut to two decimals from one whole coin up, else four
 * significant digits ("0.00434 tNVDA", `pAmountV2`). The site keeps no exact amount in a title, so none is added here.
 */
export const coinAmountV2 = (balanceT: bigint, ticker: string): string => `${tShortV2(balanceT)} ${ticker}`;
export const coinWorthV2 = (valueP: bigint, symbol: string, decimals: number): string => `${pAmountV2(valueP, decimals)} ${symbol}`;

function CoinRow({ record, balanceT, valueP, decimals }: { record: BoxRecord; balanceT: bigint; valueP: bigint | null; decimals: number }) {
  const amount = coinAmountV2(balanceT, record.ticker);
  const worth = valueP === null ? null : coinWorthV2(valueP, record.pairAsset, decimals);
  return (
    <li>
      <Link to={boxPath(record.id)} className="sh-v2-holding" aria-label={`${record.name}: ${amount}${worth === null ? '' : `, about ${worth}`}`}>
        <span className="sh-v2-holding__mark"><TokenMark record={record} size={36} /></span>
        <span className="sh-v2-holding__name">{record.name}</span>
        <strong className="sh-v2-holding__amount">{amount}</strong>
        {worth === null ? null : <span className="sh-v2-holding__value">{`≈ ${worth}`}</span>}
      </Link>
    </li>
  );
}

/** A shop's cards as the shop's own pick grid shows them (ShopActionsV2): the card's picture and "Common #3". */
function ShopCardsHeld({ record, source, view, cards }: { record: BoxRecord; source: V2Source; view: V2Snapshot; cards: readonly HeldItemV2[] }) {
  const reads = usePictureReadsV2(source);
  // The shop's listed collections (its spec and the index's history), so the short names are the shop page's own.
  const listed = useMemo(() => {
    const all = new Map<string, Address>();
    for (const c of shopOf(view, null)?.collections ?? []) all.set(c.toLowerCase(), c);
    for (const c of Object.keys(view.m2?.history?.shop?.collections ?? {})) if (/^0x[0-9a-fA-F]{40}$/.test(c)) all.set(c.toLowerCase(), c as Address);
    for (const c of cards) all.set(c.collection.toLowerCase(), c.collection);
    return [...all.values()];
  }, [view, cards]);
  const names = useCollectionNamesV2(source, listed);
  const short = shortNamesV2(listed.map((address) => ({ address, name: names(address) })));
  const shortAddress = (c: string) => `${c.slice(0, 6)}…${c.slice(-4)}`;
  return <>{cards.map((card) => {
    const full = names(card.collection);
    const nameOf = full ? `${full} · ${shortAddress(card.collection)}` : shortAddress(card.collection);
    return (
      <li key={`${card.collection}:${card.id}`}>
        <Link to={boxPath(record.id)} className="sh-v2-shop-card" aria-label={`${nameOf} #${card.id}, ${record.name}`} title={`${nameOf} #${card.id}`}>
          <ShopCardPicture reads={reads} chainId={source.manifest.chainId} collection={card.collection} id={card.id} ipfs={source.art ?? []} />
          <span className="sh-v2-shop-card__name">{`${short.get(card.collection.toLowerCase()) ?? shortAddress(card.collection)} #${card.id}`}</span>
        </Link>
      </li>
    );
  })}</>;
}

/** A box's own item: "#<id>" under the box's picture, as the box page's Items card names it. */
function BoxItemHeld({ item }: { item: HeldItemV2 }) {
  return (
    <li>
      <Link to={boxPath(item.record.id)} className="sh-v2-shop-card" aria-label={`${item.record.name} #${item.id}`} title={`${item.record.name} #${item.id}`}>
        <span className="sh-v2-shop-card__art" aria-hidden="true"><BoxCover record={item.record} small className="sh-v2-shop-card__picture" /></span>
        <span className="sh-v2-shop-card__name">{`#${item.id}`}</span>
      </Link>
    </li>
  );
}

function Items({ items }: { items: readonly HeldItemV2[] }) {
  // Cards grouped by their shop (each shop names its own collections); a box's own items after them.
  const shops = new Map<string, { record: BoxRecord; source: V2Source; view: V2Snapshot; cards: HeldItemV2[] }>();
  for (const item of items) {
    if (item.kind !== 'card') continue;
    const view = item.record.v2Chain?.snapshot;
    if (!view) continue;
    const entry = shops.get(item.record.id) ?? { record: item.record, source: item.source, view, cards: [] };
    entry.cards.push(item);
    shops.set(item.record.id, entry);
  }
  return (
    <ul className="sh-v2-shop-cards">
      {[...shops.values()].map((s) => <ShopCardsHeld key={s.record.id} record={s.record} source={s.source} view={s.view} cards={s.cards} />)}
      {items.filter((i) => i.kind === 'item').map((item) => <BoxItemHeld key={`${item.collection}:${item.id}`} item={item} />)}
    </ul>
  );
}

function Waiting({ claims }: { claims: readonly BoxClaimsV2[] }) {
  const rows = claims.flatMap((c) => { const w = waitingOf(c); return w ? [{ c, w }] : []; });
  if (rows.length === 0) return null;
  return (
    <section className="sh-v2-holdings__part" aria-labelledby="holdings-waiting">
      <h3 id="holdings-waiting">{HOLDINGS_WORDS.waiting}</h3>
      <ul className="sh-v2-holdings__list">
        {rows.map(({ c, w }) => {
          const { view, name, symbol, ticker } = c.box;
          const amounts = [w.p > 0n ? shopAmountV2(w.p, symbol, view.decimals) : null, w.t > 0n ? shopAmountV2(w.t, ticker) : null].filter(Boolean).join(' + ');
          return (
            <li key={c.box.key}>
              <Link to={`${boxPath(c.box.key)}#${CLAIMS_PLACE}`} className="sh-v2-holding sh-v2-holding--plain" aria-label={`${HOLDINGS_WORDS.claim} on ${name}: ${amounts || formatCount(BigInt(w.count))}`}>
                <span className="sh-v2-holding__name">{name}</span>
                <strong className="sh-v2-holding__amount">{amounts || formatCount(BigInt(w.count))}</strong>
                <span className="sh-v2-holding__go">{HOLDINGS_WORDS.claim}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export interface HoldingsViewProps {
  readonly state: HoldingsStateV2;
  /** The wallet's claims per box (useWalletClaimsV2), or null where the source has no v2 box that can hold one. */
  readonly claims: readonly BoxClaimsV2[] | null;
  /** Whether every claim read answered (a "nothing to claim" is then true). */
  readonly claimsKnown: boolean;
}

/** The contents of My Box for v2 boxes. */
export function HoldingsViewV2({ state, claims, claimsKnown }: HoldingsViewProps) {
  if (state.status === 'reading') return <p className="sh-muted" data-holdings="reading">{HOLDINGS_WORDS.reading}</p>;
  if (state.status === 'failed') {
    return (
      <div className="sh-panel sh-part-failed" data-holdings="unread">
        <p>{HOLDINGS_WORDS.unread}</p>
        <button type="button" className="sh-button" onClick={state.retry}>{FEED_WORDS.retry}</button>
      </div>
    );
  }
  const h = state.value;
  const waiting = (claims ?? []).some((c) => waitingOf(c) !== null);
  const nothing = holdsNothingV2(h) && !waiting && claimsKnown;
  return (
    <div className="sh-v2-holdings" data-holdings={nothing ? 'nothing' : h.failed > 0 ? 'partly' : 'held'}>
      {h.tokens.length > 0 ? (
        <section className="sh-v2-holdings__part" aria-labelledby="holdings-coins">
          <h3 id="holdings-coins">{HOLDINGS_WORDS.coins}</h3>
          <ul className="sh-v2-holdings__list">
            {h.tokens.map((t) => <CoinRow key={t.record.id} record={t.record} balanceT={t.balanceT} valueP={t.valueP} decimals={t.view.decimals} />)}
          </ul>
        </section>
      ) : null}
      {h.items.length > 0 ? (
        <section className="sh-v2-holdings__part" aria-labelledby="holdings-items">
          <h3 id="holdings-items">{HOLDINGS_WORDS.items}</h3>
          <Items items={h.items} />
          {h.more ? <p className="sh-muted">{HOLDINGS_WORDS.more}</p> : null}
        </section>
      ) : null}
      <Waiting claims={claims ?? []} />
      {nothing ? (
        <div className="sh-v2-holdings__nothing">
          <p>{HOLDINGS_WORDS.nothing}</p>
          <p className="sh-v2-holdings__ways">
            <Link to="/" className="sh-button">{HOLDINGS_WORDS.boxes}</Link>
            {TEST_COINS ? <Link to={TEST_COINS} className="sh-button sh-button--secondary">{HOLDINGS_WORDS.testCoins}</Link> : null}
          </p>
        </div>
      ) : null}
      {h.failed > 0 ? (
        <div className="sh-panel sh-part-failed" data-holdings="unread">
          <p>{HOLDINGS_WORDS.partly}</p>
          <button type="button" className="sh-button" onClick={state.retry}>{FEED_WORDS.retry}</button>
        </div>
      ) : null}
    </div>
  );
}

/** The header's counts: boxes held from and items, or null while unknown (never a zero for an unread wallet). */
export function holdingsCountsV2(state: HoldingsStateV2): { readonly boxes: number; readonly items: number } | null {
  if (state.status !== 'ready' || state.value.failed > 0) return null;
  return { boxes: state.value.tokens.length, items: state.value.items.length };
}

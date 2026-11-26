/**
 * A shop's actions (SH-V21-FE13; shop-actions.ts): give one of your items from a listed collection (see what you get
 * first, then Give), pick an item inside (see its pick price, then Pick) and, for the curator, add a collection at a tier
 * (see when it takes gives). Items are custody, never trading: a give and a pick move one item for the shop's fixed T.
 * SH-297: Pick and Give are one press each, as buying and selling is (shop-actions.ts `pressPickV2`, `pressGiveV2`): the
 * exact approval first when one is needed, then the move; the button says where the press is, with the same words as
 * the buy and sell box (trade-sepolia/trade-words.ts, copied: that folder stays out of the main site's build), and two
 * ticks show the steps when there are two. A curator's addition still waits for an in-page confirmation.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Address } from '@squarehole/domain';
import { BrowserWalletDialog, DemoWalletDialog, useWallet } from '../../wallet';
import { addressOf, pickPriceOf } from '../../create/v2/shop';
import { collectionCheckV2 } from '../../create/v2/shop-checks';
import { rpcTokenReader } from '../../create/v2/indexer-listings';
import type { V2Snapshot, V2Source } from './indexer-v2';
import { allowanceV2, giveBlockV2, type ShopBookV2 } from './shop-book';
import { GIVE_BLOCK_TEXT, pressGiveV2, pressPickV2, sendAddCollectionV2, shopActionIO, shopErrorText, shopOf, type ShopActionIO, type ShopPhase, type ShopProgress } from './shop-actions';
import { useCollectionNamesV2, useShopCoinsV2 } from './shop-reads';
import { useOwnCardsV2, type CardReaderV2 } from './card-reads';
import { FEED_WORDS } from '../../boxes/feed-words';
import { refreshWalletReads } from './wallet-reads';
import { ShopCard, shopAmountV2, shortNamesV2, usePictureReadsV2 } from './ShopCardsV2';
import { waitWords } from './shop-wait';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;
/** Items listed at once in the pick list; "Show more" adds as many again. */
export const PICK_PAGE = 60;

type Action = { readonly kind: 'add'; readonly collection: Address; readonly tier: number };

/**
 * The buy and sell box's words for a press under way (trade-sepolia/trade-words.ts `confirmLabel`,
 * `STEP_WORDS.approve`, `STEP_STATES`, `STEPS_LABEL`; TradeBox.tsx's "Waiting for the chain…"), the same strings: a test
 * pins them equal.
 */
export const PRESS_WORDS = Object.freeze({
  confirm: (inPage: boolean) => (inPage ? 'Signing…' : 'Confirm in your wallet…'),
  mining: 'Waiting for the chain…',
  /** SH-297's own phase (the buy and sell box has none like it): the mined approval being read back. */
  approval: 'Checking the approval…',
  approve: 'Approve',
  steps: 'Progress',
  states: Object.freeze({ waiting: 'next', active: 'under way', done: 'done', stopped: 'stopped' }),
});
const MARKS = Object.freeze({ waiting: '', active: '•', done: '✓', stopped: '✕' });

/** A press's two steps when it needed an approval, as the buy and sell box shows them (Steps.tsx), under its button. */
export function PressSteps({ progress, act }: { readonly progress: ShopProgress; readonly act: string }) {
  const steps = [['approve', PRESS_WORDS.approve, progress.approve], ['act', act, progress.act]] as const;
  return <ol className="sh-v2-steps" aria-label={PRESS_WORDS.steps}>
    {steps.map(([id, word, state]) => <li key={id} className="sh-v2-steps__step" data-step={id} data-state={state}>
      <span className="sh-v2-steps__mark" aria-hidden="true">{MARKS[state]}</span><span>{word}</span>
      <span className="sh-visually-hidden">{`, ${PRESS_WORDS.states[state]}`}</span>
    </li>)}
  </ol>;
}

const DATE = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** A chain time (seconds) as "20 Oct 2026, 09:00 UTC"; SH-300 guard: a time no date can show reads so, never a crash. */
export const utcDate = (seconds: bigint): string => {
  const date = new Date(Number(seconds) * 1000);
  return Number.isNaN(date.getTime()) ? 'a date this page cannot show' : `${DATE.format(date)} UTC`;
};
const DAY = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
/** A chain time (seconds) as a tile's short day, "2 Dec" (UTC); the same guard as `utcDate` (an empty mark, never a crash). */
export const dayOf = (seconds: bigint): string => {
  const date = new Date(Number(seconds) * 1000);
  return Number.isNaN(date.getTime()) ? '' : DAY.format(date);
};
const CLOCK = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/**
 * A tile's start mark: "from 2 Dec", or within a day "from 14:32 UTC" (SH-300: the second release's shop waits ten
 * minutes, and "from 26 Nov" on 26 Nov would not say the button stays off for now).
 */
export const startMark = (at: bigint, now: bigint): string => {
  const date = new Date(Number(at) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return at - now < 86_400n ? `from ${CLOCK.format(date)} UTC` : `from ${DAY.format(date)}`;
};
/**
 * SH-297 notes: the wallet's count less the cards listed. No reason is given: the count is the snapshot's and the owners
 * are now's, so a card that left since counts here too, as does one older than the read's walk back.
 */
export const unfoundLine = (n: bigint): string => (n === 1n ? '1 more of your items could not be listed here.' : `${n} more of your items could not be listed here.`);
/**
 * SH-297 notes: a weekly limit's line with the day it renews (the week's end, which sits behind the (?)): "Over this
 * week’s limit for this collection; it renews 9 Dec 2026, 11:48 UTC." Every other line as GIVE_BLOCK_TEXT says it.
 */
export function limitLine(block: NonNullable<ReturnType<typeof giveBlockV2>>, weekEndsAt: bigint | null): string {
  const text = GIVE_BLOCK_TEXT[block];
  return (block === 'weekly' || block === 'collection') && weekEndsAt !== null ? `${text.replace(/\.$/, '')}; it renews ${utcDate(weekEndsAt)}.` : text;
}
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const same = (a: string | null | undefined, b: string | null | undefined) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export interface ShopActionsV2Props {
  readonly view: V2Snapshot;
  readonly source: V2Source;
  readonly ticker: string;
  /** A stale or unverified read: actions wait. */
  readonly disabled: boolean;
  readonly book: ShopBookV2 | null;
  readonly bookFailed: boolean;
  /** Tests replace the chain and wallet boundary; the page uses shop-actions.ts `shopActionIO`. */
  readonly io?: (request: NonNullable<ReturnType<typeof useWallet>['signer']>['request']) => ShopActionIO;
  /** Test seam: the read of the wallet's own cards (card-reads.ts). */
  readonly cardReader?: CardReaderV2;
}

export function ShopActionsV2({ view, source, ticker, disabled, book, bookFailed, io, cardReader }: ShopActionsV2Props) {
  const wallet = useWallet(); const queries = useQueryClient(); const primary = useRef<HTMLButtonElement>(null);
  const found = shopOf(view, book);
  const shop = found?.shop ?? null;
  const account = wallet.status === 'connected' ? wallet.account : null;
  const wrong = account !== null && (wallet.chainId !== source.manifest.chainId || wallet.kind !== 'injected');
  const names = useCollectionNamesV2(source, found?.collections ?? []);
  // SH-283: the items' pictures, read only for the cards shown (ShopCardsV2.tsx).
  const pictureReads = usePictureReadsV2(source);
  const [dialog, setDialog] = useState(false);
  const [pending, setPending] = useState<{ readonly action: Action; readonly account: Address } | null>(null);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState<string | null>(null);
  // SH-297: the press under way (Pick or Give), where it is, and its two ticks when it needed an approval.
  const [pressing, setPressing] = useState<{ readonly kind: 'pick' | 'give'; readonly phase: ShopPhase } | null>(null);
  const [steps, setSteps] = useState<{ readonly kind: 'pick' | 'give'; readonly progress: ShopProgress } | null>(null);
  // Give (SH-297): the wallet's own cards of the shop's collections, as tiles; one selected.
  const ownCards = useOwnCardsV2(source, view, account, cardReader);
  const [giveKey, setGiveKey] = useState<string | null>(null);
  // Pick
  const items = book?.items ?? [];
  const [pickKey, setPickKey] = useState<string | null>(null);
  const [shown, setShown] = useState(PICK_PAGE);
  const coins = useShopCoinsV2(source, view.token, shop, account);
  // Add
  const [addText, setAddText] = useState(''); const [addTier, setAddTier] = useState(0);
  const added = addressOf(addText);
  const reader = useMemo(() => rpcTokenReader(source.rpc, source.manifest.chainId), [source]);
  const addCheck = useQuery({ queryKey: ['v2-shop-collection', source.network, source.manifest.chainId, added?.toLowerCase()], queryFn: () => collectionCheckV2(reader, added as Address), enabled: added !== null, retry: false, staleTime: Infinity });

  if (!found) return null;
  const { config } = found;
  const now = view.timestamp;
  const t = (raw: bigint) => shopAmountV2(raw, ticker);
  // A collection's own name is its contract's say: the address always stands beside it (a copy can take any name).
  const nameOf = (collection: string) => { const name = names(collection); return name ? `${name} · ${short(collection)}` : short(collection); };
  const tierOf = (collection: string) => book?.entries.get(collection.toLowerCase())?.tier;
  const giveOf = (collection: string) => { const tier = tierOf(collection); return tier === undefined ? null : config.givePricesT[tier] ?? null; };
  const pickOf = (collection: string) => { const give = giveOf(collection); return give === null ? null : pickPriceOf(give, config.pickBps); };
  // SH-283: a card shows the collection's name less the words all listed names share ("Common #3"); the whole name and
  // the address stay in the button's name and its title.
  const shortName = shortNamesV2(found.collections.map((collection) => ({ address: collection, name: names(collection) })));
  const cardName = (collection: string, itemId: bigint) => `${shortName.get(collection.toLowerCase()) ?? short(collection)} #${itemId}`;
  const art = { reads: pictureReads, chainId: source.manifest.chainId, ipfs: source.art ?? [] };
  const allowance = book ? allowanceV2(book, config, now) : null;
  // Gives and picks open at graduation (the coordinator opens the shop then); they need the book to show.
  const graduated = view.graduated && !view.failed;
  const open = graduated && book !== null && book.openedAt !== null;
  const active = pending && account && same(pending.account, account) ? pending.action : null;
  const canSend = account !== null && !disabled && !wrong && !busy && pressing === null;

  const begin = (action: Action) => { setMessage(null); if (!account) setDialog(true); else setPending({ action, account }); };
  const confirm = async () => {
    if (!active || !canSend || !account || !wallet.signer) return;
    // An addition needs no book (the curator, the next addition and the list come with the snapshot).
    setBusy(true); setMessage(null);
    const sendIO = (io ?? ((request) => shopActionIO(source, view, request)))(wallet.signer.request);
    try {
      await sendAddCollectionV2(source, view, book, account, active.collection, active.tier, sendIO);
      setMessage('Confirmed. Reading the updated shop…');
      setPending(null); setAddText('');
      await refreshWalletReads(queries, ['v2-shop-book', 'v2-shop-item', 'v2-shop-own']);
    } catch (error) {
      setMessage(shopErrorText(error, 'addition'));
    } finally { setBusy(false); }
  };
  /**
   * SH-297: one press of Pick or Give. Not connected: the wallet window, nothing else. Then the press itself
   * (shop-actions.ts), its approval first when one is needed; each refusal's own line as before.
   */
  const press = async (kind: 'pick' | 'give', run: (sendIO: ShopActionIO, hooks: Parameters<typeof pressPickV2>[7]) => Promise<unknown>) => {
    setMessage(null); setPending(null);
    if (!account) { setDialog(true); return; }
    if (!canSend || !wallet.signer) return;
    if (!book) { setMessage('Items and this week’s limits unavailable.'); return; }
    const sendIO = (io ?? ((request) => shopActionIO(source, view, request)))(wallet.signer.request);
    setSteps(null); setPressing({ kind, phase: 'idle' });
    let failed: unknown = null;
    try {
      await run(sendIO, { phase: (phase) => setPressing({ kind, phase }), progress: (progress) => setSteps(progress ? { kind, progress } : null) });
    } catch (error) { failed = error; }
    setPressing(null);
    if (failed !== null) { setMessage(shopErrorText(failed, kind === 'pick' ? 'pick' : 'give')); return; }
    setMessage('Confirmed. Reading the updated shop…');
    if (kind === 'give') setGiveKey(null);
    if (kind === 'pick') setPickKey(null);
    await refreshWalletReads(queries, ['v2-shop-book', 'v2-shop-item', 'v2-shop-own']);
  };
  /** What a press's button says: its word, or where the press is (the buy and sell box's words). */
  const pressLabel = (kind: 'pick' | 'give', word: string) => {
    if (pressing?.kind !== kind) return word;
    if (pressing.phase === 'confirm') return PRESS_WORDS.confirm(wallet.signer?.confirmsInPage === true);
    if (pressing.phase === 'mining') return PRESS_WORDS.mining;
    if (pressing.phase === 'approval') return PRESS_WORDS.approval;
    return word;
  };

  // What a give takes now: the chosen card's tier price, within the week's limits and the budget. The line speaks of the
  // chosen card only (SH-297 notes); before a choice, each tile whose collection takes gives only later carries its date.
  const mineCards = ownCards?.status === 'ready' ? ownCards.cards : [];
  const chosen = mineCards.find((card) => `${card.collection.toLowerCase()}:${card.id}` === giveKey) ?? null;
  const entry = chosen ? book?.entries.get(chosen.collection.toLowerCase()) ?? null : null;
  const giveT = chosen ? giveOf(chosen.collection) : null;
  const block = book && entry && giveT !== null ? giveBlockV2(book, allowance, entry.collection, giveT, now) : null;
  const giveLine = !entry ? null : block === 'waiting' ? `Takes gives from ${utcDate(entry.activeAt)}.` : block ? limitLine(block, book?.week?.endsAt ?? null) : null;
  const giveReady = chosen !== null && giveT !== null && block === null;
  /** A tile's collection that takes gives only later: its start, short ("from 2 Dec"); null otherwise. */
  const startsLater = (collection: string) => { const e = book?.entries.get(collection.toLowerCase()); return e && now < e.activeAt ? e.activeAt : null; };
  // What a pick takes now: the chosen item's fixed pick price; the last item stays.
  const picked = items.find((held) => `${held.collection.toLowerCase()}:${held.id}` === pickKey) ?? null;
  const pickT = picked ? pickOf(picked.collection) : null;
  const lastStays = items.length <= 1;
  const tooFew = coins !== null && pickT !== null && coins.balance < pickT;
  const pickReady = picked !== null && pickT !== null && !lastStays && !tooFew;
  // The curator's addition.
  const curator = view.m2?.money?.shop?.curator ?? null;
  const isCurator = account !== null && same(curator, account) && !view.failed;
  const nextAt = view.m2?.money?.shop?.nextAdditionAt ?? 0n;
  const listed = added ? found.collections.some((collection) => same(collection, added)) : false;
  const addLine = addText.trim() === '' ? null : added === null ? 'Use an address like 0x12…, 42 characters.' : listed ? 'This collection is listed already.'
    : addCheck.data === 'no-code' ? 'No contract at this address.' : addCheck.data === 'not-erc721' ? 'Not an ERC-721 collection.' : null;
  const addReady = added !== null && !listed && addCheck.data === 'erc721' && now >= nextAt;

  const confirmText = (action: Action): ReactNode => {
    switch (action.kind) {
      case 'add': return `Add ${short(action.collection)} at tier ${action.tier + 1}? It takes gives ${waitWords(config.listDelay)} after it is added.`;
    }
  };

  return <div className="sh-v2-shop-actions">
    {bookFailed ? <p role="status">Items and this week’s limits unavailable.</p> : null}
    {!graduated && !view.failed ? <p>Gives and picks open after graduation.</p> : null}
    {open && book ? <section className="sh-v2-shop-act" aria-labelledby="sh-shop-pick">
      <h3 id="sh-shop-pick">Pick an item</h3>
      {items.length === 0 ? <p>No items inside yet.</p> : lastStays ? <p>The last item stays.</p> : null}
      {items.length > 0 ? <ul className="sh-v2-shop-items sh-v2-shop-cards" aria-label="Items inside">
        {items.slice(0, shown).map((held) => {
          const k = `${held.collection.toLowerCase()}:${held.id}`; const price = pickOf(held.collection);
          return <li key={k}><ShopCard {...art} collection={held.collection} id={held.id} pressed={pickKey === k} disabled={lastStays}
            label={`${nameOf(held.collection)} #${held.id}, ${price !== null ? t(price) : 'price unavailable'}`} title={`${nameOf(held.collection)} #${held.id}`}
            name={cardName(held.collection, held.id)} price={price !== null ? t(price) : '—'} onPress={() => { setPickKey(k); setPending(null); }} /></li>;
        })}
      </ul> : null}
      {items.length > shown ? <button type="button" className="sh-button" onClick={() => setShown((n) => n + PICK_PAGE)}>{`Show ${Math.min(PICK_PAGE, items.length - shown)} more`}</button> : null}
      {tooFew ? <p>More than this wallet holds.</p> : null}
      <div className="sh-v2-actions">
        <button ref={primary} type="button" className="sh-button sh-button--primary" disabled={(account !== null && !canSend) || !pickReady}
          onClick={() => picked && pickT !== null && void press('pick', (sendIO, hooks) => pressPickV2(source, view, book as ShopBookV2, account as Address, picked, pickT, sendIO, hooks))}>{pressLabel('pick', pickT !== null ? `Pick · ${t(pickT)}` : 'Pick')}</button>
      </div>
      {steps?.kind === 'pick' ? <PressSteps progress={steps.progress} act="Pick" /> : null}
    </section> : null}
    {open && book && ownCards && !(ownCards.status === 'ready' && mineCards.length === 0 && !ownCards.more && ownCards.unfound === 0n) && ownCards.status !== 'reading' ? <section className="sh-v2-shop-act" aria-labelledby="sh-shop-give">
      <h3 id="sh-shop-give">Give an item</h3>
      {ownCards.status === 'failed' ? <div className="sh-part-failed"><p>Items unavailable.</p><button type="button" className="sh-button" onClick={ownCards.retry}>{FEED_WORDS.retry}</button></div>
        : <ul className="sh-v2-shop-cards" aria-label="Your items">
          {mineCards.map((card) => {
            const k = `${card.collection.toLowerCase()}:${card.id}`; const get = giveOf(card.collection); const later = startsLater(card.collection);
            return <li key={k}><ShopCard {...art} collection={card.collection} id={card.id} pressed={giveKey === k}
              label={`${nameOf(card.collection)} #${card.id}, ${get !== null ? t(get) : 'price unavailable'}${later !== null ? `, takes gives from ${utcDate(later)}` : ''}`} title={`${nameOf(card.collection)} #${card.id}`}
              name={cardName(card.collection, card.id)} price={<>{get !== null ? t(get) : '—'}{later !== null ? <span className="sh-v2-shop-card__later" aria-hidden="true">{startMark(later, now)}</span> : null}</>}
              onPress={() => { setGiveKey(k); setPending(null); }} /></li>;
          })}
        </ul>}
      {ownCards.status === 'ready' && ownCards.more ? <p>More than shown here.</p> : null}
      {ownCards.status === 'ready' && ownCards.unfound > 0n ? <p>{unfoundLine(ownCards.unfound)}</p> : null}
      {giveLine ? <p>{giveLine}</p> : null}
      <div className="sh-v2-actions">
        <button type="button" className="sh-button sh-button--primary" disabled={(account !== null && !canSend) || !giveReady}
          onClick={() => chosen && giveT !== null && void press('give', (sendIO, hooks) => pressGiveV2(source, view, book as ShopBookV2, account as Address, chosen.collection, chosen.id, giveT, sendIO, hooks))}>{pressLabel('give', giveT !== null ? `Give · ${t(giveT)}` : 'Give')}</button>
      </div>
      {steps?.kind === 'give' ? <PressSteps progress={steps.progress} act="Give" /> : null}
    </section> : null}
    {isCurator ? <section className="sh-v2-shop-act" aria-labelledby="sh-shop-add">
      <h3 id="sh-shop-add">Add a collection</h3>
      <label className="sh-v2-shop-field">Collection address<input className="sh-newbox-input" spellCheck={false} placeholder="0x…" value={addText} onChange={(e) => { setAddText(e.target.value); setPending(null); }} /></label>
      <div className="sh-m2-chips" role="group" aria-label="Tier of the new collection">
        {config.givePricesT.map((price, tier) => <button key={tier} type="button" className="sh-button" aria-pressed={addTier === tier} onClick={() => { setAddTier(tier); setPending(null); }}>{`Tier ${tier + 1} · ${t(price)}`}</button>)}
      </div>
      <p>{`Takes gives from about ${utcDate(now + BigInt(config.listDelay))}, ${waitWords(config.listDelay)} after it is added.`}</p>
      {now < nextAt ? <p>{`Next addition from ${utcDate(nextAt)}.`}</p> : null}
      {addLine ? <p>{addLine}</p> : null}
      <div className="sh-v2-actions">
        <button type="button" className="sh-button" disabled={!canSend || !addReady} onClick={() => added && begin({ kind: 'add', collection: added, tier: addTier })}>Add collection</button>
      </div>
    </section> : null}
    {active ? <div role="group" aria-label="Confirm transaction" className="sh-v2-actions">
      <p>{confirmText(active)}</p>
      <button type="button" className="sh-button sh-button--primary" disabled={!canSend} onClick={() => void confirm()}>{busy ? 'Waiting for confirmation…' : 'Confirm'}</button>
      <button type="button" className="sh-button" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
    </div> : null}
    {message ? <p role="status">{message}</p> : null}
    {wrong ? <p>Use a browser wallet on this box’s network.</p> : null}
    <BrowserWalletDialog open={dialog && wallet.defaultDialog === 'browser'} onClose={() => setDialog(false)} returnFocus={primary} />
    {DEMO_BUILD ? <DemoWalletDialog open={dialog && wallet.defaultDialog === 'demo'} onClose={() => setDialog(false)} returnFocus={primary} /> : null}
  </div>;
}

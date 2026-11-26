import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isAddress, type Address } from 'viem';
import type { WriteCallV2, WriteTargetV2 } from '../../../../../../packages/chain/src/core/v2/write-calls-v2';
import { BrowserWalletDialog, DemoWalletDialog, useWallet } from '../../wallet';
import { DisclosureIcon } from '../../fit-pair/FitParts';
import type { InboxCoinV2, InboxHistoryV2, V2Snapshot, V2Source } from './indexer-v2';
import { utcTime } from '../../boxes/box-figure';
import { IN_KIND_WORDS, inboxIO, inboxTargetV2, readInboxControlV2, readInKindV2, sendInboxCallV2, type InboxControlV2 } from './inbox-upkeep';
import { InsufficientGasFundsError } from '@squarehole/chain/write';
import { gasFundsLine } from '../../tx/gas-words';
import { NATIVE_SYMBOL, WRAPPED_NATIVE_SYMBOL } from '../../data-source/native-coin';
import { TESTNET } from '../../data-source/testnet';

/** SH-258: the sale list (CoW, whole lots) where the test network has it; BNB Chain testnet does not (`cowSales`). */
const COW_SALES = TESTNET.switches.cowSales;

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;
const DAY = 86_400n;
/** The inbox's ETH, as its balances publish it under the zero address. */
const ETH_KEY = `0x${'0'.repeat(40)}`;
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const lotsText = (lots: bigint) => `${lots} ${lots === 1n ? 'lot' : 'lots'}`;

/**
 * Whether a listed coin's custody is below one lot (COW-2). SH-RC7 item 29: `observe(WETH)` and `refreshOrder(WETH)` wrap
 * the inbox's ETH first, so the WETH row counts that ETH too, as our keeper does (the published flag counts WETH
 * alone). With the ETH balance unread, the published flag stands.
 */
function belowOneLotOf(coin: InboxCoinV2, weth: string, balances: Readonly<Record<string, bigint>>): boolean {
  const eth = balances[ETH_KEY];
  if (coin.coin.toLowerCase() !== weth.toLowerCase() || eth === undefined) return coin.belowOneLot;
  const held = coin.balance + eth;
  return coin.lot > 0n && held > 0n && held < coin.lot;
}

/** A listed coin's sale and in-kind words (RC6 part 4 and COW-2), unchanged from the box page's first inbox panel. */
function waitWords(c: InboxCoinV2 | undefined, view: V2Snapshot, weth: string, balances: Readonly<Record<string, bigint>>, now: bigint): string {
  // Only a coin with a lot has a standing order (RC6 part 4: the indexer also publishes P, T, ETH and other coins it
  // learns from receipts, each with lot 0).
  if (!COW_SALES || !c || c.lot === 0n || view.failed) return '';
  // COW-2: below one lot nothing is offered; the payee's in-kind wait runs only from a clock an observation started.
  if (belowOneLotOf(c, weth, balances)) {
    if (c.oldestUnsoldAt === 0n) return ' · below one lot; waiting for observation to start the 30-day in-kind wait';
    const left = (c.oldestUnsoldAt + 30n * DAY - now + DAY - 1n) / DAY;
    return left > 0n ? ` · below one lot; the payee can claim in kind in ${left} days if the clock does not restart` : ' · below one lot; the payee can claim in kind now';
  }
  if (c.oldestUnsoldAt === 0n) return ' · for sale';
  const days = (c.oldestUnsoldAt + 30n * DAY - now + DAY - 1n) / DAY;
  return days > 0n ? ` · for sale, or the payee’s in ${days} days without a sale` : ' · for sale, or the payee’s now';
}

const ago = (now: bigint, at: bigint): string => {
  const days = now > at ? (now - at) / DAY : 0n;
  return days === 0n ? 'today' : days === 1n ? '1 day ago' : `${days} days ago`;
};

/**
 * SH-RC7-SITE-INBOX (INDEXER-INBOX request 1): a coin's history, numbers first: its last sale (what the inbox gave and
 * the P it got), its last refresh, and the totals that are not zero, each in the coin's raw units. SH-RC7-REVIEW: on the
 * price coin's own row (`inP`; the zero address in a box priced in ETH) every amount is P, so it reads in P: "Into the
 * box" is always P (`fundRoyalty` takes only the price coin), and the ETH flush totals exist only in a box priced in ETH.
 */
export function historyRows(h: InboxHistoryV2 | undefined, now: bigint, p: (amount: bigint) => string, inP = false): readonly (readonly [string, string])[] {
  if (!h) return [];
  const units = (amount: bigint) => (inP ? p(amount) : `${amount} raw units`);
  return [
    ...(COW_SALES && h.lastSale ? [['Last sale', `${units(h.lastSale.sellAmount)} for ${p(h.lastSale.buyAmount)} · ${ago(now, h.lastSale.at)}`] as const] : []),
    ...(COW_SALES && h.lastRefresh ? [['Last refresh', `${units(h.lastRefresh.balance)} · ${ago(now, h.lastRefresh.at)}`] as const] : []),
    ...(h.inKindClaimed > 0n ? [['Taken in kind', units(h.inKindClaimed)] as const] : []),
    ...(h.funded > 0n ? [['Into the box', units(h.funded)] as const] : []),
    ...(h.flushed > 0n ? [['Sent from the inbox', units(h.flushed)] as const] : []),
    ...(h.unwrapped > 0n ? [[`Unwrapped from ${WRAPPED_NATIVE_SYMBOL}`, units(h.unwrapped)] as const] : []),
  ];
}

/** One press of a public control or the payee's claim: the question its confirmation asks and the exact call it sends. */
export interface InboxPress { readonly question: string; readonly call: WriteCallV2 }

/**
 * The wallet only on a press: unconnected, the press opens the wallet window; connected, it asks one confirmation, then
 * sends through the checked sender. Each confirmed send re-reads the box.
 */
export function usePress(source: V2Source, view: V2Snapshot, disabled: boolean) {
  const wallet = useWallet(); const queries = useQueryClient();
  // The pressed button, where the wallet window returns focus (taken on the press, never during render).
  const returnTo = useRef<HTMLButtonElement | null>(null);
  const [dialog, setDialog] = useState(false);
  const [pending, setPending] = useState<{ readonly press: InboxPress; readonly account: Address } | null>(null);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState<string | null>(null);
  const account = wallet.status === 'connected' ? wallet.account : null;
  const wrong = account !== null && (wallet.chainId !== source.manifest.chainId || wallet.kind !== 'injected');
  const active = pending && pending.account.toLowerCase() === account?.toLowerCase() ? pending.press : null;
  const begin = (press: InboxPress) => {
    setMessage(null);
    if (document.activeElement instanceof HTMLButtonElement) returnTo.current = document.activeElement;
    if (!account) setDialog(true); else setPending({ press, account });
  };
  const confirm = async () => {
    if (!active || disabled || wrong || !account || !wallet.signer || busy) return;
    setBusy(true); setMessage(null);
    try {
      await sendInboxCallV2(inboxTargetV2(source, view), account, active.call, inboxIO(source, wallet.signer.request));
      setPending(null); setMessage('Confirmed. Reading the updated box…');
      await Promise.all(['v2-feed', 'v2-inbox-control', 'v2-in-kind', 'v2-launch-tax'].map((key) => queries.invalidateQueries({ queryKey: [key] })));
    } catch (error) { setMessage(error instanceof InsufficientGasFundsError ? gasFundsLine(error.chainId) : error instanceof Error ? error.message : 'Nothing confirmed. Try again.'); }
    finally { setBusy(false); }
  };
  const ui: ReactNode = <>
    {wrong ? <p>Connect a browser wallet on this box’s network.</p> : null}
    {active ? <div role="group" aria-label="Confirm transaction"><p>{active.question}</p>
      <button type="button" className="sh-button sh-button--primary" disabled={disabled || busy || wrong} onClick={() => void confirm()}>{busy ? 'Waiting for confirmation…' : 'Confirm'}</button>
      <button type="button" className="sh-button" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
    </div> : null}
    {message ? <p role="status">{message}</p> : null}
    <BrowserWalletDialog open={dialog && wallet.defaultDialog === 'browser'} onClose={() => setDialog(false)} returnFocus={returnTo} />
    {DEMO_BUILD ? <DemoWalletDialog open={dialog && wallet.defaultDialog === 'demo'} onClose={() => setDialog(false)} returnFocus={returnTo} /> : null}
  </>;
  return { begin, busy, ui, account };
}

const CONTROL_WORDS = (c: InboxControlV2, coin: string): { label: string; question: string } => c.kind === 'refresh'
  ? { label: `Refresh · ${lotsText(c.lots)}`, question: `Offer ${lotsText(c.lots)} of this coin for ${coin} on CoW?` }
  : c.reason === 'sale' ? { label: 'Record sale', question: 'Record this coin’s sale?' } : { label: 'Start clock', question: 'Start this coin’s 30-day clock?' };

/** A listed coin's public refresh or observe, read and dry-run first (`readInboxControlV2`); nothing while either says no. */
function CoinControl({ source, view, target, coin, priceCoin, press, disabled }: { source: V2Source; view: V2Snapshot; target: WriteTargetV2; coin: Address; priceCoin: string; press: ReturnType<typeof usePress>; disabled: boolean }) {
  const io = useMemo(() => inboxIO(source), [source]);
  const query = useQuery({ queryKey: ['v2-inbox-control', source.manifest.chainId, target.royaltyRouter, coin.toLowerCase(), view.block.toString()],
    queryFn: () => readInboxControlV2(io, target, coin), retry: false, staleTime: Infinity });
  const control = query.data;
  if (!control) return null;
  const words = CONTROL_WORDS(control, priceCoin);
  return <button type="button" className="sh-button" disabled={disabled || press.busy} onClick={() => press.begin({ question: words.question, call: control.call })}>{words.label}</button>;
}

/** IDX-SITE-1: the zero address takes the inbox's ETH as WETH (`claimInKind` wraps it first), so the page names WETH. */
const paidName = (paid: Address, token: Address) => paid.toLowerCase() === token.toLowerCase() ? short(token) : `${WRAPPED_NATIVE_SYMBOL} (${short(paid)})`;
const paidWords = (paid: Address, token: Address) => paid.toLowerCase() === token.toLowerCase() ? '' : ` of ${WRAPPED_NATIVE_SYMBOL}`;

/** The payee's in-kind claim: a coin address, checked by the claim's own dry run from the payee before Take shows. */
function InKindV2({ source, view, target, weth, payee, press, disabled }: { source: V2Source; view: V2Snapshot; target: WriteTargetV2; weth: Address; payee: Address; press: ReturnType<typeof usePress>; disabled: boolean }) {
  const io = useMemo(() => inboxIO(source), [source]);
  const [text, setText] = useState('');
  const typed = text.trim();
  const token = isAddress(typed) ? (typed as Address) : null;
  const query = useQuery({ queryKey: ['v2-in-kind', source.manifest.chainId, target.royaltyRouter, payee.toLowerCase(), token?.toLowerCase(), view.block.toString()],
    queryFn: () => readInKindV2(io, target, weth, payee, token as Address), enabled: token !== null, retry: false, staleTime: Infinity });
  const answer = token ? query.data : undefined;
  return <div className="sh-v2-in-kind">
    <label>Coin to take<input className="sh-newbox-input sh-v2-address" spellCheck={false} autoComplete="off" placeholder="0x…" value={text} onChange={(e) => setText(e.target.value)} /></label>
    {typed !== '' && token === null ? <p>Enter a coin address.</p> : null}
    {token && query.isError ? <p>Unavailable. Try again.</p> : null}
    {answer?.kind === 'refused' ? <p>{IN_KIND_WORDS[answer.reason]}{answer.notBefore !== undefined ? ` While the box is live: not before ${utcTime(Number(answer.notBefore) * 1000, 0)}.` : ''}</p> : null}
    {answer?.kind === 'ready' && token ? <p className="sh-v2-in-kind__ready"><span className="sh-v2-value">{`${answer.amount} raw units${paidWords(answer.paid, token)}`}</span>
      <button type="button" className="sh-button sh-button--primary" disabled={disabled || press.busy}
        onClick={() => press.begin({ question: `Take ${answer.amount} raw units of ${paidName(answer.paid, token)} to your wallet?`, call: answer.call })}>Take</button></p> : null}
  </div>;
}

/**
 * RC6 (F138): the box's income inbox, read at the snapshot hash. The box offers listed coins for P on CoW (our poster
 * posts the orders; no sale is promised); a listed coin with no sale for 30 days, and every other coin, can be taken by
 * the creator's payee as it is (claimInKind: nothing is sent by itself); a failed box offers nothing more. `weth`: the
 * chain's WETH (the deployment manifest's), whose row counts the inbox's ETH toward one lot.
 *
 * SH-RC7-SITE-INBOX (rc7 open item 11): opened, each listed coin offers its public refresh or observation when the
 * chain says it would do something now (read and dry-run first), each coin's history is one press away, and the
 * connected payee can take a coin by its address. Nothing is read from the chain until the panel is opened.
 */
export function InboxV2({ view, source, now, p, coin, disabled }: { view: V2Snapshot; source: V2Source; now: bigint; p: (amount: bigint) => string; coin: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const press = usePress(source, view, disabled);
  const weth = source.manifest.chain.weth.address as Address;
  const inbox = view.money?.inbox ?? null;
  const target = useMemo(() => { try { return inboxTargetV2(source, view); } catch { return null; } }, [source, view]);
  const listed = new Map((inbox?.coins ?? []).map((c) => [c.coin.toLowerCase(), c]));
  const priceCoin = view.record.q.toLowerCase();
  const eth = inbox?.balances[ETH_KEY] ?? 0n;
  // A coin shows while the inbox holds some of it, or while it has a history to show (a coin that sold out).
  // SH-RC7-REVIEW: a listed WETH also shows while the inbox holds only ETH, which its refresh and observation wrap
  // first: royalties paid in ETH get their public control on the WETH row.
  const held = inbox ? [...new Set([...Object.keys(inbox.balances), ...listed.keys()])]
    .map((token) => ({ token, amount: listed.get(token)?.balance ?? inbox.balances[token] ?? 0n, coin: listed.get(token) }))
    .filter((h) => h.amount > 0n || historyRows(h.coin?.history, now, p).length > 0
      || (h.token === weth.toLowerCase() && (h.coin?.lot ?? 0n) > 0n && eth > 0n)) : [];
  const live = open && !disabled && target !== null && target.royaltyRouter !== undefined && !view.failed;
  const payee = inbox && press.account && press.account.toLowerCase() === inbox.payee.toLowerCase() ? inbox.payee : null;
  return <details className="sh-fit-details" onToggle={(e) => setOpen(e.currentTarget.open)}><summary><span className="sh-fit-details__chevron" aria-hidden="true"><DisclosureIcon /></span>Inbox</summary>
    <p>{view.money ? `Royalties in ${coin} in the box: ${p(view.money.owed.royaltyHeldP)}` : 'Current balances unavailable.'}</p>
    {inbox ? <p className="sh-v2-address">{inbox.router}</p> : <p>Inbox balances unavailable.</p>}
    {inbox && !inbox.complete ? <p>Some coins could not be read.</p> : null}
    {held.map((h) => {
      const rows = historyRows(h.coin?.history, now, p, h.token === priceCoin);
      return <div className="sh-v2-inbox-coin" key={h.token} data-coin={h.token}>
        <p className="sh-v2-address">{`${h.token}: ${h.amount} raw units${waitWords(h.token === ETH_KEY && priceCoin !== ETH_KEY ? listed.get(weth.toLowerCase()) : h.coin, view, weth, inbox?.balances ?? {}, now)}`}</p>
        {COW_SALES && live && target && h.coin && h.coin.lot > 0n ? <CoinControl source={source} view={view} target={target} coin={h.coin.coin} priceCoin={coin} press={press} disabled={disabled} /> : null}
        {rows.length > 0 ? <details className="sh-v2-history"><summary>History</summary>
          <dl>{rows.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl></details> : null}
      </div>;
    })}
    <p>{`${view.failed ? `${COW_SALES ? 'This box sells nothing more. ' : ''}The creator’s payee can take its coins other than ${coin} as they are; ${coin} here joins the claim pot.`
      : COW_SALES ? `Royalties and gifts in other coins arrive here. The box offers coins on its sale list for ${coin} on CoW, in whole lots. If one does not sell for 30 days, the creator’s payee can take it as it is, and any other coin at any time.`
        : 'Royalties and gifts in other coins arrive here.'}${
      priceCoin !== ETH_KEY ? ` ${NATIVE_SYMBOL} is taken as ${WRAPPED_NATIVE_SYMBOL}.` : ''}`}</p>
    {open && !disabled && target && payee ? <InKindV2 source={source} view={view} target={target} weth={weth} payee={payee} press={press} disabled={disabled} /> : null}
    {press.ui}
  </details>;
}

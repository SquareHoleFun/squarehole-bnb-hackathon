import { useState } from 'react';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Address } from 'viem';
import { formatUnits } from '@squarehole/domain';
import { InsufficientGasFundsError, NotSendableError, preSendRefusalText } from '@squarehole/chain/write';
import { gasFundsLine } from '../../tx/gas-words';
import { itemPoliciesV2 } from '../../../../../../packages/chain/src/core/v2';
import { useWallet } from '../../wallet';
import { itemReadOptions, itemSessionKey, itemTSessionKey } from './claim-reads';
import type { V2Snapshot, V2Source } from './indexer-v2';
import { claimableItem, itemCandidates, itemPages, itemState, withItemClaim, type ItemSession, type ItemState } from './item-claims';
import { m3ActionIO, sendItemClaimTV2, sendItemClaimV2, sendItemSyncV2 } from './m3-actions';
import type { SidePolicy } from './m3-data';
import { itemsInP, itemsInT, type PayoutAsset } from './payouts-t';
import { buyBackBurnLabel } from '../../create/v2/fee-words';

/** One to three words per state; the panel's Details say the rest. */
const LABEL: Readonly<Record<ItemState['kind'], string>> = {
  claimed: 'Claimed', ready: 'Ready', paused: 'Paused', unchecked: 'Not checked', syncing: 'Needs sync', waiting: 'After graduation', none: 'None', other: 'Not yours', unknown: 'Unavailable',
};
const RULE: Readonly<Record<SidePolicy, string>> = { 0: '', 1: 'Keep', 2: 'Burn', 3: 'Grow the pool' };
type Pending = { readonly account: Address; readonly id: bigint; readonly amount: bigint; readonly coin: PayoutAsset };
/** A long exact figure (a Keep base over many items has 18 repeating decimals) takes its own row on a phone. */
const wide = (text: string) => (text.length > 18 ? 'sh-m3-figures__wide' : undefined);
/** The vault's rule takes its own row on a phone, and at every width once it is longer than a figure column holds. */
const ruleRow = (text: string) => (text.length > 18 ? 'sh-m3-figures__wide sh-m3-figures__row' : 'sh-m3-figures__wide');
type Note = { readonly account: Address; readonly text: string };

/** "Keep", "Buy back and burn <ticker>", "Grow the pool", or each side's rule when they differ (a side that pays elsewhere is left out). */
export function inVaultText(policies: { readonly buyers: SidePolicy; readonly sellers: SidePolicy }, ticker = ''): string {
  const { buyers, sellers } = policies;
  const rule = (p: SidePolicy) => (p === 2 ? buyBackBurnLabel(ticker || 'the box coin') : RULE[p]);
  if (buyers === 0 || sellers === 0 || buyers === sellers) return rule(buyers || sellers);
  return `Buyers ${rule(buyers)} · Sellers ${rule(sellers)}`;
}

/**
 * Item payouts of one wallet (M3-53, F127): each item it holds is one row with its own Claim (the ledger claims one
 * item per call). Claim all, on the page's "Your claims" panel (F128), claims these with the box's other claims. The
 * wallet is asked only when Claim or Sync is pressed. The claim-state rule lives in item-claims.ts; the reads in
 * claim-reads.ts.
 */
export function ItemPayoutsV2({ view, source, symbol, ticker, disabled }: { view: V2Snapshot; source: V2Source; symbol: string; ticker: string; disabled: boolean }) {
  const wallet = useWallet(); const queries = useQueryClient();
  const [pending, setPending] = useState<Pending | null>(null);
  const [progress, setProgress] = useState<string | null>(null); const [note, setNote] = useState<Note | null>(null);
  const [typed, setTyped] = useState(''); const [page, setPage] = useState(0);
  const chainId = source.manifest.chainId;
  const items = view.m3?.items ?? null;
  const account = wallet.status === 'connected' ? wallet.account : null;
  const ledger = view.claimRow?.contracts.itemLedger ?? null;
  const sessionKey = itemSessionKey(chainId, ledger, account);
  // This session's knowledge outlives panel remounts; after a reload the wallet claims index brings back recent payments
  // (claim-reads.ts). It is written only through item-claims.ts.
  const { data: session = {} } = useQuery<ItemSession>({ queryKey: sessionKey, queryFn: skipToken, gcTime: Infinity, staleTime: Infinity });
  // v2.1 step 2: the same items' credit in the box token, claimed apart (claimT), when a side pays items in T.
  const sessionTKey = itemTSessionKey(chainId, ledger, account);
  const { data: sessionT = {} } = useQuery<ItemSession>({ queryKey: sessionTKey, queryFn: skipToken, gcTime: Infinity, staleTime: Infinity });
  const paysP = itemsInP(view.spec); const paysT = itemsInT(view.spec);
  // v2.1 step 5: the spec's Grow the pool (Depth) sides, and whether one of them is paid in T (its inside share stays in P).
  const policies = itemPoliciesV2(view.spec);
  const depthSides = (['buyers', 'sellers'] as const).filter((side) => policies[side] === 3);
  const depthInT = depthSides.some((side) => view.spec[side].a.leg === 2);
  const first = view.spec.firstId; const last = first + BigInt(view.spec.n);
  const extra = /^[1-9][0-9]{0,77}$/.test(typed) && BigInt(typed) >= first && BigInt(typed) < last ? BigInt(typed) : null;
  // M363-OC01: the typed item and every pending receipt on every page, the rest paged (More items).
  const candidates = account ? itemCandidates(items, session, extra, page, account) : [];
  const pages = account ? itemPages(items, session, extra, account) : 1;
  const wrong = account !== null && (wallet.chainId !== chainId || wallet.kind !== 'injected');
  // Another wallet, network or wallet kind drops any open confirmation and note (also on switching back).
  const scope = `${account}:${wallet.chainId}:${wallet.kind}`;
  const [seenScope, setSeenScope] = useState(scope);
  if (seenScope !== scope) { setSeenScope(scope); setPending(null); setNote(null); setPage(0); }

  const reads = useQuery({ ...itemReadOptions(queries, source, view, account, candidates), enabled: account !== null && ledger !== null && !disabled && candidates.length > 0 });
  const readFailed = reads.isError || (reads.data?.failed ?? 0) > 0;
  // Rows: this page's items, and every item read or claimed on any page this session (paging never hides one); an item
  // with credit in both coins has a row for each.
  const known = (s: ItemSession) => Object.entries(s).filter(([, k]) => k.claim || k.read).map(([id]) => BigInt(id));
  const shownIds = [...new Set([...(reads.data?.mine ?? []), ...known(session), ...known(sessionT)].map(String))].map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const statesOf = (s: ItemSession, coin: PayoutAsset) => (account ? shownIds.map((id) => ({ id, coin, state: itemState(s[id.toString()], account) })) : []);
  const states = [...(paysP || !paysT ? statesOf(session, 'P') : []), ...(paysT ? statesOf(sessionT, 'T') : [])];
  const rows = states.filter((row) => !['none', 'other', 'unknown'].includes(row.state.kind)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.coin === b.coin ? 0 : a.coin === 'P' ? -1 : 1));
  const ready = rows.flatMap(({ id, coin, state }) => { const amount = claimableItem(state); return amount === null ? [] : [{ id, coin, amount }]; });
  const syncing = rows.some((row) => row.state.kind === 'syncing');
  const answered = states.some((row) => row.state.kind !== 'unknown');
  const p = (amount: bigint) => `${formatUnits(amount, view.decimals)} ${symbol}`;
  const t = (amount: bigint) => `${formatUnits(amount, 18)} ${ticker}`;
  const show = (coin: PayoutAsset) => (coin === 'T' ? t : p);
  // One total per coin the box pays items in; the two are never added up.
  const sum = (coin: PayoutAsset) => ready.filter((item) => item.coin === coin).reduce((total, item) => total + item.amount, 0n);
  const totals = [...(paysP || !paysT ? [p(sum('P'))] : []), ...(paysT ? [t(sum('T'))] : [])];
  const canSend = account !== null && !disabled && !wrong && progress === null;
  const active = pending !== null && pending.account === account ? pending : null;
  const status = !account ? 'Choose a wallet' : disabled ? 'Unavailable' : reads.isFetching && !answered ? 'Reading…' : ready.length ? `${ready.length} ready`
    : syncing ? 'Needs sync' : rows.length ? 'None ready' : candidates.length === 0 ? 'No items out yet' : 'Nothing to claim';

  const ask = (id: bigint, amount: bigint, coin: PayoutAsset) => {
    setNote(null);
    if (account) setPending({ account, id, amount, coin });
  };
  const confirm = async () => {
    if (!active || !canSend || !wallet.signer) return;
    const { id, amount, coin } = active; const signer = wallet.signer; const at = view; const key = coin === 'T' ? sessionTKey : sessionKey;
    // A confirmation names an exact amount; any change since then needs a fresh look.
    if (claimableItem(itemState((coin === 'T' ? sessionT : session)[id.toString()], active.account)) !== amount) {
      setPending(null); setNote({ account: active.account, text: 'Changed. Review and confirm again.' }); return;
    }
    setPending(null); setProgress('Waiting for confirmation…');
    try {
      const send = coin === 'T' ? sendItemClaimTV2 : sendItemClaimV2;
      const receipt = await send(source, at, active.account, id, amount, m3ActionIO(source, at, signer.request));
      queries.setQueryData<ItemSession>(key, (s) => withItemClaim(s ?? {}, id, { tx: receipt.transactionHash, block: receipt.blockNumber, paidP: amount }));
    } catch (error) {
      // A timeout or rejection is not proof either way ("not confirmed", never "not paid"). A guard refusal happens
      // before the wallet: the shared sender admits only claim([one item], caller) to the item ledger.
      // SH-SEND-FEES: the funds check stops it before the wallet too, and says what helps.
      // SH-258 round 3b: a price or gas-limit refusal never reached the wallet: its own line.
      const refusal = preSendRefusalText(error);
      setNote({ account: active.account, text: refusal ? `Item #${id} not sent. ${refusal}` : error instanceof InsufficientGasFundsError ? `Item #${id} not sent. ${gasFundsLine(error.chainId)}`
        : error instanceof NotSendableError
        ? `Item #${id} not sent. Nothing reached your wallet.`
        : `Item #${id} not confirmed. Refresh, then try again.` });
    } finally { setProgress(null); }
    await queries.invalidateQueries({ queryKey: ['v2-feed'] });
  };
  const sync = async () => {
    if (!account || !canSend || !wallet.signer) return;
    setNote(null); setProgress('Syncing…');
    try {
      await sendItemSyncV2(source, view, account, m3ActionIO(source, view, wallet.signer.request));
      setNote({ account, text: 'Synced. Reading the updated box…' });
    } catch (error) {
      const refusal = preSendRefusalText(error);
      setNote({ account, text: refusal ? `Sync not sent. ${refusal}` : error instanceof InsufficientGasFundsError ? `Sync not sent. ${gasFundsLine(error.chainId)}`
        : error instanceof NotSendableError ? 'Sync not sent. Nothing reached your wallet.' : 'Sync not confirmed. Try again.' });
    } finally { setProgress(null); }
    await queries.invalidateQueries({ queryKey: ['v2-feed'] });
  };

  return <section className="sh-panel sh-m3-items" aria-label="Item payouts"><h2>Item payouts</h2>
    <p className="sh-v2-value" data-coins={totals.length > 1 ? 'several' : undefined}>{account && answered ? totals.map((text, i) => <span key={text} className="sh-v2-claims__sum">{i > 0 ? <span className="sh-visually-hidden"> · </span> : null}{text}</span>) : `— ${paysP || !paysT ? symbol : ticker}`}</p>
    <p className="sh-m2-chips"><span role="status">{status}</span>
      {account && readFailed && !reads.isFetching ? <button type="button" className="sh-chip sh-chip--pending" aria-label="Read failed. Retry" onClick={() => void reads.refetch()}>Retry</button> : null}
    </p>
    {items ? <dl className="sh-m3-figures">
      {paysP ? <div className={wide(p(items.paidPerItem))}><dt>Paid per item</dt><dd>{p(items.paidPerItem)}</dd></div> : null}
      {paysP ? <div className={wide(view.m3?.itemBalanceP != null ? p(view.m3.itemBalanceP) : '')}><dt>Item ledger</dt><dd>{view.m3?.itemBalanceP != null ? p(view.m3.itemBalanceP) : 'Unavailable'}</dd></div> : null}
      {paysT ? <div className={wide(view.payInT?.money ? t(view.payInT.money.itemBalanceT) : '')}><dt>{`Item ledger · ${ticker}`}</dt><dd>{view.payInT?.money ? t(view.payInT.money.itemBalanceT) : 'Unavailable'}</dd></div> : null}
      <div className={ruleRow(inVaultText(items.policies, ticker))}><dt>In the vault</dt><dd>{inVaultText(items.policies, ticker)}</dd></div>
    </dl> : <p>Item history unavailable.</p>}
    {rows.length ? <ul className="sh-m2-batches" aria-label="Items">{rows.map(({ id, coin, state }) => {
      const amount = 'amount' in state ? show(coin)(state.amount) : '—';
      const claimable = claimableItem(state);
      return <li key={`${id}:${coin}`} data-state={state.kind} data-coin={coin}>
        <span className="sh-m2-payout"><span className="sh-m2-batch">{`Item #${id}`}{'stash' in state && state.stash > 0n ? ` · stash ${show(coin)(state.stash)}` : ''}</span><span className="sh-m2-amount">{amount}</span></span>
        <span className="sh-chip">{LABEL[state.kind]}</span>
        {claimable !== null ? <button type="button" className="sh-button" aria-label={coin === 'T' ? `Claim item ${id} in ${ticker}` : `Claim item ${id}`} disabled={!canSend} onClick={() => ask(id, claimable, coin)}>Claim</button> : null}
      </li>;
    })}</ul> : null}
    {account ? <div className="sh-v2-actions">
      <button type="button" className="sh-button" disabled={disabled || progress !== null || candidates.length === 0} onClick={() => { setPending(null); void reads.refetch(); }}>Refresh</button>
      {syncing ? <button type="button" className="sh-button" disabled={!canSend} onClick={() => void sync()}>Sync</button> : null}
      {pages > 1 ? <button type="button" className="sh-button" aria-label={`More items, page ${((page + 1) % pages) + 1} of ${pages}`} disabled={disabled || reads.isFetching} onClick={() => setPage((page + 1) % pages)}>More items</button> : null}
    </div> : null}
    {active ? <div role="group" aria-label="Confirm claim">
      <p>{`Item #${active.id} · ${show(active.coin)(active.amount)}`}</p>
      <p className="sh-v2-address">{`To ${active.account}`}</p>
      <button type="button" className="sh-button sh-button--primary" disabled={!canSend} onClick={() => void confirm()}>Confirm</button>
      <button type="button" className="sh-button" onClick={() => setPending(null)}>Cancel</button>
    </div> : null}
    {progress ? <p role="status">{progress}</p> : null}
    {note && note.account === account ? <p role="status">{note.text}</p> : null}
    {wrong ? <p>Use a browser wallet on this box’s network.</p> : null}
    <details><summary>Item payout details</summary>
      <p>{`Every item of this collection gets an equal share of each payout, in ${paysP ? symbol : ticker}${paysP && paysT ? ` or ${ticker}` : ''}. The item’s current owner claims it; nothing is sent automatically. No expiry, no minimum. A transfer keeps the unclaimed share with the item.`}</p>
      {paysT ? <p>{`A side paid in ${ticker}: after graduation its fees buy ${ticker} in this box’s own pool, and each purchase is shared out over the items. Each coin is claimed on its own.`}</p> : null}
      <p>{`In the vault: Keep holds an item’s share as its stash until the item is out. ${buyBackBurnLabel(ticker)}: the share buys and burns ${ticker} in this box’s own pool.`}</p>
      {depthSides.length ? <p>{`Grow the pool: while an item is in the vault, its share goes into this box’s own pool for good, in ${symbol}; shares held before graduation go there too.${depthInT ? ` A side paid in ${ticker} buys ${ticker} only with the shares of items out of the vault, and each purchase is shared out over those items.` : ''}`}</p> : null}
      <p>Undrawn items share one hidden pool. Each draw takes its equal part, and its item gets it on delivery.</p>
      <p>An item picked just before a payout shares in it: fees and timing decide the result.</p>
      <p>A claim needs the ledger in step with its records. Anyone can press Sync; it moves no money.</p>
      <p>Claim all, under Your claims, claims every item with this box’s other claims, one signature each. With many items, More items reads the next ones.</p>
      <label>Check an item<input className="sh-newbox-input" inputMode="numeric" value={typed} onChange={(e) => { setTyped(e.target.value); setPending(null); }} /></label>
      <p className="sh-v2-address">{ledger ?? 'Item ledger unavailable'}</p><p>{`Each claim calls claim([item], your wallet) on the item ledger${paysT ? `, or claimT([item], your wallet) for ${ticker}` : ''}.`}</p>
    </details>
  </section>;
}

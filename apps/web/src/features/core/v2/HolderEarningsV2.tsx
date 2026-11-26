import { useState } from 'react';
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Address } from 'viem';
import { formatUnits } from '@squarehole/domain';
import { InsufficientGasFundsError, NotSendableError, preSendRefusalText } from '@squarehole/chain/write';
import { gasFundsLine } from '../../tx/gas-words';
import { useWallet } from '../../wallet';
import { holderActionIO, sendHolderClaimV2 } from './actions-v2';
import { holderReadOptions, holderSessionKey } from './claim-reads';
import { batchPages, batchState, batchesToRead, claimableNow, holderCandidates, withClaim, type BatchState, type HolderSession } from './holder-claims';
import type { V2Snapshot, V2Source } from './indexer-v2';
import { batchInT, holderHistoryOf } from './payouts-t';
import { UsdLine } from './UsdLineV2';
import { usdPriceFor } from './usd-v2';

/** One to three words per state; the panel's Details say the rest. */
const LABEL: Readonly<Record<BatchState['kind'], string>> = {
  claimed: 'Claimed', unconfirmed: 'Not confirmed, claim again', ready: 'Ready', paused: 'Paused', unchecked: 'Not checked',
  open: 'Open', funding: 'Awaiting funding', calculating: 'Calculating', none: 'None', unknown: 'Unavailable',
};
type Pending = { readonly account: Address; readonly batch: bigint; readonly amount: bigint };
type Note = { readonly account: Address; readonly text: string };

/** Whether a side pays holders in the box token (v2.1 step 2), or in the price coin. */
const holdsT = (view: V2Snapshot) => view.choices.buyers === 'holders-t' || view.choices.sellers === 'holders-t';
// Into the shop (v2.1 step 7) pays holders in P what the shop does not take.
const holdsP = (view: V2Snapshot) => view.choices.buyers === 'holders' || view.choices.sellers === 'holders' || view.choices.sellers === 'shop';

/**
 * The holder fee share of one wallet (M2-53, F127): each payout is one batch with its own Claim button. Claim all, on
 * the page's "Your claims" panel (F128), claims these with the box's other claims. The wallet is asked only when a
 * Claim is pressed. The claim-state rule and the read plan (OC-01: the typed batch and every pending receipt always
 * read, the rest paged) live in holder-claims.ts; the reads in claim-reads.ts.
 */
export function HolderEarningsV2({ view, source, symbol, ticker = 'T', disabled, nowSec }: { view: V2Snapshot; source: V2Source; symbol: string; ticker?: string; disabled: boolean; nowSec?: bigint }) {
  const wallet = useWallet(); const queries = useQueryClient();
  const [pending, setPending] = useState<Pending | null>(null);
  const [progress, setProgress] = useState<string | null>(null); const [note, setNote] = useState<Note | null>(null);
  const [typed, setTyped] = useState(''); const [page, setPage] = useState(0);
  const chainId = source.manifest.chainId;
  const account = wallet.status === 'connected' ? wallet.account : null;
  const ledger = view.claimRow?.contracts.holderLedger ?? null;
  const sessionKey = holderSessionKey(chainId, ledger, account);
  // This session's knowledge outlives panel remounts; after a reload the wallet claims index brings back recent payments
  // (claim-reads.ts). It is written only through holder-claims.ts.
  const { data: session = {} } = useQuery<HolderSession>({ queryKey: sessionKey, queryFn: skipToken, gcTime: Infinity, staleTime: Infinity });
  const extra = /^[1-9][0-9]{0,77}$/.test(typed) && BigInt(typed) < 2n ** 256n ? BigInt(typed) : null;
  // P batches and, for a side paid in the box token (v2.1 step 2), its T batches: each batch is paid in one coin.
  const history = holderHistoryOf(view);
  // A T batch's credit can grow after a claim (each later tranche), so it stays in the read plan.
  const grows = (batch: bigint) => batchInT(view.spec, batch);
  const batches = account ? batchesToRead(history, account, session, extra, page, grows) : [];
  const pages = account ? batchPages(history, account, session, extra, grows) : 1;
  const wrong = account !== null && (wallet.chainId !== chainId || wallet.kind !== 'injected');
  // Another wallet, network or wallet kind drops any open confirmation and note (also on switching back).
  const scope = `${account}:${wallet.chainId}:${wallet.kind}`;
  const [seenScope, setSeenScope] = useState(scope);
  if (seenScope !== scope) { setSeenScope(scope); setPending(null); setNote(null); setPage(0); }

  const reads = useQuery({ ...holderReadOptions(queries, source, view, account, batches), enabled: account !== null && ledger !== null && !disabled && batches.length > 0 });
  const readFailed = reads.isError || (reads.data?.failed ?? 0) > 0;
  // Rows: every batch of this page, and every batch read or claimed on any page this session (paging never hides one).
  const reading = new Set(batches.map(String));
  const shown = account ? holderCandidates(history, account, session, extra, grows).filter((batch) => reading.has(batch.toString()) || session[batch.toString()] !== undefined) : [];
  const states = shown.map((batch) => ({ batch, state: batchState(session[batch.toString()]) }));
  const rows = states.filter((row) => row.state.kind !== 'none');
  const ready = rows.flatMap(({ batch, state }) => { const amount = claimableNow(state); return amount === null ? [] : [{ batch, amount }]; });
  const known = states.some((row) => row.state.kind !== 'unknown');
  const p = (amount: bigint) => `${formatUnits(amount, view.decimals)} ${symbol}`;
  const t = (amount: bigint) => `${formatUnits(amount, 18)} ${ticker}`;
  /** A batch's amount in the coin it is paid in. */
  const of = (batch: bigint) => (batchInT(view.spec, batch) ? t : p);
  // One total per coin the box pays holders in; the two coins are never added up.
  const sum = (inT: boolean) => ready.filter((item) => batchInT(view.spec, item.batch) === inT).reduce((total, item) => total + item.amount, 0n);
  const totals = [...(holdsP(view) || !holdsT(view) ? [p(sum(false))] : []), ...(holdsT(view) ? [t(sum(true))] : [])];
  const canClaim = account !== null && !disabled && !wrong && progress === null;
  const active = pending !== null && pending.account === account ? pending : null;
  const status = !account ? 'Choose a wallet' : disabled ? 'Unavailable' : !known && reads.isFetching ? 'Reading…' : ready.length ? `${ready.length} ready`
    : rows.some((row) => row.state.kind !== 'unknown') ? 'None ready' : batches.length === 0 && !history ? 'Batch list unavailable' : 'Nothing to claim';

  const ask = (batch: bigint, amount: bigint) => {
    setNote(null);
    if (account) setPending({ account, batch, amount });
  };
  const confirm = async () => {
    if (!active || !canClaim || !wallet.signer) return;
    const { batch, amount } = active; const signer = wallet.signer; const at = view; const key = sessionKey;
    // A confirmation names an exact amount; any change since then needs a fresh look.
    if (claimableNow(batchState(session[batch.toString()])) !== amount) {
      setPending(null); setNote({ account: active.account, text: 'Changed. Review and confirm again.' }); return;
    }
    setPending(null); setProgress('Waiting for confirmation…');
    try {
      const receipt = await sendHolderClaimV2(source, at, active.account, batch, amount, holderActionIO(source, at, signer.request));
      queries.setQueryData<HolderSession>(key, (s) => withClaim(s ?? {}, batch, { tx: receipt.transactionHash, block: receipt.blockNumber, paidP: amount }));
    } catch (error) {
      // A timeout or rejection is not proof either way, so the note says "not confirmed", never "not paid". A refusal
      // by the shared sender's guard happens before the wallet, so that one says nothing was sent.
      // SH-SEND-FEES: the funds check stops it before the wallet too, and says what helps.
      // SH-258 round 3b: a price or gas-limit refusal never reached the wallet: its own line.
      const refusal = preSendRefusalText(error);
      setNote({ account: active.account, text: refusal ? `Batch ${batch} not sent. ${refusal}` : error instanceof InsufficientGasFundsError ? `Batch ${batch} not sent. ${gasFundsLine(error.chainId)}`
        : error instanceof NotSendableError
        ? `Batch ${batch} not sent. Nothing reached your wallet.`
        : `Batch ${batch} not confirmed. Refresh, then try again.` });
    } finally { setProgress(null); }
    await queries.invalidateQueries({ queryKey: ['v2-feed'] });
  };

  return <section className="sh-panel sh-m2-holders" aria-label="Holder fee share"><h2>Holder fee share</h2>
    <p className="sh-v2-value" data-coins={totals.length > 1 ? 'several' : undefined}>{account && known ? totals.map((sum, i) => <span key={sum} className="sh-v2-claims__sum">{i > 0 ? <span className="sh-visually-hidden"> · </span> : null}{sum}</span>) : `— ${holdsP(view) ? symbol : ticker}`}</p>
    {/* SH-266: the price-coin total in dollars, while the indexer's Atlas price is fresh. */}
    {account && known && nowSec !== undefined && (holdsP(view) || !holdsT(view)) ? <UsdLine raw={sum(false)} decimals={view.decimals} price={usdPriceFor(view.prices, view.record.q, nowSec)} nowSec={nowSec} /> : null}
    <p className="sh-m2-chips"><span role="status">{status}</span>
      {account && readFailed && !reads.isFetching ? <button type="button" className="sh-chip sh-chip--pending" aria-label="Read failed. Retry" onClick={() => void reads.refetch()}>Retry</button> : null}
    </p>
    {account && rows.length ? <ul className="sh-m2-batches" aria-label="Payouts">{rows.map(({ batch, state }) => {
      const amount = 'amount' in state && state.amount !== null ? of(batch)(state.amount) : '—';
      const claimable = claimableNow(state);
      return <li key={batch.toString()} data-state={state.kind}>
        <span className="sh-m2-payout"><span className="sh-m2-batch">{`Batch ${batch}`}</span><span className="sh-m2-amount">{amount}</span></span>
        <span className={state.kind === 'unconfirmed' ? 'sh-chip sh-chip--pending' : 'sh-chip'}>{state.kind === 'unknown' && reads.isFetching ? 'Reading…' : LABEL[state.kind]}</span>
        {claimable !== null ? <button type="button" className="sh-button" aria-label={`Claim batch ${batch}`} disabled={!canClaim} onClick={() => ask(batch, claimable)}>Claim</button> : null}
      </li>;
    })}</ul> : null}
    {account ? <div className="sh-v2-actions">
      <button type="button" className="sh-button" disabled={disabled || progress !== null || batches.length === 0} onClick={() => { setPending(null); void reads.refetch(); }}>Refresh</button>
      {pages > 1 ? <button type="button" className="sh-button" aria-label={`More batches, page ${((page + 1) % pages) + 1} of ${pages}`} disabled={disabled || reads.isFetching} onClick={() => setPage((page + 1) % pages)}>More batches</button> : null}
    </div> : null}
    {active ? <div role="group" aria-label="Confirm claim">
      <p>{`Batch ${active.batch} · ${of(active.batch)(active.amount)}`}</p>
      <p className="sh-v2-address">{`To ${active.account}`}</p>
      <button type="button" className="sh-button sh-button--primary" disabled={!canClaim} onClick={() => void confirm()}>Confirm</button>
      <button type="button" className="sh-button" onClick={() => setPending(null)}>Cancel</button>
    </div> : null}
    {progress ? <p role="status">{progress}</p> : null}
    {note && note.account === account ? <p role="status">{note.text}</p> : null}
    {wrong ? <p>Use a browser wallet on this box’s network.</p> : null}
    <details><summary>Fee share details</summary>
      <p>Holders claim their own payouts; nothing is sent automatically. No expiry, no minimum. Holder fees stay separate from the closing claim, including after failure. Claiming fees does not hand in your coins.</p>
      <p>Only funded, fully calculated batches are claimable. A refused payout keeps the credit for retry. Contracts register for future fee allocations and claim for themselves.</p>
      {holdsT(view) ? <p>{`A side paid in ${ticker}: after graduation its fees buy ${ticker} in this box’s own pool, and each purchase is shared out as it settles, so a batch can have more to claim later.`}</p> : null}
      {view.choices.sellers === 'shop' ? <p>{`Into the shop: the part of a sellers’ batch the shop does not take is paid to holders in ${symbol}; a batch the shop is still deciding becomes claimable once it is decided.`}</p> : null}
      <p>Claim all, under Your claims, claims every payout with this box’s other claims, one signature each. With many open batches, More batches reads the older ones.</p>
      <label>Check a batch<input className="sh-newbox-input" inputMode="numeric" value={typed} onChange={(e) => { setTyped(e.target.value); setPending(null); }} /></label>
      <p className="sh-v2-address">{ledger ?? 'Holder ledger unavailable'}</p><p>Each claim calls claim(batch, your wallet) on the holder ledger.</p>
    </details>
  </section>;
}

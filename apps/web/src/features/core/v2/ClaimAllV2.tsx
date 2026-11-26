import { useRef, useState, type ReactNode } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { Address } from 'viem';
import { formatUnits } from '@squarehole/domain';
import { InsufficientGasFundsError, NotSendableError, preSendRefusalText } from '@squarehole/chain/write';
import { gasFundsLine } from '../../tx/gas-words';
import type { Eip1193Request } from '@squarehole/chain/write/wallet';
import { rolesOfV2 } from '../../../../../../packages/chain/src/core/v2';
import { ChainIcon } from '../../fit-pair/FitParts';
import { BrowserWalletDialog, DemoWalletDialog, useWallet } from '../../wallet';
import { holderActionIO, sendHolderClaimV2 } from './actions-v2';
import { claimCount, claimList, listSignature, stepP, stepT, withSingleClaim, type ClaimStep, type ListEntry, type SingleClaim, type SingleKnown } from './claim-all';
import { claimAllIO, sendCreatorFeesV2, sendCreatorRemainderV2, sendHandInApprovalV2, sendHandInV2 } from './claim-all-actions';
import { holderSessionKey, itemSessionKey, itemTSessionKey, singleSessionKey, useClaimsV2, type ClaimBoxV2, type ClaimingBoxV2, type SingleKind } from './claim-reads';
import { claimInOrder, withClaim, type HolderSession } from './holder-claims';
import { withItemClaim, type ItemSession } from './item-claims';
import { m3ActionIO, sendItemClaimTV2, sendItemClaimV2, sendSeedReturnV2 } from './m3-actions';
import { usePileCoins, type PileCoin } from './pile-coin';
import './v2-page.css';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

type Entry = ListEntry<ClaimingBoxV2>;
type CoinOf = (box: ClaimBoxV2, asset: `0x${string}`) => PileCoin | null;
type Pending = { readonly account: Address; readonly list: readonly Entry[]; readonly signature: string };
type Run = { readonly account: Address; readonly list: readonly Entry[]; readonly at: number; readonly done: number; readonly running: boolean; readonly stop: null | { readonly notSent: boolean; readonly gas: string | null } };

const p = (box: ClaimBoxV2, amount: bigint) => `${formatUnits(amount, box.view.decimals)} ${box.symbol}`;
const t = (box: ClaimBoxV2, coins: bigint) => `${formatUnits(coins, 18)} ${box.ticker}`;
/** The seed coin's amount by its own name, or raw units while its listing is unknown. */
const seedCoin = (coin: PileCoin | null, amount: bigint) => (coin ? `${formatUnits(amount, coin.decimals)} ${coin.symbol}` : `${amount} raw units`);

/** Each step in one to three words, with its amount: P out, and for the hand-in the coins going in as well. */
function stepLabel(step: ClaimStep): string {
  switch (step.kind) {
    case 'holder': return `Batch ${step.batch}`;
    case 'item':
    case 'item-t': return `Item #${step.id}`;
    case 'creator': return 'Creator fees';
    case 'remainder': return 'Creator remainder';
    case 'approve': return 'Approve coins';
    case 'hand-in': return 'Hand in coins';
    case 'seed-return': return 'Seed return';
  }
}
function stepAmount(box: ClaimBoxV2, step: ClaimStep, coinOf: CoinOf): ReactNode {
  if (step.kind === 'seed-return') return seedCoin(coinOf(box, step.asset), step.amount);
  if (step.kind === 'approve') return t(box, step.coins);
  // A mined hand-in whose receipt named no P shows its share of the pot until the index's receipt brings the P.
  if (step.kind === 'hand-in') return <>{t(box, step.coins)} <span aria-hidden="true">→</span><span className="sh-visually-hidden"> for</span> {step.amount === null ? 'share of the pot' : p(box, step.amount)}</>;
  // v2.1 step 2: a holder batch or item credit paid in the box token.
  if (step.kind === 'item-t' || (step.kind === 'holder' && step.inT)) return t(box, step.amount);
  return p(box, step.amount);
}

/** One step of the run: its checked send through the shared sender, then this session's record of the mined claim. */
async function claimStep(queries: QueryClient, entry: Entry, account: Address, request: Eip1193Request): Promise<void> {
  const { box: { view, source }, step } = entry;
  const chainId = source.manifest.chainId; const contracts = rolesOfV2(view.record).contracts;
  const single = (kind: SingleKind, contract: string | null, claim: SingleClaim) =>
    queries.setQueryData<SingleKnown>(singleSessionKey(kind, chainId, contract, account), (known) => withSingleClaim(known, claim));
  switch (step.kind) {
    case 'holder': {
      const r = await sendHolderClaimV2(source, view, account, step.batch, step.amount, holderActionIO(source, view, request));
      queries.setQueryData<HolderSession>(holderSessionKey(chainId, view.claimRow?.contracts.holderLedger ?? null, account), (s) => withClaim(s ?? {}, step.batch, { tx: r.transactionHash, block: r.blockNumber, paidP: step.amount }));
      return;
    }
    case 'item': {
      const r = await sendItemClaimV2(source, view, account, step.id, step.amount, m3ActionIO(source, view, request));
      queries.setQueryData<ItemSession>(itemSessionKey(chainId, view.claimRow?.contracts.itemLedger ?? null, account), (s) => withItemClaim(s ?? {}, step.id, { tx: r.transactionHash, block: r.blockNumber, paidP: step.amount }));
      return;
    }
    case 'item-t': {
      const r = await sendItemClaimTV2(source, view, account, step.id, step.amount, m3ActionIO(source, view, request));
      queries.setQueryData<ItemSession>(itemTSessionKey(chainId, view.claimRow?.contracts.itemLedger ?? null, account), (s) => withItemClaim(s ?? {}, step.id, { tx: r.transactionHash, block: r.blockNumber, paidP: step.amount }));
      return;
    }
    case 'creator': {
      // The amount is the receiver's next payment on both routes (FINAL-OC01); Claimed shows what its CreatorClaimed paid.
      const r = await sendCreatorFeesV2(source, view, account, step.amount, claimAllIO(source, view, request));
      single('creator', contracts.receiver ?? null, { tx: r.transactionHash, block: r.blockNumber, paid: r.paidP ?? step.amount });
      return;
    }
    case 'remainder': {
      // RC6-RR-INBOX: a remainder that includes inbox P pays it only if the intake succeeds; Claimed shows what was paid.
      const r = await sendCreatorRemainderV2(source, view, account, step.amount, claimAllIO(source, view, request));
      single('remainder', contracts.coordinator ?? null, { tx: r.transactionHash, block: r.blockNumber, paid: r.paidP ?? step.amount });
      return;
    }
    case 'approve':
      await sendHandInApprovalV2(source, view, account, step.coins, claimAllIO(source, view, request));
      return;
    case 'hand-in': {
      const r = await sendHandInV2(source, view, account, step.coins, claimAllIO(source, view, request));
      // The coordinator's Claimed says what the claim paid. Without it a share whose quote included inbox P
      // (RC6-RR-INBOX) records no P: the index's receipt brings it.
      const p = r.paidP ?? (step.amount !== null && step.collectFirstP === undefined ? step.amount : null);
      single('hand-in', contracts.coordinator ?? null, { tx: r.transactionHash, block: r.blockNumber, paid: step.coins, ...(p !== null ? { p } : {}) });
      return;
    }
    case 'seed-return': {
      const r = await sendSeedReturnV2(source, view, account, m3ActionIO(source, view, request));
      single('seed', contracts.vault ?? null, { tx: r.transactionHash, block: r.blockNumber, paid: step.amount });
      return;
    }
  }
}

/**
 * Totals per coin: P per price coin, a seed return in its pile's own coin, and a payout in a box's own token T (v2.1
 * step 2); different coins are never added up. An approval pays nothing. Every step to sign carries its amount
 * (SH-RC7 item 29: the unpriced collect-first hand-in is gone).
 */
function totals(list: readonly Entry[], coinOf: CoinOf): readonly string[] {
  const sums = new Map<string, { show: (amount: bigint) => string; amount: bigint }>();
  const add = (key: string, show: (amount: bigint) => string, amount: bigint) => sums.set(key, { show: sums.get(key)?.show ?? show, amount: (sums.get(key)?.amount ?? 0n) + amount });
  for (const { box, step } of list) {
    if (step.kind === 'approve') continue;
    const pOut = stepP(step);
    if (step.kind === 'seed-return') {
      const coin = coinOf(box, step.asset);
      add(`${step.asset.toLowerCase()}:${coin?.decimals ?? 'raw'}`, (amount) => seedCoin(coin, amount), step.amount);
    } else if (stepT(step) > 0n) add(`${box.view.token.toLowerCase()}:t`, (amount) => t(box, amount), stepT(step));
    else if (pOut !== null) add(`${box.view.record.q.toLowerCase()}:${box.view.decimals}`, (amount) => p(box, amount), pOut);
  }
  return [...sums.values()].map(({ show, amount }) => show(amount));
}

/** The read queries behind the list (claim-reads.ts), refetched by Retry: the index, and the scan's. */
const READS: ReadonlySet<string> = new Set(['v2-wallet-claims', 'v2-holder-share', 'v2-item-share', 'v2-hand-in', 'v2-creator-quote']);

const MARK: Readonly<Record<'done' | 'current' | 'stopped' | 'claimed', string>> = { done: 'Done', current: 'Signing…', stopped: 'Stopped', claimed: 'Claimed' };

/** The list of what will be claimed (and, during a run, where it is), box by box. */
function ClaimRows({ list, scope, mark, coinOf, label }: { list: readonly Entry[]; scope: 'box' | 'wallet'; mark?: (index: number) => keyof typeof MARK | null; coinOf: CoinOf; label?: string }) {
  const groups: { key: string; box: ClaimBoxV2; entries: { entry: Entry; index: number }[] }[] = [];
  list.forEach((entry, index) => {
    const last = groups.at(-1);
    if (last?.key === entry.key) last.entries.push({ entry, index }); else groups.push({ key: entry.key, box: entry.box, entries: [{ entry, index }] });
  });
  return <div className="sh-v2-claim-list">{groups.map(({ key, box, entries }) => <div key={key} className="sh-v2-claim-box">
    {scope === 'wallet' ? <h3>{box.name}</h3> : null}
    <ol className="sh-m2-batches" aria-label={scope === 'wallet' ? `${label ?? 'Claims'} on ${box.name}` : label ?? 'Claims to sign'}>{entries.map(({ entry, index }) => {
      const state = mark?.(index) ?? null;
      // The mark sits on the label's line, so a long exact amount has the row's whole width.
      return <li key={index} data-state={state ?? 'todo'}>
        <span className="sh-m2-payout">
          <span className="sh-v2-claim-head"><span className="sh-m2-batch">{stepLabel(entry.step)}</span>
            {state ? <span className={state === 'stopped' ? 'sh-chip sh-chip--pending' : 'sh-chip'}>{MARK[state]}</span> : null}</span>
          <span className="sh-m2-amount">{stepAmount(box, entry.step, coinOf)}</span>
          {/* RC6-RR-INBOX: a priced final share or creator remainder includes inbox P, paid only if its intake succeeds. */}
          {(entry.step.kind === 'remainder' || (entry.step.kind === 'hand-in' && entry.step.amount !== null)) && entry.step.collectFirstP !== undefined && !state
            ? <span className="sh-v2-claim-note">{`Includes ${p(box, entry.step.collectFirstP)} the claim first moves from the inbox.`}</span> : null}
        </span>
      </li>;
    })}</ol>
  </div>)}</div>;
}

/**
 * "Your claims" (F128): every claim the connected wallet can make, on one box (its page) or across the wallet's boxes
 * (My Box), behind one Claim all. Before the first signature it lists each transaction with its amount (the hand-in
 * with the coins going in and the P coming out); then it sends one after another, one signature each, shows "3 / 7",
 * and stops at the first that does not confirm, leaving the rest claimable. The wallet is asked only on Claim all
 * (to connect) and on Confirm (to sign); the reads never touch it.
 */
export function ClaimAllV2({ boxes, scope }: { boxes: readonly ClaimBoxV2[]; scope: 'box' | 'wallet' }) {
  const wallet = useWallet(); const queries = useQueryClient(); const button = useRef<HTMLButtonElement>(null);
  const account = wallet.status === 'connected' ? wallet.account : null;
  const claims = useClaimsV2(boxes, account);
  const [dialog, setDialog] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [changed, setChanged] = useState(false);
  // Another wallet, network or wallet kind drops an open confirmation and the last run (also on switching back).
  const scopeKey = `${account}:${wallet.chainId}:${wallet.kind}`;
  const [seenScope, setSeenScope] = useState(scopeKey);
  if (seenScope !== scopeKey) { setSeenScope(scopeKey); setPending(null); setChanged(false); if (!run?.running) setRun(null); }

  const list = claimList(claims.map((c) => ({ key: c.box.key, box: c.box, steps: c.steps })));
  const claimed = claimList(claims.map((c) => ({ key: c.box.key, box: c.box, steps: c.claimed })));
  const count = claimCount(list.map((entry) => entry.step));
  // The seed coins named in any list (the run's included), by their listings.
  const seeds = [...list, ...claimed, ...(run?.list ?? []), ...(pending?.list ?? [])].flatMap(({ box, step }) => (step.kind === 'seed-return' ? [{ source: box.source, asset: step.asset, release: box.view.release }] : []));
  const coins = usePileCoins(seeds);
  const coinOf: CoinOf = (box, asset) => coins(box.source, asset, box.view.release);
  // The scan stands in for the index: the list is a bounded direct chain read, marked as such.
  const direct = account !== null && claims.some((c) => c.via === 'scan');
  const wrong = account !== null && (wallet.kind !== 'injected' || boxes.some((box) => box.source.manifest.chainId !== wallet.chainId));
  const running = run?.running === true;
  const canClaim = account !== null && !wrong && !running;
  const known = claims.every((c) => c.known);
  const failed = claims.some((c) => c.failed) && !claims.some((c) => c.reading);
  const active = pending !== null && pending.account === account ? pending : null;
  const shownRun = run !== null && run.account === account ? run : null;
  const allDisabled = boxes.length > 0 && boxes.every((box) => box.disabled);
  // A failed read is never "nothing": with nothing ready, the panel says Unavailable (and offers Retry), not 0.
  const status = !account ? 'Choose a wallet' : allDisabled ? 'Unavailable' : count > 0 ? `${count} ready` : !known ? 'Reading…' : failed ? 'Unavailable' : 'Nothing to claim';
  const sums = totals(list, coinOf);
  // One box: its coin, 0 once every read answered with nothing to claim, a dash while unknown or failed. Several: a dash.
  const only = boxes.length === 1 ? boxes[0] : undefined;
  const empty = only ? `${account && known && !failed ? '0' : '—'} ${only.symbol}` : '—';

  const ask = () => {
    setChanged(false); if (!running) setRun(null);
    if (!account) setDialog(true); else if (list.length) setPending({ account, list, signature: listSignature(list) });
  };
  const confirm = async () => {
    if (!active || !canClaim || !wallet.signer) return;
    // A confirmation names exact steps and amounts; any change since then needs a fresh look.
    if (active.signature !== listSignature(list)) { setPending(null); setChanged(true); return; }
    const { list: frozen, account: who } = active; const request = wallet.signer.request;
    setPending(null);
    setRun({ account: who, list: frozen, at: 0, done: 0, running: true, stop: null });
    const result = await claimInOrder(frozen, async (entry, index) => {
      setRun((r) => r && { ...r, at: index });
      await claimStep(queries, entry, who, request);
      setRun((r) => r && { ...r, done: index + 1 });
    });
    setRun((r) => r && { ...r, running: false, stop: result.stoppedAt === null ? null
      // SH-SEND-FEES: the funds check stops a step before the wallet, like the guard; its line says what helps.
      // SH-258 round 3b: a price or gas-limit refusal never reached the wallet: "not sent", with its own line.
      : { notSent: result.error instanceof NotSendableError || result.error instanceof InsufficientGasFundsError || preSendRefusalText(result.error) !== null,
        gas: result.error instanceof InsufficientGasFundsError ? gasFundsLine(result.error.chainId) : preSendRefusalText(result.error) } });
    await Promise.all([queries.invalidateQueries({ queryKey: ['v2-feed'] }), queries.invalidateQueries({ queryKey: ['v2-wallet-claims'] })]);
  };
  const mark = (r: Run) => (index: number): keyof typeof MARK | null =>
    index < r.done ? 'done' : index === r.done && r.running ? 'current' : index === r.done && r.stop ? 'stopped' : null;
  const stopped = shownRun?.stop ? shownRun.list[shownRun.done] : undefined;

  // On My Box the Claims tab's heading already heads this panel.
  return <section className="sh-panel sh-v2-claims" aria-label="Your claims" data-scope={scope}>{scope === 'box' ? <h2>Your claims</h2> : null}
    <p className="sh-v2-value" data-coins={sums.length > 1 ? 'several' : undefined}>{account && sums.length
      ? sums.map((sum, i) => <span key={sum} className="sh-v2-claims__sum">{i > 0 ? <span className="sh-visually-hidden"> · </span> : null}{sum}</span>) : empty}</p>
    <p className="sh-m2-chips"><span aria-live="polite">{status}</span>
      {direct ? <span className="sh-chip sh-v2-fresh" data-freshness="direct" title="Claims index unavailable"><ChainIcon />Direct chain read</span> : null}
      {account && failed ? <button type="button" className="sh-chip sh-chip--pending" aria-label="Some reads failed. Retry" onClick={() => void queries.invalidateQueries({ predicate: (q) => READS.has(String(q.queryKey[0])) })}>Retry</button> : null}
    </p>
    <div className="sh-v2-actions">
      <button ref={button} type="button" className="sh-button sh-button--primary" data-entry-target="claim" disabled={account !== null && (!canClaim || list.length === 0)} onClick={ask}>Claim all</button>
    </div>
    {active ? <div role="group" aria-label="Confirm Claim all">
      <ClaimRows list={active.list} scope={scope} coinOf={coinOf} />
      <p>{`${active.list.length} ${active.list.length === 1 ? 'signature' : 'signatures'} · one each`}</p>
      <p className="sh-v2-address">{`To ${active.account}`}</p>
      <div className="sh-v2-actions">
        <button type="button" className="sh-button sh-button--primary" disabled={!canClaim} onClick={() => void confirm()}>Confirm</button>
        <button type="button" className="sh-button" onClick={() => setPending(null)}>Cancel</button>
      </div>
    </div> : null}
    {shownRun ? <div className="sh-v2-claim-run">
      <ClaimRows list={shownRun.list} scope={scope} mark={mark(shownRun)} coinOf={coinOf} />
      <p aria-live="polite">{shownRun.running ? `Claiming ${shownRun.at + 1} / ${shownRun.list.length}`
        : stopped ? `${stepLabel(stopped.step)} ${shownRun.stop?.notSent ? 'not sent' : 'not confirmed'}${shownRun.stop?.gas ? ` · ${shownRun.stop.gas}` : ''} · ${shownRun.done} / ${shownRun.list.length} done · the rest stay claimable`
          : `${shownRun.done} / ${shownRun.list.length} done`}</p>
    </div> : null}
    {changed ? <p aria-live="polite">Changed. Review and confirm again.</p> : null}
    {/* Mined and confirmed: this session's claims and the index's recent payments, so Claimed survives a reload. */}
    {account && claimed.length ? <details className="sh-v2-claimed"><summary>{`${claimCount(claimed.map((e) => e.step))} claimed`}</summary>
      <ClaimRows list={claimed} scope={scope} mark={() => 'claimed'} coinOf={coinOf} label="Claimed" />
    </details> : null}
    {wrong ? <p>Use a browser wallet on this box’s network.</p> : null}
    <details><summary>Claim all details</summary>
      <p>{`Claim all claims everything this wallet can claim${scope === 'wallet' ? ' on its boxes, one box after another' : ' on this box'}: holder payouts, item payouts, the creator’s fees and remainder, after failure the hand-in of its coins for their share of the pot (an approval, then the claim), and a failed coin pile’s seed back to its seeder.`}</p>
      <p>Each claim is its own transaction with its own signature, in the order listed. It stops at the first that does not confirm; the rest stay claimable. Nothing is sent automatically.</p>
      <p>The list comes from the claims index, every claim at one block, with the payments of about the last day. Direct chain read: the index is unavailable, so the site reads the chain itself, a bounded part at a time; More batches and More items on a box page read the rest.</p>
    </details>
    <BrowserWalletDialog open={dialog && wallet.defaultDialog === 'browser'} onClose={() => setDialog(false)} returnFocus={button} />
    {DEMO_BUILD ? <DemoWalletDialog open={dialog && wallet.defaultDialog === 'demo'} onClose={() => setDialog(false)} returnFocus={button} /> : null}
  </section>;
}

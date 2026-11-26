/**
 * F156 / F157 Q1 (SH-ALPHA-TRADE-BOX, work package G phase 1): the buy/sell box on a v2 box page, in Sepolia builds
 * only. One card, numbers first: Buy or Sell, the amount, what it gets (the plan's estimate at the plan block), the
 * launch tax in large type while the window runs, the 1% pool fee, one button, and one short line when something
 * stops it. Every explanation and the tolerance wait behind a closed Details button.
 *
 * The rules this box keeps (docs/evidence/SH-ALPHA-TRADE-BOX.md):
 * - The wallet opens only on a press: the button opens the wallet window, or sends the step the plan names. Browsing
 *   asks the wallet nothing, and with no wallet connected the box reads nothing from the chain either.
 * - Plans come from `prepareTradeSepolia` with the build target's chain id and the site's read RPC (trade-target.ts),
 *   for the connected account; `submitTradeWriteSepolia` gets the same chain id and RPC, the wallet only to sign.
 * - SH-ONE-PRESS-TRADE: one press per trade (use-sends.ts `press`). When the plan needs the exact approval (a reset to
 *   zero first when another amount is approved), that press sends it, waits for the chain, makes the plan again at the
 *   new block and sends the trade, only within the person's tolerance of the quote they pressed on (one-press.ts);
 *   otherwise it stops and shows the new quote with its own press. Each step is its own wallet request: the wallet
 *   Privy made signs both without a window; a browser wallet asks twice, the second time by itself. Two small ticks
 *   (Approve, the trade) show its progress; a trade that needs no approval shows none. Then, as before, the revocation
 *   of what the trade left approved (an ERC-20 input that filled in part). A new plan after every approval, a chain or
 *   account change, and before a quote is half a minute old; a plan that fails for a moment (a read the public RPC did
 *   not answer) is made again quietly, and its line shows only when two in a row fail.
 * - A plan is single-use, and an account has one send at a time (trade-inflight.ts, across every page of the trade
 *   folder for the visit): nothing is prepared again until the wallet refuses it, or the chain mines or replaces it, or,
 *   without a hash, the site's RPC shows nothing pending for a quiet minute (trade-run.ts `settleSend`). While the RPC
 *   shows anything pending for the account, the box waits too. The sends are the trade folder's one engine
 *   (use-sends.ts), which the test-coin page shares.
 * - `disabled` (a stale or unverified read of the box) stops quotes and sends, as for every other action on the page.
 * - The balance the box shows and checks is read at a named mined block: the plan's own once a quote stands (so the
 *   balance, the check and the quote describe one block, refreshed with the quote), before that the latest mined one. A
 *   failed read is tried once more a moment later, at the same block, and only a second failure is said; a balance
 *   that could not be read is never shown, and never zero.
 * - A mined trade's row says what it took (trade-run.ts `fillOf`): "filled in part" when less than its call offered.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { prepareTradeSepolia, DEFAULT_TOLERANCE_BPS, type TradeFloor, type TradePlan } from '@squarehole/chain/trade-sepolia';
import { decodeFunctionData, parseAbi, zeroAddress, type Address } from 'viem';
import { formatUtc } from '../fit-pair/fit-format';
import { Details } from '../fit-pair/InfoTip';
import { NO_FIGURE, pAmountV2, tShortV2 } from '../core/v2/stats-v2';
import type { TradeSlotProps } from '../core/v2/TradeSlotMount';
import { rolesOfV2 } from '../../../../../packages/chain/src/core/v2';
import { refreshWalletReads } from '../core/v2/wallet-reads';
import { BrowserWalletDialog, useWallet } from '../wallet';
import { readAmount, readTolerance, tolerancePercent } from './trade-amount';
import { balanceOf, minedBlock, noncesOf, readTwice } from './trade-run';
import { sendKey, type SentPlan } from './trade-inflight';
import { isCoinPlan, RECEIPT_TIMEOUT_MS, RECONCILE_MS, useSends, type AmountOf, type Prepared } from './use-sends';
import { coinAmountOf, coinRevokeLabel } from './coin-target';
import { QUIET_RETRY_MS, quietFailure } from './one-press';
import { Receipts } from './Receipts';
import { Steps } from './Steps';
import { clockUtc, stageOfPhase, taxChainNow, stageOfView, tradesIn, windowTaxAt, type TradeStage } from './trade-stage';
import { tradeTargetOf, type TradeTarget } from './trade-target';
import { CHECKING_LABEL, confirmLabel, lineFor, ONE_PRESS_NOTE, PARTIAL_FILL_WARNING, partialFillLine, raiseEndLine, STAGE_LINES, STEP_WORDS, tradeLine } from './trade-words';
import './trade-box.css';

/** The test-coin page (routes.tsx), linked where the balance is short (SH-274). */
export const TEST_COINS_PATH = '/test-coins';

type Side = 'buy' | 'sell';

/** A balance of what is paid in, with the mined block it was read at. */
interface Held { readonly value: bigint; readonly block: bigint }

/** The box's quote. `key` names the inputs a plan was made for (chain, box, account, wallet chain, side, amount, tolerance). */
type Quote =
  | { readonly kind: 'idle' }
  | { readonly kind: 'preparing'; readonly key: string }
  /** `due`: when the plan is made again, when sooner than half a minute after `at` (a refresh that failed for a moment). */
  | { readonly kind: 'ready'; readonly key: string; readonly plan: TradePlan; readonly at: number; readonly due?: number }
  /** `quiet`: a failure that may pass, not said yet; the plan is asked for again at `due` (one-press.ts). */
  | { readonly kind: 'refused'; readonly key: string; readonly reason: string; readonly at: number; readonly quiet?: true; readonly due?: number };

/** A quote this old is prepared again (the send's guard refuses one past its 120 s block-time deadline). */
export const QUOTE_REFRESH_MS = 30_000;
/** Typing settles for this long before a quote is asked for. */
export const QUOTE_DEBOUNCE_MS = 350;

const ROUTER_BUY = parseAbi(['function buy(uint256 qIn,uint256 minTokensOut,address recipient,uint256 deadline) payable returns (uint256)']);
const keyOf = (quote: Quote): string | null => (quote.kind === 'idle' ? null : quote.key);

/** The minimum a window buy accepts, from the plan's own calldata (the router's `minTokensOut`). */
export function routerMinimum(plan: Pick<TradePlan, 'call' | 'phase' | 'side'>): bigint | null {
  if (!plan.call || plan.phase !== 2 || plan.side !== 'buy') return null;
  try {
    return decodeFunctionData({ abi: ROUTER_BUY, data: plan.call.data }).args[1];
  } catch {
    return null;
  }
}

export interface TradeBoxProps extends TradeSlotProps {
  /** Test seam: where the box trades, or why not (the build's own target otherwise, trade-target.ts). */
  readonly target?: TradeTarget | { readonly reason: string };
  /** Test seam: how long a receipt is waited for before the box reconciles by nonce. */
  readonly receiptTimeoutMs?: number;
  /** Test seam: how long "nothing pending" must hold before a send without a hash counts as settled. */
  readonly quiet?: { readonly reads: number; readonly ms: number };
}

export function TradeBox({ record, view, source, disabled, target: given, receiptTimeoutMs = RECEIPT_TIMEOUT_MS, quiet }: TradeBoxProps) {
  const wallet = useWallet();
  const queries = useQueryClient();
  const coordinator = (rolesOfV2(view.record).contracts.coordinator ?? zeroAddress) as Address;
  // One target per box and source: its RPC function is made once, not again for every snapshot the page polls.
  const sourceKey = `${source.network}|${source.manifest.chainId}|${source.rpc}|${coordinator}`;
  const read = useMemo(() => (given ? ('chainId' in given ? { ok: true as const, target: given } : { ok: false as const, reason: given.reason }) : tradeTargetOf(source, view)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sourceKey names everything the target is made of
    [given, sourceKey]);
  const target = read.ok ? read.target : null;

  const [side, setSide] = useState<Side>('buy');
  const [text, setText] = useState('');
  const [toleranceText, setToleranceText] = useState(tolerancePercent(DEFAULT_TOLERANCE_BPS).slice(0, -1));
  const [quote, setQuote] = useState<Quote>({ kind: 'idle' });
  // The balance read on its own (before a quote stands, and after every mined step), for `balanceKey`.
  const [balance, setBalance] = useState<(Held & { readonly key: string }) | null>(null);
  // The balance the latest quote checked, at its plan's block (at the block it named when it stopped before a plan). It
  // stays while the next quote is prepared, so the figure never steps back to an older block's.
  const [quoted, setQuoted] = useState<(Held & { readonly key: string }) | null>(null);
  const [dialog, setDialog] = useState(false);
  // Bumped after every mined transaction: the balance is read again.
  const [round, setRound] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  // Bumped by every plan started and every send: a plan that resolves after either is dropped.
  const generation = useRef(0);
  // How many plans in a row failed for these inputs (one-press.ts `quietFailure`: the first that may pass is not said).
  const failures = useRef({ key: '', count: 0 });

  const account = wallet.status === 'connected' && wallet.kind === 'injected' && wallet.signer ? wallet.account : null;
  const wrongChain = account !== null && target !== null && wallet.chainId !== target.chainId;
  const pDecimals = view.decimals;
  const inputUnit = side === 'buy' ? record.pairAsset : record.ticker;
  const outputUnit = side === 'buy' ? record.ticker : record.pairAsset;
  const amount = readAmount(text, side === 'buy' ? pDecimals : 18);
  const tolerance = readTolerance(toleranceText);
  const inputCoin = (side === 'buy' ? view.record.q : view.token) as Address;
  const viewStage = stageOfView(view);
  const key = target && account && amount.kind === 'ok' && tolerance !== null
    ? `${target.chainId}|${coordinator}|${account}|${wallet.chainId}|${side}|${amount.raw}|${tolerance}` : null;
  const balanceKey = target && account ? `${target.chainId}|${account}|${inputCoin}|${round}` : null;
  // The account's one send slot on this chain (trade-inflight.ts).
  const slot = target && account ? sendKey(target.chainId, account) : null;

  /** After a mined or refused step: read the balance and the box again, and the page's figures with it. */
  const settle = () => {
    setRound((n) => n + 1);
    // SH-274: the page's reads of the wallet with it (the shop's coin, the claims list), through the shop's own helper.
    void refreshWalletReads(queries, ['v2-launch-tax']);
  };
  // A mined trade's figures: this box's own coins, a coin plan's by its record (a send adopted from another box: none).
  const amountOf: AmountOf = (sent) => (isCoinPlan(sent) ? coinAmountOf(sent, pAmountV2) : sent.coordinator.toLowerCase() !== coordinator.toLowerCase() ? null
    : sent.side === 'buy' ? { unit: record.pairAsset, show: (raw) => pAmountV2(raw, pDecimals) } : { unit: record.ticker, show: tShortV2 });
  const sends = useSends({ target, signer: wallet.signer, slot, disabled, receiptTimeoutMs, ...(quiet ? { quiet } : {}), watch: quote.kind, amountOf,
    // A send starts (or is adopted): a plan still on its way is dropped, and the spent quote with it.
    onStart: () => { generation.current += 1; setQuote({ kind: 'idle' }); },
    // Only this box's own trade clears its amount (a coin send adopted from the test-coin page does not).
    onSettled: (sent, mined) => { if (mined && sent.step === 'trade' && !isCoinPlan(sent.plan)) setText(''); settle(); } });
  const { flow, busy, line, setLine } = sends;

  // The balance of what is paid in, once a wallet is connected: read with the site's RPC (the wallet is not asked), at
  // the latest mined block, named first. A failed read is tried once more a moment later at the same block; a second
  // failure shows no balance, never zero.
  useEffect(() => {
    if (!target || !account || balanceKey === null || disabled) return undefined;
    let live = true;
    const key = balanceKey;
    const twice = <T,>(read: () => Promise<T>) => readTwice(read, { live: () => live });
    void (async () => {
      try {
        const block = await twice(() => minedBlock(target.rpc));
        if (!live) return;
        const value = await twice(() => balanceOf(target.rpc, inputCoin, account, block));
        if (live) setBalance({ key, value, block });
      } catch {
        if (live) setBalance(null);
      }
    })();
    return () => { live = false; };
  }, [target, account, inputCoin, balanceKey, disabled]);

  // Chain time moves on while a window buy's quote is shown: a clock that ticks each second then, for the blocks since the
  // quote (the window tax follows the chain's clock, never the browser's: chainNow below). No tax shows otherwise.
  const [clock, setClock] = useState(0);
  const windowQuote = quote.kind === 'ready' && quote.plan.phase === 2 && quote.plan.side === 'buy';
  useEffect(() => {
    if (!windowQuote) return undefined;
    const timer = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [windowQuote]);

  // A plan for the inputs as they stand: once typing settles, again after every mined step (the quote is idle then),
  // and again whenever the last quote or refusal is half a minute old (sooner when it failed for a moment: `due`).
  const quoteKey = keyOf(quote);
  const quoteDue = quote.kind === 'ready' || quote.kind === 'refused' ? quote.due ?? quote.at + QUOTE_REFRESH_MS : null;
  useEffect(() => {
    if (disabled || flow.kind !== 'none' || !target || !account || key === null || amount.kind !== 'ok' || tolerance === null || !tradesIn(viewStage)) return undefined;
    const same = quoteKey === key;
    if (same && quote.kind === 'preparing') return undefined;
    const wait = same && quoteDue !== null ? Math.max(0, quoteDue - Date.now()) : QUOTE_DEBOUNCE_MS;
    const amountIn = amount.raw;
    const balanceAt = balanceKey;
    const timer = setTimeout(() => {
      const run = ++generation.current;
      if (!same) setQuote({ kind: 'preparing', key });
      // Only the plan of this run, for these inputs, replaces what the box shows.
      const current = () => run === generation.current;
      const apply = (next: Quote) => setQuote((shown) => (current() && keyOf(shown) === key ? next : shown));
      // The quote and the balance its check used, together.
      const finish = (next: Quote, held: Held | null) => {
        apply(next);
        if (held && balanceAt !== null && current()) setQuoted({ key: balanceAt, ...held });
      };
      // A failed read is tried once more a moment later, at the same block; only a second failure is said.
      const twice = <T,>(read: () => Promise<T>) => readTwice(read, { live: current });
      void (async () => {
        let held: Held | null = null;
        try {
          // A mined block named first: before a plan, the balance is checked at it.
          const named = await twice(() => minedBlock(target.rpc));
          if (!current()) return;
          const [owned, nonces] = await twice(() => Promise.all([balanceOf(target.rpc, inputCoin, account, named), noncesOf(target.rpc, account)]));
          if (!current()) return;
          held = { value: owned, block: named };
          // Something of this account's is still pending (a send from before a reload, another app's): a new plan would
          // queue behind it. Look again in a few seconds.
          if (nonces.pending > nonces.latest) { finish({ kind: 'refused', key, reason: 'earlier_send', at: Date.now() - QUOTE_REFRESH_MS + RECONCILE_MS }, held); return; }
          if (owned < amountIn) { finish({ kind: 'refused', key, reason: 'balance_low', at: Date.now() }, held); return; }
          const prepared = await prepareTradeSepolia({ rpc: target.rpc, chainId: target.chainId, coordinator, from: account, side, amountIn,
            toleranceBps: tolerance, ...(target.localDeployment ? { localDeployment: target.localDeployment } : {}) });
          if (!current()) return;
          if (!prepared.ok) {
            // SH-ONE-PRESS-TRADE item 2: a failure that may pass (a read the public RPC did not answer) is not said yet:
            // the plan is made again in a moment, a quote on show stays meanwhile, and only a second failure in a row
            // shows its line.
            const inARow = failures.current.key === key ? failures.current.count + 1 : 1;
            failures.current = { key, count: inARow };
            if (quietFailure(prepared.reason, inARow)) {
              const due = Date.now() + QUIET_RETRY_MS;
              setQuote((shown) => (!current() || keyOf(shown) !== key ? shown : shown.kind === 'ready' ? { ...shown, due }
                : { kind: 'refused', key, reason: prepared.reason, at: Date.now(), quiet: true, due }));
              return;
            }
            finish({ kind: 'refused', key, reason: prepared.reason, at: Date.now() }, held);
            return;
          }
          failures.current = { key, count: 0 };
          // The plan's own block: the balance the box checks and shows is the one its quote was made at.
          const { plan } = prepared;
          const atPlan = plan.blockNumber === named ? owned : await twice(() => balanceOf(target.rpc, inputCoin, account, plan.blockNumber));
          if (!current()) return;
          held = { value: atPlan, block: plan.blockNumber };
          finish(atPlan < amountIn ? { kind: 'refused', key, reason: 'balance_low', at: Date.now() } : { kind: 'ready', key, plan, at: Date.now() }, held);
        } catch {
          finish({ kind: 'refused', key, reason: 'rpc_failed', at: Date.now() }, held);
        }
      })();
    }, wait);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` names the inputs a plan is made of
  }, [key, disabled, flow.kind, quote.kind, quoteKey, quoteDue, target, viewStage]);

  /**
   * The press's plan made again after its approval (use-sends.ts `press`), for the same inputs: nothing pending for the
   * account, the plan at the latest block (with the pressed quote's bound, `floor`, af1), and the balance at its block
   * (the quote's own checks, at once).
   */
  const recheck = (inputs: { readonly side: Side; readonly amountIn: bigint; readonly toleranceBps: bigint; readonly coin: Address }) => async (floor: TradeFloor | null): Promise<Prepared> => {
    if (!target || !account) return { ok: false, reason: 'invalid_address' };
    const nonces = await readTwice(() => noncesOf(target.rpc, account));
    if (nonces.pending > nonces.latest) return { ok: false, reason: 'earlier_send' };
    const prepared = await prepareTradeSepolia({ rpc: target.rpc, chainId: target.chainId, coordinator, from: account, side: inputs.side, amountIn: inputs.amountIn,
      toleranceBps: inputs.toleranceBps, ...(floor ? { floor } : {}), ...(target.localDeployment ? { localDeployment: target.localDeployment } : {}) });
    if (!prepared.ok) return prepared;
    const held = await readTwice(() => balanceOf(target.rpc, inputs.coin, account, prepared.plan.blockNumber));
    return held < inputs.amountIn ? { ok: false, reason: 'balance_low' } : prepared;
  };

  // ------------------------------------------------------------------------------------------------ what shows

  if (!read.ok) return <TradeCard stage={viewStage}><p className="sh-trade-box__line">{tradeLine(read.reason)}</p></TradeCard>;
  // A phase with no trading is one line. What is still under way stays below it: a buy that filled the curve closes
  // trading, and its revocation, its receipt and a send waiting for the chain must not vanish with the form.
  const closedLine = tradesIn(viewStage) ? null : viewStage === 'upcoming' && view.gate.open && view.gate.effectiveOpenAt > 0n
    ? `Opens ${formatUtc(view.gate.effectiveOpenAt, false)}.` : STAGE_LINES[viewStage as keyof typeof STAGE_LINES];

  // The plan on show: the one under way (a box trade's; another page's coin send shows no figures here), else the quote.
  const plan = flow.kind !== 'none' ? (isCoinPlan(flow.plan) ? null : flow.plan) : quote.kind === 'ready' && quote.key === key ? quote.plan : null;
  // A failure kept quiet (one-press.ts) is not said: the plan is being made again.
  const refused = quote.kind === 'refused' && quote.key === key && !quote.quiet ? quote.reason : null;
  // The balance on show: the newest of the box's two reads for these inputs, the latest quote's (its plan's block) and
  // its own; a quote's block wins a tie.
  const fromQuote = quoted && quoted.key === balanceKey ? quoted : null;
  const fromRead = balance && balance.key === balanceKey ? balance : null;
  const shownBalance = fromQuote && (!fromRead || fromQuote.block >= fromRead.block) ? fromQuote.value : fromRead ? fromRead.value : null;
  const stage: TradeStage = (plan ? stageOfPhase(plan.phase) : null) ?? viewStage;
  const windowBuy = side === 'buy' && stage === 'window';
  // Chain time, never the browser's clock: the plan's block plus the seconds since it was read, else the snapshot's block.
  // Whole 12 s slots only (trade-stage.ts `slotSecondsSince`): never a later, lower step than the chain's.
  // SH-258 round 3: on BNB Chain testnet the latest observed block's time only (trade-stage.ts `taxChainNow`).
  const chainNow = taxChainNow(view.timestamp, plan ? { blockTimestamp: plan.blockTimestamp, at: flow.kind === 'none' && quote.kind === 'ready' ? quote.at : clock } : null, clock);
  const tax = windowBuy ? windowTaxAt(view.gate.effectiveOpenAt, chainNow) : null;
  // A spent plan's estimate is not shown again: once its trade is mined, the box offers only the revocation. A plan that
  // needs its approval shows its figures too: the one press sends the trade they describe (SH-ONE-PRESS-TRADE).
  const output = plan && flow.kind !== 'revoke' ? plan.expectedOutput : null;
  const partial = plan && flow.kind !== 'revoke' && plan.expectedInput !== null && plan.expectedInput < plan.amountIn ? plan.expectedInput : null;
  const raiseLine = plan?.raiseEnd && flow.kind !== 'revoke' ? raiseEndLine(plan.raiseEnd.input, pDecimals, inputUnit) : null;
  const minimum = plan ? routerMinimum(plan) : null;
  const showOut = (raw: bigint) => (side === 'buy' ? tShortV2(raw) : pAmountV2(raw, pDecimals));
  const showIn = (raw: bigint) => (side === 'buy' ? pAmountV2(raw, pDecimals) : tShortV2(raw));

  const tradeWord = side === 'buy' ? STEP_WORDS.buy : STEP_WORDS.sell;
  let label: string = tradeWord;
  let action: (() => void) | null = null;
  if (flow.kind === 'sending') label = confirmLabel(wallet.signer?.confirmsInPage === true);
  else if (flow.kind === 'mining') label = 'Waiting for the chain…';
  else if (flow.kind === 'checking') label = CHECKING_LABEL;
  else if (flow.kind === 'reconcile') { label = 'Check again'; const state = flow; action = () => { void sends.reconcile(state); }; }
  else if (!account) action = () => setDialog(true);
  else if (wrongChain && target) { label = 'Switch network'; action = () => { void wallet.switchChain(target.chainId).catch(() => setLine('wallet_chain')); }; }
  else if (flow.kind === 'revoke') {
    const { plan: spent, left } = flow;
    // Short: the revocation sets the approval to zero whatever is left; the figure only says how much that is (for a
    // coin send the test-coin page left, the coin its own record names).
    label = isCoinPlan(spent) ? coinRevokeLabel(spent, left, pAmountV2) : left === null ? 'Revoke approval'
      : `Revoke ${spent.side === 'buy' ? pAmountV2(left, pDecimals) : tShortV2(left)} ${spent.side === 'buy' ? record.pairAsset : record.ticker}`;
    if (spent.revoke) { const revoke = spent.revoke; action = () => { void sends.send('revoke', spent, revoke, left); }; }
  } else if (plan && key !== null && (plan.call || plan.reason === 'approval_required')) {
    // One press (SH-ONE-PRESS-TRADE): the trade, its exact approval first when the plan needs one; a plan made after the
    // approval past the person's limit comes back as this box's quote, with its own press.
    const shown = plan;
    const pressKey = key;
    const again = recheck({ side: shown.side, amountIn: shown.amountIn, toleranceBps: shown.toleranceBps, coin: inputCoin });
    const show = (next: SentPlan) => { if (!isCoinPlan(next)) setQuote({ kind: 'ready', key: pressKey, plan: next, at: Date.now() }); };
    action = () => { void sends.press(shown, { amountIn: shown.amountIn, toleranceBps: shown.toleranceBps, recheck: again, show }); };
  }
  const canPress = !disabled && action !== null;
  const typed = amount.kind === 'invalid' ? 'not_a_number' : amount.kind === 'too_precise' ? 'too_precise' : amount.kind === 'too_large' ? 'too_large' : null;
  const shownLine = disabled ? null : typed ?? line ?? refused ?? (tolerance === null ? 'invalid_tolerance' : null);
  const locked = busy || flow.kind === 'revoke';
  // A press that needed an approval: its two ticks, from the press until the next amount.
  const steps = sends.progress ? <Steps progress={sends.progress} trade={tradeWord} /> : null;
  const actions = (
    <div className="sh-trade-box__actions">
      <button ref={button} type="button" className="sh-button sh-button--primary sh-trade-box__go" disabled={!canPress} aria-busy={busy || undefined} onClick={() => action?.()}>{label}</button>
      {flow.kind === 'revoke' ? <button type="button" className="sh-button" onClick={sends.keep}>Keep</button> : null}
    </div>
  );
  const receiptList = <Receipts receipts={sends.receipts} explorer={target?.explorer ?? null} />;
  const dialogUi = <BrowserWalletDialog open={dialog} onClose={() => setDialog(false)} returnFocus={button} />;

  if (closedLine) {
    return (
      <TradeCard stage={viewStage} flow={flow.kind}>
        <p className="sh-trade-box__line">{closedLine}</p>
        {locked ? actions : null}
        {steps}
        {locked && shownLine ? <p className="sh-trade-box__line" role="status">{lineFor(shownLine, tolerance)}</p> : null}
        {receiptList}
        {dialogUi}
      </TradeCard>
    );
  }

  return (
    <TradeCard stage={stage} flow={flow.kind}>
      <fieldset className="sh-trade-box__sides" disabled={locked}>
        <legend className="sh-visually-hidden">Buy or sell</legend>
        {(['buy', 'sell'] as const).map((s) => (
          <label key={s} className="sh-trade-box__side" data-checked={side === s || undefined}>
            <input type="radio" name={`side-${coordinator}`} value={s} checked={side === s}
              onChange={() => { setSide(s); setText(''); setLine(null); setQuote({ kind: 'idle' }); sends.setProgress(null); }} />
            <span>{s === 'buy' ? 'Buy' : 'Sell'}</span>
          </label>
        ))}
      </fieldset>
      <label className="sh-trade-box__amount">
        <span className="sh-visually-hidden">{`Amount in ${inputUnit}`}</span>
        <input className="sh-trade-box__input" inputMode="decimal" autoComplete="off" spellCheck={false} placeholder="0" value={text} disabled={locked}
          onChange={(event) => { setText(event.target.value); setLine(null); sends.setProgress(null); }} />
        <span className="sh-trade-box__unit" aria-hidden="true">{inputUnit}</span>
      </label>
      {shownBalance !== null ? <p className="sh-trade-box__balance">{`Balance ${showIn(shownBalance)} ${inputUnit}`}</p> : null}
      {tax && flow.kind !== 'revoke' ? (
        <p className="sh-trade-box__tax">
          <span className="sh-trade-box__tax-label">Launch tax</span>
          <strong className="sh-trade-box__tax-value">{tax.text}</strong>
          <span className="sh-trade-box__tax-until">{`until ${clockUtc(tax.endsAt)}`}</span>
        </p>
      ) : null}
      {flow.kind === 'revoke' ? null : (
        <dl className="sh-trade-box__figures">
          <div><dt>You get</dt><dd><strong className="sh-trade-box__out">{output === null ? NO_FIGURE : `≈ ${showOut(output)}`}</strong> <span className="sh-trade-box__unit">{outputUnit}</span></dd></div>
          <div><dt>Pool fee</dt><dd>1%</dd></div>
        </dl>
      )}
      {raiseLine ? <p className="sh-trade-box__note">{raiseLine}</p> : partial !== null && plan ? <p className="sh-trade-box__note">{partialFillLine(showIn(partial), showIn(plan.amountIn), inputUnit)}</p> : null}
      {actions}
      {steps}
      {!windowBuy && flow.kind !== 'revoke' && amount.kind === 'ok' ? <p className="sh-trade-box__warning">{raiseLine ? 'No deadline.' : PARTIAL_FILL_WARNING}</p> : null}
      {disabled ? <p className="sh-trade-box__line">Waits for a current verified read.</p> : null}
      {shownLine ? <p className="sh-trade-box__line" role="status">{lineFor(shownLine, tolerance)}</p> : null}
      {/* SH-274: where the balance is short, the way to the test coins (the navigation's own label; this folder ships only
          in the test-network builds that have that page). */}
      {shownLine === 'balance_low' ? <p className="sh-trade-box__line"><a href={TEST_COINS_PATH}>Test coins</a></p> : null}
      <Details name="Buy and sell">
        <label className="sh-trade-box__tolerance">
          <span>Tolerance</span>
          <input inputMode="decimal" autoComplete="off" spellCheck={false} value={toleranceText} disabled={busy} onChange={(event) => setToleranceText(event.target.value)} />
          <span aria-hidden="true">%</span>
        </label>
        <p>0.1% to 20%.</p>
        {windowBuy
          ? <p>{`In the launch window a buy goes through the box’s launch router. It pays the tax of the block it lands in and the 1% pool fee, and reverts below its minimum${minimum !== null ? ` of ${tShortV2(minimum)} ${record.ticker}` : ''} or after two minutes.`}</p>
          : <p>Through the pool with a price limit only: no minimum and no deadline. It stops at the limit or the curve’s end; what is not spent stays with you.</p>}
        <p>{ONE_PRESS_NOTE}</p>
        <p>Approvals are exact. What a trade leaves approved can be revoked.</p>
        {plan ? <p>{`Estimates at block ${plan.blockNumber}.`}</p> : null}
      </Details>
      {receiptList}
      {dialogUi}
    </TradeCard>
  );
}

function TradeCard({ stage, flow, children }: { readonly stage: TradeStage; readonly flow?: string; readonly children: ReactNode }) {
  return (
    <section className="sh-panel sh-trade-box" aria-label="Buy and sell" data-stage={stage} data-flow={flow}>
      <h2 className="sh-visually-hidden">Buy and sell</h2>
      {children}
    </section>
  );
}

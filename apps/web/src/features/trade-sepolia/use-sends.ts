/**
 * F156 (SH-ALPHA-TRADE-BOX, SH-ALPHA-TEST-COINS): the trade folder's one send engine, for the trade box and the
 * test-coin page alike. One press is one wallet request for one step of a plan (an exact approval, the plan's own call,
 * the revocation of what that call left approved); then the chain's answer. The rules
 * (docs/evidence/SH-ALPHA-TRADE-BOX.md, decision 10):
 * - One send per account and chain at a time, in a slot that outlives the page (trade-inflight.ts), taken before
 *   anything is awaited. A page opened again, or another page of the trade folder, adopts a send still under way and
 *   follows it to its end.
 * - A send's outcome comes from the chain only (trade-run.ts `settleSend`); an unclear wallet answer waits for it.
 * - Every state write after an await checks that the page is still where that send left it; a page that has gone stops
 *   after its next read and leaves the settling to the next page opened.
 * - What a plan's own call left approved (a part fill, a revert, a replacement) is offered for revocation.
 * - A mined trade's row keeps its fill as its receipt's own events say it (trade-run.ts `fillOf`): what it took of what
 *   its call offered, so a part fill reads as one after the plan's estimate is gone, native ETH paid back included.
 * Plans come from the trade calls (`prepareTradeSepolia`, `prepareFaucetSepolia`, `preparePairSwapSepolia`), and the
 * sends go through their guarded senders only (`submitTradeWriteSepolia`, `submitCoinWriteSepolia`), with the build
 * target's chain id and the site's read RPC: the wallet only signs.
 *
 * SH-ONE-PRESS-TRADE: a trade is one press (`press`). A plan that needs its exact approval sends it, waits for the chain,
 * makes the plan again at the new block, and sends the trade by itself only within the person's limit of the quote they
 * pressed on (one-press.ts); each step is still its own wallet request in the account's one slot.
 */
import { useEffect, useRef, useState } from 'react';
import { submitCoinWriteSepolia, submitTradeWriteSepolia, type CoinPlan, type TradeCall, type TradeFloor } from '@squarehole/chain/trade-sepolia';
import type { Eip1193Request } from '@squarehole/chain/write';
import type { Hex } from 'viem';
import { figuresOf, floorOf, LIMIT_REASONS, MAX_APPROVALS, PLAN_BEHIND_TRIES, QUIET_REASONS, QUIET_RETRY_MS, READ_WAIT_MS, sameTrade, withinLimit, type Progress } from './one-press';
import { allowanceOf, APPROVAL_GAS_FALLBACK, approvalAmount, approvalGas, fillOf, noncesOf, QUIET_MS, QUIET_READS, revertReasonOf, sendFailure, settleSend, spendOf, type Fill, type SendTrack, type Settlement } from './trade-run';
import { beginInFlight, endInFlight, inFlightOf, updateInFlight, type SentPlan, type SentStep } from './trade-inflight';

export type Step = SentStep['step'];

/**
 * Where a page's send is. `none`: nothing under way, the page shows its own quote. `run`: the press (`press`) a send
 * belongs to, when it is one step of a press that approves and then trades.
 */
export type SendFlow =
  | { readonly kind: 'none' }
  | ({ readonly kind: 'sending'; readonly run?: number } & SentStep)
  | ({ readonly kind: 'mining'; readonly slotId: number; readonly track: SendTrack; readonly run?: number } & SentStep)
  /** A send the page no longer follows by itself (an unclear answer, a slow receipt, a send from before): looked at again. */
  | ({ readonly kind: 'reconcile'; readonly slotId: number; readonly track: SendTrack } & SentStep)
  /** A plan's own call left some of its exact approval: the revocation is offered. `left` null: unread. */
  | { readonly kind: 'revoke'; readonly plan: SentPlan; readonly left: bigint | null }
  /** A press's approval is mined: its plan is made again at the new block before the trade (`plan`: the approval's). */
  | { readonly kind: 'checking'; readonly plan: SentPlan; readonly run: number };

/** A plan made for a page's inputs, or why not (the trade calls' own reasons, and the page's). */
export type Prepared = { readonly ok: true; readonly plan: SentPlan } | { readonly ok: false; readonly reason: string };

/** How one send ended for the page that sent it: mined without a revert (at its receipt's block), still to be seen, or not. */
export type SendResult = { readonly kind: 'mined'; readonly block: bigint } | { readonly kind: 'pending' } | { readonly kind: 'failed' };
const FAILED: SendResult = Object.freeze({ kind: 'failed' });
const PENDING: SendResult = Object.freeze({ kind: 'pending' });

/** What a press needs besides its plan (SH-ONE-PRESS-TRADE). */
export interface PressOptions {
  /** The amount typed, in raw units: the shown quote's input when its plan names none (a window buy). */
  readonly amountIn: bigint;
  /** The person's tolerance in basis points: how far below the quote they pressed on the plan made after it may be. */
  readonly toleranceBps: bigint;
  /**
   * The plan for the same inputs, made again at the latest block (after each mined approval). With `floor` (af1) the
   * plan's price limit or minimum is never looser than the pressed quote's; without it, the market's own new quote.
   */
  readonly recheck: (floor: TradeFloor | null) => Promise<Prepared>;
  /** The plan made after the approval is past the person's limit: the page shows it as its quote, with its own press. */
  readonly show: (plan: SentPlan) => void;
}

export interface SentReceipt {
  readonly hash: Hex;
  /** What the transaction was, in a word or two ("Buy", "Drip", "Approval cleared"). */
  readonly what: string;
  readonly status: 'pending' | 'success' | 'reverted' | 'replaced';
  readonly reason: string | null;
  /** A mined trade's or swap's fill, from its receipt; null for a step that spends nothing, or events that do not say. */
  readonly fill: Fill | null;
  /** The fill in the page's figures: "0.0075 of 0.01 tETH" in part, "0.01 tETH" whole; null without a known coin. */
  readonly figures: string | null;
}

/** How a page shows an amount of what a plan spends, in its coin; null when the page does not know that coin. */
export type AmountOf = (plan: SentPlan) => { readonly unit: string; readonly show: (raw: bigint) => string } | null;

/** A fill in the page's figures: what it took of what it offered when in part, else what it took. */
export function fillFigures(fill: Fill, coin: ReturnType<AmountOf>): string | null {
  if (!coin) return null;
  return fill.spent < fill.offered ? `${coin.show(fill.spent)} of ${coin.show(fill.offered)} ${coin.unit}` : `${coin.show(fill.spent)} ${coin.unit}`;
}

/** Where a page sends: the build target's chain, the site's read RPC, the explorer's page for a transaction. */
export interface SendTarget {
  readonly chainId: number;
  readonly rpc: Eip1193Request;
  readonly explorer: (hash: string) => string | null;
}

/** How often a send the page no longer follows by itself is looked at again. */
export const RECONCILE_MS = 4_000;
/** How often a sent transaction is looked for while the page follows it. */
export const MINING_POLL_MS = 1_500;
/** A sent transaction's receipt is waited for this long; then the page checks the account's nonce instead. */
export const RECEIPT_TIMEOUT_MS = 300_000;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A coin plan (the faucet's drip, a pair swap) rather than a box trade. */
export const isCoinPlan = (plan: SentPlan): plan is CoinPlan => 'kind' in plan;

/** The words for a transaction in the Transactions list. */
export function describeStep(step: Step, plan: SentPlan, call: TradeCall): string {
  if (step === 'trade') return isCoinPlan(plan) ? (plan.kind === 'faucet' ? 'Drip' : 'Swap') : plan.side === 'buy' ? 'Buy' : 'Sale';
  return step === 'revoke' || approvalAmount(call) === 0n ? 'Approval cleared' : 'Approval';
}

/** The guarded sender a plan belongs to, with the build target's chain id and the site's RPC. */
function submitOf(wallet: Eip1193Request, target: SendTarget, plan: SentPlan, call: TradeCall, gasLimit: bigint): Promise<Hex> {
  const common = { wallet, rpc: target.rpc, chainId: target.chainId, call, from: plan.from, gasLimit };
  return isCoinPlan(plan) ? submitCoinWriteSepolia({ ...common, plan }) : submitTradeWriteSepolia({ ...common, plan });
}

export interface SendOptions {
  readonly target: SendTarget | null;
  readonly signer: { readonly request: Eip1193Request } | null;
  /** The account's slot on the target's chain (trade-inflight.ts `sendKey`); null without an account. */
  readonly slot: string | null;
  /** The page's actions wait (a stale or unverified read): nothing is sent. */
  readonly disabled: boolean;
  readonly receiptTimeoutMs?: number;
  readonly quiet?: { readonly reads: number; readonly ms: number };
  /** A send starts here (or is adopted): what the page is still preparing is dropped. */
  readonly onStart: (sent: SentStep) => void;
  /** A send ended, whichever way: `mined` when the chain mined the plan's own call without a revert. */
  readonly onSettled: (sent: SentStep, mined: boolean) => void;
  /** Anything of the page's that should make it look for a send under way again (its quote's state). */
  readonly watch?: unknown;
  /** How the page shows what a plan spends, for a mined trade's row (no figures without it). */
  readonly amountOf?: AmountOf;
}

export function useSends({ target, signer, slot, disabled, receiptTimeoutMs = RECEIPT_TIMEOUT_MS, quiet = { reads: QUIET_READS, ms: QUIET_MS }, onStart, onSettled, watch, amountOf }: SendOptions) {
  const [flow, setFlow] = useState<SendFlow>({ kind: 'none' });
  const [line, setLine] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<readonly SentReceipt[]>([]);
  // The last press that needed an approval: its two ticks (Steps.tsx), until the page's next amount clears them.
  const [progress, setProgress] = useState<Progress | null>(null);
  // One look at a send under way at a time (the interval and Check again would otherwise overlap).
  const checking = useRef(false);
  const alive = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    alive.current = controller;
    return () => controller.abort();
  }, []);
  // The latest press (a later one, or the page going, ends an earlier one), and what the page last rendered with: a
  // press checks it before its trade, so a read that went stale or a slot that changed meanwhile stops it.
  const runs = useRef(0);
  // A press's step that a slow receipt or an unclear answer left to be followed by its nonce: its tick follows it.
  const lateTick = useRef<{ readonly step: Step } | null>(null);
  const latest = useRef({ slot, disabled });
  useEffect(() => { latest.current = { slot, disabled }; });
  const busy = flow.kind === 'sending' || flow.kind === 'mining' || flow.kind === 'reconcile' || flow.kind === 'checking';

  // A send this account already has under way (this page's before it was left, or another page's): follow it here and
  // hold every new plan until it settles.
  useEffect(() => {
    if (!slot || flow.kind !== 'none' || !inFlightOf(slot)) return undefined;
    const timer = setTimeout(() => {
      const entry = inFlightOf(slot);
      if (!entry) return;
      onStart(entry.sent);
      setLine(entry.asking ? 'asking' : 'earlier_send');
      setFlow((current) => (current.kind !== 'none' ? current : { kind: 'reconcile', ...entry.sent, slotId: entry.id, track: entry.track }));
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `onStart` is the page's; `watch` makes it look again
  }, [slot, flow.kind, watch]);

  // A send under way that the page no longer follows by itself: looked at every few seconds (Check again does it at once).
  useEffect(() => {
    if (flow.kind !== 'reconcile') return undefined;
    const timer = setInterval(() => { void reconcile(flow); }, RECONCILE_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one interval per reconcile state
  }, [flow]);

  /** A transaction's row, added or updated (a send this page adopted has no row yet). */
  const recordReceipt = (row: SentReceipt) => setReceipts((all) => (all.some((r) => r.hash === row.hash)
    ? all.map((r) => (r.hash === row.hash ? { ...r, status: row.status, reason: row.reason, fill: row.fill, figures: row.figures } : r)) : [...all, row]));
  /** What a plan's input still has approved; null when it could not be read (the revocation is offered anyway). */
  const leftApproved = async (plan: SentPlan): Promise<bigint | null> => {
    const spend = spendOf(plan);
    if (!target || !spend) return null;
    return allowanceOf(target.rpc, spend.coin, plan.from, spend.spender).catch(() => null);
  };
  /** This page has gone: it stops after its next read and leaves the send to the next page opened. */
  const gone = () => alive.current?.signal.aborted === true;

  /**
   * One wallet request for one step of a plan, then its receipt: `mined` (at its receipt's block) when the chain mined
   * the step's call without a revert while this page followed it, `pending` when it is left to be followed by its nonce
   * (an unclear answer, a slow receipt), else `failed` (`run`: the press it is a step of, which then goes on).
   */
  async function send(step: Step, plan: SentPlan, call: TradeCall, left: bigint | null = null, run?: number): Promise<SendResult> {
    if (!target || !signer || disabled || !slot) return FAILED;
    const own = slot;
    const blank: SendTrack = { nonceBefore: null, hash: null, quietReads: 0, quietSince: null };
    const provisional: SentStep = { step, plan, call, gasLimit: step === 'trade' ? plan.gasLimit : APPROVAL_GAS_FALLBACK };
    // The account's one slot, taken before anything is awaited: a second press, here or on another page, waits for it.
    const id = beginInFlight(own, { sent: provisional, asking: true, track: blank });
    if (id === null) { setLine('earlier_send'); return FAILED; }
    onStart(provisional);
    setLine(null);
    const asking: SendFlow = { kind: 'sending', ...provisional, run };
    setFlow(asking);
    const gasLimit = step === 'trade' ? plan.gasLimit : await approvalGas(target.rpc, plan.from, call);
    // The account's pending nonce before the wallet is asked: the slot this send takes, or follows. Unread, nothing is
    // asked: without it no later look could tell a mined send from one never sent.
    const nonces = await noncesOf(target.rpc, plan.from).catch(() => null);
    if (gone() || nonces === null) {
      endInFlight(own, id);
      if (!gone()) { setLine('rpc_failed'); setFlow((current) => (current === asking ? { kind: 'none' } : current)); }
      return FAILED;
    }
    const sent: SentStep = { step, plan, call, gasLimit };
    const track: SendTrack = { ...blank, nonceBefore: nonces.pending };
    updateInFlight(own, id, { sent, track });
    const sending: SendFlow = { kind: 'sending', ...sent, run };
    setFlow((current) => (current === asking ? sending : current));
    let hash: Hex;
    try {
      hash = await submitOf(signer.request, target, plan, call, gasLimit);
    } catch (error) {
      const failure = sendFailure(error);
      if (failure.kind === 'unclear') {
        updateInFlight(own, id, { asking: false });
        if (gone()) return FAILED;
        setLine(failure.reason);
        setFlow((current) => (current === sending ? { kind: 'reconcile', ...sent, slotId: id, track } : current));
        return PENDING;
      }
      endInFlight(own, id);
      if (gone()) return FAILED;
      setLine(failure.reason);
      // Nothing was sent: a revocation stays on offer; anything else is prepared again (the plan is spent).
      setFlow((current) => (current === sending ? (step === 'revoke' ? { kind: 'revoke', plan, left } : { kind: 'none' }) : current));
      return FAILED;
    }
    const hashed: SendTrack = { ...track, hash };
    // The hash goes into the slot even when this page has gone: the next page opened follows it from there.
    updateInFlight(own, id, { asking: false, track: hashed });
    if (gone()) return FAILED;
    recordReceipt({ hash, what: describeStep(step, plan, call), status: 'pending', reason: null, fill: null, figures: null });
    const mining: Extract<SendFlow, { kind: 'mining' }> = { kind: 'mining', ...sent, slotId: id, track: hashed, run };
    setFlow((current) => (current === sending ? mining : current));
    return follow(own, mining);
  }

  /**
   * Follows a sent transaction until the chain mines or replaces it, or `receiptTimeoutMs` passes (then: reconcile,
   * `pending`).
   */
  async function follow(own: string, origin: Extract<SendFlow, { kind: 'mining' }>): Promise<SendResult> {
    if (!target) return FAILED;
    const until = Date.now() + receiptTimeoutMs;
    let track = origin.track;
    for (;;) {
      if (gone()) return FAILED;
      try {
        const outcome = await settleSend(target.rpc, origin.plan.from, track, Date.now(), quiet);
        if (gone()) return FAILED;
        if (outcome.kind !== 'waiting') return settled(own, origin.slotId, origin, origin, outcome);
        track = outcome.track;
        updateInFlight(own, origin.slotId, { track });
      } catch { /* A failed read: look again. */ }
      if (Date.now() >= until) break;
      await pause(MINING_POLL_MS);
    }
    if (gone()) return FAILED;
    setLine('receipt_timeout');
    const { step, plan, call, gasLimit, slotId } = origin;
    setFlow((current) => (current === origin ? { kind: 'reconcile', step, plan, call, gasLimit, slotId, track } : current));
    return PENDING;
  }

  /**
   * The end of a send, whichever way the chain settled it: the account's slot is free again, and the page moves on (a
   * press's mined approval to `checking`, its press goes on). `mined` at the receipt's block when the call did not revert.
   */
  async function settled(own: string, id: number, origin: SendFlow, sent: SentStep, outcome: Exclude<Settlement, { kind: 'waiting' }>): Promise<SendResult> {
    if (!target) return FAILED;
    const { step, plan, call, gasLimit } = sent;
    const hash = origin.kind === 'mining' || origin.kind === 'reconcile' ? (inFlightOf(own)?.track.hash ?? origin.track.hash) : null;
    const row = (status: SentReceipt['status'], reason: string | null, fill: Fill | null = null) => {
      if (hash) recordReceipt({ hash, what: describeStep(step, plan, call), status, reason, fill, figures: fill ? fillFigures(fill, amountOf?.(plan) ?? null) : null });
    };
    let next: SendFlow = { kind: 'none' };
    let note: string | null = null;
    let mined = false;
    let success = false;
    let minedAt = 0n;
    if (outcome.kind === 'mined' && outcome.receipt.status === 'reverted') {
      note = await revertReasonOf(target.rpc, plan.from, call, gasLimit, outcome.receipt.blockNumber);
      // A page that has gone leaves the settling (and the revocation's offer) to the next page opened.
      if (gone()) return FAILED;
      row('reverted', note);
    } else if (outcome.kind === 'mined') {
      // What the plan's own call took, as its receipt's events say: a part fill reads as one, whatever the quote expected.
      row('success', null, step === 'trade' ? fillOf(call, outcome.receipt, { from: plan.from, manager: plan.deployment.poolManager }) : null);
      mined = step === 'trade';
      success = true;
      minedAt = outcome.receipt.blockNumber;
    } else if (outcome.kind === 'replaced') {
      note = 'replaced';
      row('replaced', null);
    } else {
      note = outcome.sent ? 'sent_unseen' : 'not_sent';
    }
    // What the plan's input still has approved (a part fill, a revert, a replacement, a send seen only by its nonce):
    // its revocation is offered. Nothing was sent: the next plan uses the approval as it is.
    if (step === 'trade' && plan.revoke && (outcome.kind !== 'settled' || outcome.sent)) {
      const left = await leftApproved(plan);
      if (gone()) return FAILED;
      if (left !== 0n) next = { kind: 'revoke', plan, left };
    }
    // A press's approval, mined while its page followed it: the page holds while the press makes its plan again.
    if (success && step === 'approve' && origin.kind === 'mining' && origin.run !== undefined) next = { kind: 'checking', plan, run: origin.run };
    endInFlight(own, id);
    setLine(note);
    setFlow((current) => (current === origin ? next : current));
    // A press's step that ended only later (a slow receipt, an unclear answer, followed by its nonce): its tick says how.
    const late = lateTick.current;
    if (late && late.step === step && origin.kind === 'reconcile') {
      lateTick.current = null;
      setProgress((ticks) => (!ticks ? ticks : step === 'approve' ? { approve: success ? 'done' : 'stopped', trade: 'waiting' }
        : { approve: ticks.approve, trade: success ? 'done' : 'stopped' }));
    }
    onSettled(sent, mined);
    return success ? { kind: 'mined', block: minedAt } : FAILED;
  }

  /** One look at a send under way that this page follows by its slot. */
  async function reconcile(state: Extract<SendFlow, { kind: 'reconcile' }>) {
    if (!target || !slot || checking.current) return;
    const own = slot;
    checking.current = true;
    try {
      const entry = inFlightOf(own);
      // Settled elsewhere (by the page that sent it, or the wallet refused it there), or a later send holds the slot:
      // this page lets go of it (the effect above adopts a later send).
      if (!entry || entry.id !== state.slotId) {
        setLine(null);
        setFlow((current) => (current === state ? { kind: 'none' } : current));
        onSettled(state, false);
        return;
      }
      if (entry.asking) { setLine('asking'); return; }
      const outcome = await settleSend(target.rpc, entry.sent.plan.from, entry.track, Date.now(), quiet);
      if (gone()) return;
      if (outcome.kind === 'waiting') { updateInFlight(own, entry.id, { track: outcome.track }); return; }
      await settled(own, entry.id, state, entry.sent, outcome);
    } catch { /* The next look reads again. */ } finally {
      checking.current = false;
    }
  }

  /**
   * The plan made again after a mined approval, at or after that approval's block (`atLeast`). A plan from an older
   * block (a node behind the one that gave the receipt) is asked for again, up to `PLAN_BEHIND_TRIES` times, then
   * `plan_behind`; a failure that may pass (`QUIET_REASONS`) and `earlier_send` (a node that has the approval pending but
   * not mined) are each asked for once more, `QUIET_RETRY_MS` later.
   */
  async function planAgain(recheck: () => Promise<Prepared>, atLeast: bigint): Promise<Prepared> {
    const tries = { behind: 0, quiet: 0, earlier: 0 };
    for (;;) {
      const result = await recheck().catch((): Prepared => ({ ok: false, reason: 'rpc_failed' }));
      let again = false;
      let answer = result;
      if (result.ok && result.plan.blockNumber < atLeast) {
        if (tries.behind < PLAN_BEHIND_TRIES) { tries.behind += 1; again = true; } else answer = { ok: false, reason: 'plan_behind' };
      } else if (!result.ok && result.reason === 'earlier_send' && tries.earlier < 1) { tries.earlier += 1; again = true; }
      else if (!result.ok && QUIET_REASONS.has(result.reason) && tries.quiet < 1) { tries.quiet += 1; again = true; }
      if (!again) return answer;
      await pause(QUIET_RETRY_MS);
      if (gone()) return answer;
    }
  }

  /**
   * Whether the page can still send for this press: the same account slot, and a current read of the box. A read that
   * is briefly not current (the page reads the box again after the press's own approval) is waited for, up to
   * `READ_WAIT_MS`. Null when it can; else the reason it stops.
   */
  async function stillReady(own: string): Promise<string | null> {
    for (let waited = 0; latest.current.disabled && latest.current.slot === own && waited < READ_WAIT_MS; waited += 250) {
      await pause(250);
      if (gone()) return null;
    }
    if (latest.current.slot !== own) return 'wallet_account';
    return latest.current.disabled ? 'read_not_current' : null;
  }

  /**
   * SH-ONE-PRESS-TRADE: one press. A plan with its call: that one send. A plan that needs its exact approval: the
   * approval (a reset to zero first when another amount is approved), mined; the plan made again at or after the
   * approval's block (`recheck`), carrying the pressed quote's bound (its price limit or minimum: af1, so the trade
   * sent can end no further below the quote the person saw than their one tolerance); then its trade, only while it is
   * the same trade (`sameTrade`: phase, side, coin and spender) and within the person's limit of the quote they pressed
   * on (`withinLimit`). Otherwise the press stops with its line, and the new quote is handed to the page (`show`), to be
   * shown with its own press. Only a reset may be followed by another approval, the exact one to the same spender. Every
   * step is its own wallet request in the account's one slot (trade-inflight.ts): a browser wallet asks twice, the
   * second time by itself once the approval is mined; the wallet Privy made signs both without a window. A press stops
   * when its page goes, a later press starts, the page's read stays stale or the account changes: nothing the person did
   * not see is sent.
   */
  async function press(plan: SentPlan, options: PressOptions): Promise<void> {
    const run = ++runs.current;
    lateTick.current = null;
    if (plan.reason !== 'approval_required') {
      setProgress(null);
      if (plan.call) await send('trade', plan, plan.call);
      return;
    }
    if (!target || !signer || disabled || !slot) return;
    const own = slot;
    const mine = () => !gone() && runs.current === run;
    // Where a press stops: its line, its ticks, and the page free again.
    const stop = (reason: string | null, ticks: Progress) => {
      setLine(reason);
      setProgress(ticks);
      setFlow((current) => (current.kind === 'checking' && current.run === run ? { kind: 'none' } : current));
    };
    // A press stopped on the price or the trade: the market's own new quote goes to the page, with its own press.
    const stopAndShow = async (reason: string, atLeast: bigint, fallback: SentPlan | null) => {
      const fresh = await planAgain(() => options.recheck(null), atLeast);
      if (!mine()) return;
      stop(reason, { approve: 'done', trade: 'stopped' });
      const shownNext = fresh.ok ? fresh.plan : fallback;
      if (shownNext) options.show(shownNext);
    };
    const shown = figuresOf(plan, options.amountIn);
    const floor = floorOf(plan);
    let current = plan;
    setProgress({ approve: 'active', trade: 'waiting' });
    for (let approvals = 0; approvals < MAX_APPROVALS; approvals += 1) {
      const approval = current.approvals[0];
      if (!approval) break;
      // A reset to zero clears another amount first; the exact amount completes the approval.
      const exact = approvalAmount(approval) !== 0n;
      // A second approval in the press: the page still current, on the same account (as before the trade).
      if (approvals > 0) {
        const blocked = await stillReady(own);
        if (!mine()) return;
        if (blocked) { stop(blocked, { approve: 'stopped', trade: 'waiting' }); return; }
      }
      const sent = await send('approve', current, approval, null, run);
      if (!mine()) return;
      if (sent.kind === 'pending') { lateTick.current = { step: 'approve' }; setProgress({ approve: 'active', trade: 'waiting' }); return; }
      // Not mined (declined, reverted, replaced): the step's own line says why.
      if (sent.kind !== 'mined') { setProgress({ approve: 'stopped', trade: 'waiting' }); return; }
      // The exact approval is in place: the trade's step begins, with the plan made again.
      if (exact) setProgress({ approve: 'done', trade: 'active' });
      const next = await planAgain(() => options.recheck(floor), sent.block);
      if (!mine()) return;
      if (!next.ok) {
        // The pressed quote's bound is passed already: the new quote is shown with its own press.
        if (LIMIT_REASONS.has(next.reason)) { await stopAndShow('price_moved', sent.block, null); return; }
        stop(next.reason, { approve: exact ? 'done' : 'stopped', trade: 'stopped' });
        return;
      }
      // Another trade than the one pressed (the window ended: another phase and spender): stopped, the new one shown.
      if (!sameTrade(plan, next.plan)) { await stopAndShow('trade_changed', sent.block, next.plan); return; }
      if (next.plan.reason === 'approval_required') {
        // Only a reset may be followed by another approval, and only by the exact one to the same spender.
        const following = next.plan.approvals[0];
        if (exact || !following || approvalAmount(following) === 0n) { stop('approval_changed', { approve: 'stopped', trade: 'waiting' }); return; }
        current = next.plan;
        continue;
      }
      const call = next.plan.call;
      const blocked = await stillReady(own);
      if (!mine()) return;
      if (!call || blocked) { stop(blocked, { approve: 'done', trade: 'stopped' }); return; }
      if (!withinLimit(shown, figuresOf(next.plan, options.amountIn), options.toleranceBps)) {
        if (shown.expectedOutput === null) { stop('check_quote', { approve: 'done', trade: 'stopped' }); options.show(next.plan); return; }
        await stopAndShow('price_moved', sent.block, next.plan);
        return;
      }
      setProgress({ approve: 'done', trade: 'active' });
      const traded = await send('trade', next.plan, call, null, run);
      if (!mine()) return;
      if (traded.kind === 'pending') lateTick.current = { step: 'trade' };
      setProgress({ approve: 'done', trade: traded.kind === 'mined' ? 'done' : traded.kind === 'pending' ? 'active' : 'stopped' });
      // A trade that never reached the wallet (the account's slot taken meanwhile) leaves the page free again.
      setFlow((flowNow) => (flowNow.kind === 'checking' && flowNow.run === run ? { kind: 'none' } : flowNow));
      return;
    }
    stop('approval_changed', { approve: 'stopped', trade: 'waiting' });
  }

  /** The revocation is declined (Keep): the page shows its quote again. */
  const keep = () => setFlow((current) => (current.kind === 'revoke' ? { kind: 'none' } : current));

  return { flow, busy, line, setLine, receipts, send, press, progress, setProgress, reconcile, keep };
}

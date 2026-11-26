import { claimLine } from '../alpha-sepolia/alpha-words';
/**
 * F156 (SH-ALPHA-TEST-COINS, work package G phase 2): the Sepolia alpha's test-coin page, in Sepolia builds only (its
 * route is the trade folders' second door, routes.tsx). Numbers first: the faucet's facts for the connected account
 * before a drip is offered (a wallet the faucet does not admit gets one plain line, NOT_ON_LIST_LINE; an admitted one
 * sees when its next drip is due and what is left of today's cap), the balances, and a swap between tETH and each coin
 * the record pairs with it. Every explanation and the tolerance wait behind a closed Details button. Above them, the
 * alpha's Claim card (F161 (4), ClaimCard.tsx): how a tester's wallet joins the faucet's list.
 *
 * The rules are the trade box's (TradeBox.tsx), with the same send engine (use-sends.ts):
 * - The wallet opens only on a press. Without a connected wallet the page reads nothing; the first press opens the
 *   wallet window.
 * - Everything is read with the site's RPC, for the build target's chain (coin-target.ts): the balances and the
 *   faucet's facts at one explicit block (`readCoinStateSepolia`), and a failed read is never shown as zero.
 * - A drip is offered only when the faucet admits the account (or is open to all), its cooldown has passed, today's
 *   cap still holds a drip and the account holds SepETH for its gas (F166 af2, faucet-due.ts `coinsReady`: the sender
 *   lists the wallet first and its starter SepETH minutes later, or both in one block; the chain decides, in either
 *   order). Before that, one line: "Your starter SepETH is on its way" while the claim is under way, "Needs a little
 *   SepETH for gas" otherwise, and a send the wallet refuses for its cost says the same. It is sent with the plan's gas
 *   (`prepareFaucetSepolia`: at least 480,000).
 * - A swap is the trade box's ERC-20 path, in one press (SH-ONE-PRESS-TRADE, use-sends.ts `press`): the exact approval
 *   (a reset first when another amount is approved), a new plan at the block after it, the swap through PoolSwapTest
 *   with a price limit only (it can fill in part; no deadline) when that plan is within the person's tolerance of the
 *   quote they pressed on, then the revocation of what it left approved. A swap quote that fails for a moment (a read
 *   the public RPC did not answer) is made again quietly; its line shows only when two in a row fail.
 * - One send per account at a time (trade-inflight.ts), settled by the chain only (trade-run.ts `settleSend`).
 * - A mined swap's row says what it took, from its receipt (trade-run.ts `fillOf`): "filled in part" when less than
 *   its call offered, after the plan's estimate is gone.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_TOLERANCE_BPS, prepareFaucetSepolia, preparePairSwapSepolia, readCoinStateSepolia, TradeRefusedError, type CoinPlan, type CoinState, type TradeFloor } from '@squarehole/chain/trade-sepolia';
import { createChainReader } from '@squarehole/chain/write';
import { zeroAddress, type Address } from 'viem';
import type { ClaimState } from '../alpha-sepolia/alpha-api';
import { PAGE_TITLE_ID, PageHeading, usePageTitle } from '../../pages/page-parts';
import { BUILD_CORE } from '../core/useCore';
import { sourceV2 } from '../core/v2/indexer-v2';
import { NO_FIGURE, pAmountV2 } from '../core/v2/stats-v2';
import { useDataSource } from '../data-source';
import { formatUtc } from '../fit-pair/fit-format';
import { Details } from '../fit-pair/InfoTip';
import { BrowserWalletDialog, useWallet } from '../wallet';
import { coinAmountOf, coinRevokeLabel, coinTargetOf, type CoinTarget, type CoinView } from './coin-target';
import { ClaimCard } from './ClaimCard';
import { DRIP, PRICE_REQUIRED, coinsReady, dripDue, dripGasNeed, dripGasReason, dripWaitReason, gasPriceOf } from './faucet-due';
import { MadeWalletResume } from './made-wallet';
import { Receipts } from './Receipts';
import { readAmount, readTolerance, tolerancePercent } from './trade-amount';
import { useSetupState } from './setup-run';
import { balanceOf as chainBalanceOf, noncesOf } from './trade-run';
import { sendKey, type SentPlan } from './trade-inflight';
import { QUIET_RETRY_MS, quietFailure } from './one-press';
import { Steps } from './Steps';
import { CHECKING_LABEL, confirmLabel, lineFor, ONE_PRESS_NOTE, PARTIAL_FILL_WARNING, partialFillLine, STEP_WORDS, tradeLine } from './trade-words';
import { isCoinPlan, RECEIPT_TIMEOUT_MS, RECONCILE_MS, useSends } from './use-sends';
import './trade-box.css';
import './test-coins.css';
import { ALPHA_ON } from '../alpha-sepolia/alpha-on';

// The faucet's drip and when it is due, shared with the alpha's "Set me up" (F166, setup-run.ts).
export { DRIP, dripDue, dripWaitReason };
/** The balances and the faucet's facts are read again this often, and after every mined transaction. */
export const STATE_REFRESH_MS = 30_000;
/** A plan this old is prepared again (the send's guard refuses one past its 120 s block-time deadline). */
export const PLAN_REFRESH_MS = 30_000;
/** Typing settles for this long before a swap is quoted. */
export const QUOTE_DEBOUNCE_MS = 350;
/** While the starter coins are on their way, the chain is read this often (they land within seconds of each other, or minutes). */
export const COINS_WAIT_REFRESH_MS = 5_000;

/** The coin state at one block, with the account's SepETH there and the chain's gas price now (null: not read). */
type CoinRead = CoinState & { readonly sepEth: bigint; readonly gasPrice: bigint | null };
/**
 * How long after the sender's "sent" receipt its coins may still be on their way to this page (a node behind the
 * sender's), as the setup reads the chain again for them (setup-run.ts `chainLimitMs`); after it, the plain gas line.
 */
export const COMING_AFTER_SENT_MS = 2 * 60_000;
/**
 * A claim whose starter coins may still be coming at `at` (the chain read's time): queued, or sent less than
 * `COMING_AFTER_SENT_MS` before. Never for long after the receipt: a claim for another wallet must not say it forever.
 */
const coming = (claim: ClaimState | null, at: number): boolean => claim !== null
  && (claim.status === 'queued' || claim.status === 'waiting' || claim.status === 'sending' || (claim.status === 'sent' && claim.at !== null && at - Date.parse(claim.at) < COMING_AFTER_SENT_MS));

type Side = 'buy' | 'sell';
type Card = 'faucet' | 'swap';
type Quote =
  | { readonly kind: 'idle' }
  | { readonly kind: 'preparing'; readonly key: string }
  /** `due`: when the plan is made again, when sooner than half a minute after `at` (a refresh that failed for a moment). */
  | { readonly kind: 'ready'; readonly key: string; readonly plan: CoinPlan; readonly at: number; readonly due?: number }
  /**
   * `nextDripAt`: a drip refused for its cooldown says when the next one is due. `quiet`: a swap's failure that may pass,
   * not said yet; the plan is asked for again at `due` (one-press.ts).
   */
  | { readonly kind: 'refused'; readonly key: string; readonly reason: string; readonly at: number; readonly nextDripAt?: bigint; readonly quiet?: true; readonly due?: number };
type Prepared = { readonly ok: true; readonly plan: CoinPlan } | { readonly ok: false; readonly reason: string; readonly nextDripAt?: bigint };
const keyOf = (quote: Quote): string | null => (quote.kind === 'idle' ? null : quote.key);
const IDLE: Quote = { kind: 'idle' };

/** Which card a plan under way belongs to: the faucet's drip, or a swap (a box trade adopted from another page too). */
const cardOf = (plan: SentPlan): Card => (isCoinPlan(plan) && plan.kind === 'faucet' ? 'faucet' : 'swap');

/**
 * A quote's effect: prepares a plan for `key` once inputs settle, and again before a quote is half a minute old. With
 * `quiet` (the swap's; SH-ONE-PRESS-TRADE item 2), a failure that may pass is not said at once: the plan is made again
 * `QUIET_RETRY_MS` later, a quote on show stays meanwhile, and only a second failure in a row shows its line.
 */
function useQuote(key: string | null, wait: number, blocked: boolean, quote: Quote, setQuote: (update: (current: Quote) => Quote) => void,
  generation: { current: number }, prepare: () => Promise<Prepared>, quiet = false) {
  const quoteKey = keyOf(quote);
  const quoteDue = quote.kind === 'ready' || quote.kind === 'refused' ? quote.due ?? quote.at + PLAN_REFRESH_MS : null;
  // How many plans in a row failed for these inputs.
  const failures = useRef({ key: '', count: 0 });
  useEffect(() => {
    // Inputs that ask for no plan drop the last one: when they come back, so does a fresh plan, never the old one.
    if (key === null) {
      if (quote.kind === 'idle') return undefined;
      const timer = setTimeout(() => setQuote(() => ({ kind: 'idle' })), 0);
      return () => clearTimeout(timer);
    }
    if (blocked) return undefined;
    const same = quoteKey === key;
    if (same && quote.kind === 'preparing') return undefined;
    const delay = same && quoteDue !== null ? Math.max(0, quoteDue - Date.now()) : wait;
    const timer = setTimeout(() => {
      const run = ++generation.current;
      if (!same) setQuote(() => ({ kind: 'preparing', key }));
      // Only the plan of this run, for these inputs, replaces what the card shows.
      const apply = (next: Quote) => setQuote((current) => (run === generation.current && keyOf(current) === key ? next : current));
      // Something pending for the account is looked at again in a few seconds, as the trade box does; any other refusal
      // waits for the next refresh.
      const at = (reason: string) => (reason === 'earlier_send' ? Date.now() - PLAN_REFRESH_MS + RECONCILE_MS : Date.now());
      // A failure that may pass, kept quiet (only with `quiet`): the plan is made again soon; a quote on show stays.
      const refuse = (reason: string, next: Quote) => {
        const inARow = failures.current.key === key ? failures.current.count + 1 : 1;
        failures.current = { key, count: inARow };
        if (!quiet || !quietFailure(reason, inARow)) { apply(next); return; }
        const due = Date.now() + QUIET_RETRY_MS;
        setQuote((current) => (run !== generation.current || keyOf(current) !== key ? current : current.kind === 'ready' ? { ...current, due }
          : { kind: 'refused', key, reason, at: Date.now(), quiet: true, due }));
      };
      void prepare().then(
        (prepared) => {
          if (prepared.ok) { failures.current = { key, count: 0 }; apply({ kind: 'ready', key, plan: prepared.plan, at: Date.now() }); return; }
          refuse(prepared.reason, { kind: 'refused', key, reason: prepared.reason, at: at(prepared.reason), ...(prepared.nextDripAt === undefined ? {} : { nextDripAt: prepared.nextDripAt }) });
        },
        () => refuse('rpc_failed', { kind: 'refused', key, reason: 'rpc_failed', at: Date.now() }));
    }, delay);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` names the inputs a plan is made of
  }, [key, blocked, quote.kind, quoteKey, quoteDue]);
}

export interface TestCoinPageProps {
  /** Test seam: where the coins are, or why not (the build's own target otherwise, coin-target.ts). */
  readonly target?: CoinTarget | { readonly reason: string };
  /** Test seam: how long a receipt is waited for before the page reconciles by nonce. */
  readonly receiptTimeoutMs?: number;
  /** Test seam: how long "nothing pending" must hold before a send without a hash counts as settled. */
  readonly quiet?: { readonly reads: number; readonly ms: number };
  /** Test seam: how often the balances and the faucet's facts are read again. */
  readonly refreshMs?: number;
  /** Test seam: the alpha's Claim card above the coins (F161 (4)); its own tests render it (ClaimCard.test.tsx). */
  readonly claim?: boolean;
  /** Test seam: the claim as the Claim card would hand it up, where the card is not rendered (F166 af2). */
  readonly claimState?: ClaimState | null;
}

// SH-258: the alpha's Claim card (sign-in, claim signature, starter coins) only where the test network has the alpha
// (SH-275: alpha-on.ts; on BNB Chain testnet with its own Privy app, the card offers the starter tBNB and "Set me up",
// and the faucet stays public, its drip offered to any wallet as before).
export function TestCoinPage({ target: given, receiptTimeoutMs = RECEIPT_TIMEOUT_MS, quiet, refreshMs = STATE_REFRESH_MS, claim = ALPHA_ON, claimState }: TestCoinPageProps = {}) {
  usePageTitle('Test coins');
  const data = useDataSource();
  const wallet = useWallet();
  const read = useMemo(() => {
    if (given) return 'chainId' in given ? { ok: true as const, target: given } : { ok: false as const, reason: given.reason };
    const source = (() => { try { return sourceV2(data.id, BUILD_CORE); } catch { return null; } })();
    return coinTargetOf(source);
  }, [given, data.id]);
  const target = read.ok ? read.target : null;

  const account = wallet.status === 'connected' && wallet.kind === 'injected' && wallet.signer ? wallet.account as Address : null;
  const wrongChain = account !== null && target !== null && wallet.chainId !== target.chainId;
  const slot = target && account ? sendKey(target.chainId, account) : null;

  const queries = useQueryClient();
  const [dialog, setDialog] = useState(false);
  const [faucetQuote, setFaucetQuote] = useState<Quote>(IDLE);
  const [swapQuote, setSwapQuote] = useState<Quote>(IDLE);
  const [coinAddress, setCoinAddress] = useState<Address | null>(null);
  const [side, setSide] = useState<Side>('buy');
  const [text, setText] = useState('');
  const [toleranceText, setToleranceText] = useState(tolerancePercent(DEFAULT_TOLERANCE_BPS).slice(0, -1));
  // The card the last send was pressed in (its line shows there).
  const [lineCard, setLineCard] = useState<Card>('swap');
  const button = useRef<HTMLButtonElement>(null);
  // Bumped by every plan started and every send: a plan that resolves after either is dropped.
  const faucetGeneration = useRef(0);
  const swapGeneration = useRef(0);
  // F166 af2: the claim as the Claim card and a "Set me up" run of this visit last read it: are starter coins coming?
  const [cardClaim, setCardClaim] = useState<ClaimState | null>(null);
  const setup = useSetupState();
  const comingAt = (at: number): boolean => coming(setup.phase === 'idle' ? null : setup.claim, at) || coming(claimState === undefined ? cardClaim : claimState, at);
  // The account has never had a drip and is not ready for one: its starter coins may be what it waits for.
  const waitsForCoins = (read: CoinRead): boolean => read.faucet.nextDripAt === 0n && !coinsReady(read.faucet, read.sepEth, dripGasNeed(read.gasPrice));

  // The balances and the faucet's facts at one explicit block, with the site's RPC, once a wallet is connected (on any
  // network: the reads are the site's, only a send needs the wallet on the target's chain).
  const state = useQuery({
    queryKey: ['sh-test-coins', target?.chainId ?? 0, account ?? ''],
    enabled: target !== null && account !== null,
    // While a claim's coins are coming, sooner: the button lights up within seconds of both landing.
    refetchInterval: (query) => (query.state.data && comingAt(query.state.dataUpdatedAt) && waitsForCoins(query.state.data) ? Math.min(COINS_WAIT_REFRESH_MS, refreshMs) : refreshMs),
    retry: false,
    structuralSharing: false,
    queryFn: async (): Promise<CoinRead> => {
      if (!target || !account) throw new Error('no account');
      // The account's SepETH at the same block as the faucet's facts (what pays the drip's gas), and the gas price now.
      const readAt = async (): Promise<CoinRead> => {
        const blockNumber = await createChainReader(target.rpc).blockNumber();
        const coins = await readCoinStateSepolia({ rpc: target.rpc, chainId: target.chainId, from: account, blockNumber,
          ...(target.localDeployment ? { localDeployment: target.localDeployment } : {}) });
        const sepEth = await chainBalanceOf(target.rpc, zeroAddress, account, blockNumber);
        return { ...coins, sepEth, gasPrice: await gasPriceOf(target.rpc) };
      };
      // A public RPC balances its requests across nodes: one may not have the block another just named, or not answer a
      // read at it yet. Once more a second later, with a block named anew; a second failure is said.
      try { return await readAt(); } catch {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return readAt();
      }
    },
  });
  const coinState = state.data ?? null;
  const stateLine = state.error ? (state.error instanceof TradeRefusedError ? state.error.reason : 'rpc_failed') : null;
  const balanceOf = (coin: CoinView): bigint | null => coinState?.balances.find((b) => b.coin.toLowerCase() === coin.address.toLowerCase())?.balance ?? null;

  const sends = useSends({ target, signer: wallet.signer, slot, disabled: false, receiptTimeoutMs, ...(quiet ? { quiet } : {}), watch: `${faucetQuote.kind}|${swapQuote.kind}`,
    // A mined swap's figures, in the coin its own record names (a box trade adopted from a box page: none here).
    amountOf: (plan) => (isCoinPlan(plan) ? coinAmountOf(plan, pAmountV2) : null),
    // A send starts (or is adopted): plans still on their way are dropped, and the spent quotes with them.
    onStart: (sent) => {
      faucetGeneration.current += 1; swapGeneration.current += 1;
      setFaucetQuote(IDLE); setSwapQuote(IDLE); setLineCard(cardOf(sent.plan));
    },
    // A send ended: the balances and the faucet's facts are read again (the last ones stay on show meanwhile). Only this
    // page's own swap clears its amount (a box trade adopted from a box page does not).
    onSettled: (sent, mined) => {
      if (mined && isCoinPlan(sent.plan) && sent.plan.kind === 'pair') setText('');
      void queries.invalidateQueries({ queryKey: ['sh-test-coins'] });
    } });
  const { flow, busy, line, setLine } = sends;
  const flowCard = flow.kind === 'none' ? null : cardOf(flow.plan);

  // The faucet: a drip prepared once the state says one is due, and again before it is half a minute old (in place: the
  // button stays as it is while a fresher plan is made).
  // A drip is due by the faucet's facts AND the account holds SepETH for its gas (at the plan floor's gas until a plan
  // names its own): no plan, no button before both, whichever lands first.
  const paysGas = (gasLimit?: bigint): boolean => coinState !== null && coinState.sepEth >= dripGasNeed(coinState.gasPrice, gasLimit);
  const due = coinState !== null && dripDue(coinState) && paysGas();
  const faucetKey = target && account && due ? `${target.chainId}|${account}|${wallet.chainId}` : null;
  useQuote(faucetKey, 0, flow.kind !== 'none', faucetQuote, setFaucetQuote, faucetGeneration, async () => {
    if (!target || !account) return { ok: false, reason: 'invalid_address' };
    const nonces = await noncesOf(target.rpc, account);
    if (nonces.pending > nonces.latest) return { ok: false, reason: 'earlier_send' };
    return prepareFaucetSepolia({ rpc: target.rpc, chainId: target.chainId, from: account, ...(target.localDeployment ? { localDeployment: target.localDeployment } : {}) });
  });

  // The swap: tETH for the chosen coin (Buy) or the coin for tETH (Sell).
  const coin = target ? (target.pairs.find((c) => c.address === coinAddress) ?? target.pairs[0] ?? null) : null;
  const input = coin && target ? (side === 'buy' ? target.teth : coin) : null;
  const output = coin && target ? (side === 'buy' ? coin : target.teth) : null;
  const amount = readAmount(text, input?.decimals ?? 18);
  const tolerance = readTolerance(toleranceText);
  const swapKey = target && account && input && output && amount.kind === 'ok' && tolerance !== null
    ? `${target.chainId}|${account}|${wallet.chainId}|${input.address}|${output.address}|${amount.raw}|${tolerance}` : null;
  // The swap's plan for these inputs (its quote, and a press's plan made again after its approval: use-sends.ts `press`,
  // with the pressed quote's price limit as its floor, af1).
  const prepareSwap = async (floor: TradeFloor | null = null): Promise<Prepared> => {
    if (!target || !account || !input || !output || amount.kind !== 'ok' || tolerance === null) return { ok: false, reason: 'invalid_amount' };
    const nonces = await noncesOf(target.rpc, account);
    // Something of this account's is still pending: a new plan would queue behind it.
    if (nonces.pending > nonces.latest) return { ok: false, reason: 'earlier_send' };
    return preparePairSwapSepolia({ rpc: target.rpc, chainId: target.chainId, from: account, input: input.address, output: output.address, amountIn: amount.raw,
      toleranceBps: tolerance, ...(floor ? { floor } : {}), ...(target.localDeployment ? { localDeployment: target.localDeployment } : {}) });
  };
  useQuote(swapKey, QUOTE_DEBOUNCE_MS, flow.kind !== 'none', swapQuote, setSwapQuote, swapGeneration, () => prepareSwap(), true);

  // ------------------------------------------------------------------------------------------------ what shows

  const dialogUi = <BrowserWalletDialog open={dialog} onClose={() => setDialog(false)} returnFocus={button} />;
  const page = (children: ReactNode) => (
    <section className="sh-page sh-coins" aria-labelledby={PAGE_TITLE_ID}>
      <div className="sh-page__header"><PageHeading>Test coins</PageHeading></div>
      {/* F161 (4): a device that connected the wallet Privy made gets it back without a window (made-wallet.ts); only
          where the test network has the alpha (SH-258). */}
      {ALPHA_ON ? <MadeWalletResume /> : null}
      {claim ? <ClaimCard onClaim={setCardClaim} /> : null}
      {children}
      {dialogUi}
    </section>
  );
  if (!read.ok) return page(<p className="sh-coins__line" role="status">{tradeLine(read.reason)}</p>);
  if (!target) return page(null);
  if (!account) {
    return page(
      <div className="sh-panel sh-coins__connect">
        <p className="sh-coins__line">Connect a wallet to see your test coins.</p>
        <button ref={button} type="button" className="sh-button sh-button--primary" onClick={() => setDialog(true)}>Connect wallet</button>
      </div>,
    );
  }
  // A wallet on another network: the page stays, with what is under way and the receipts; the idle actions switch.
  const switchChain = () => { void wallet.switchChain(target.chainId).catch(() => setLine('wallet_chain')); };

  const tethBalance = balanceOf(target.teth);
  const faucet = coinState?.faucet ?? null;
  const wait = coinState ? dripWaitReason(coinState) : null;
  // On the faucet's list (or the faucet is open to all): its cooldown and today's cap are this wallet's to see.
  const listed = faucet !== null && (faucet.open || faucet.admitted);
  const faucetPlan = faucetQuote.kind === 'ready' && faucetQuote.key === faucetKey ? faucetQuote.plan : null;
  // A cooldown is a fact of its own (Next drip): its refusal says no more than that.
  const faucetRefused = faucetQuote.kind === 'refused' && faucetQuote.key === faucetKey ? faucetQuote : null;

  // The faucet's one button: the drip once its plan is ready; what is under way when the drip is.
  let dripLabel = `Get ${pAmountV2(DRIP, 18)} tETH`;
  let dripAction: (() => void) | null = null;
  if (flowCard === 'faucet' && flow.kind === 'sending') dripLabel = confirmLabel(wallet.signer?.confirmsInPage === true);
  else if (flowCard === 'faucet' && flow.kind === 'mining') dripLabel = 'Waiting for the chain…';
  else if (flowCard === 'faucet' && flow.kind === 'reconcile') { dripLabel = 'Check again'; const state = flow; dripAction = () => { void sends.reconcile(state); }; }
  else if (flow.kind === 'none' && wrongChain) { dripLabel = 'Switch network'; dripAction = switchChain; }
  // SH-258 round 4: the drip is offered only when nothing stops it (no price reason, no lack of funds).
  else if (flow.kind === 'none' && faucetPlan && faucetPlan.call && coinState !== null && dripGasReason(coinState.gasPrice, coinState.sepEth, faucetPlan.gasLimit) === null) { const call = faucetPlan.call; const plan = faucetPlan; dripAction = () => { void sends.send('trade', plan, call); }; }
  // F166 af2: no drip before the account can pay its gas. A wallet that never had one, with a claim under way, waits for
  // the sender's starter SepETH (on the list or not yet); one that is on the list and due otherwise needs SepETH itself.
  const gasReason = coinState === null || flowCard === 'faucet' ? null
    : comingAt(state.dataUpdatedAt) && waitsForCoins(coinState) ? 'gas_coming'
    : dripDue(coinState) ? dripGasReason(coinState.gasPrice, coinState.sepEth, faucetPlan?.gasLimit)
    : null;
  // What shows under the faucet, first that applies: a drip under way's line; the gas line; why there is no drip now (the
  // state's own reason, so an older line cannot hide it); the last drip's line; the plan's refusal. The cooldown is its
  // own fact (Next drip), so neither the state nor the plan says it again.
  const stateReason = faucet && !due && wait !== 'cooldown_active' ? wait : null;
  // A wallet's error while the account cannot pay the drip's gas is that, whatever the wallet's own words say.
  // SH-258 round 3b: only a lack of funds the reads show is named so; otherwise the send's recorded outcome stays (a
  // request that reached the wallet is never said to be unsent because of a later price read).
  // SH-258 round 4: on BNB Chain testnet never (a send's recorded outcome, the reconciliation line included, stays as
  // recorded); Sepolia keeps its F166 rule.
  const plain = (reason: string | null): string | null => (reason === 'wallet_error' && !PRICE_REQUIRED && coinState !== null && !paysGas() ? 'gas_funds' : reason);
  // A refusal at the press for the cooldown says so until the state shows the cooldown as its fact.
  const lastLine = flow.kind === 'none' && lineCard === 'faucet' && !(line === 'cooldown_active' && wait === 'cooldown_active') ? plain(line) : null;
  const currentClaim = (setup.phase === 'idle' ? null : setup.claim) ?? (claimState === undefined ? cardClaim : claimState);
  // SH-258 round 4: on BNB Chain testnet the last send's recorded outcome has its own line (`lastOutcome`), whatever the
  // next drip's state; the line above speaks of the next drip only.
  const lastOutcome = PRICE_REQUIRED ? lastLine : null;
  const faucetShown = (flowCard === 'faucet' ? plain(line) : null) ?? gasReason ?? stateReason ?? (PRICE_REQUIRED ? null : lastLine)
    ?? (faucetRefused && faucetRefused.reason !== 'cooldown_active' ? faucetRefused.reason : null);
  // The next drip's time: the refusal's own when the plan said so, else the state's.
  const nextDrip = faucetRefused?.nextDripAt ?? faucet?.nextDripAt ?? null;
  const showDrip = due || flowCard === 'faucet';

  // The swap's one button, as the trade box's: one press (the exact approval first when needed, then the swap), the
  // revocation of what was left; what is under way.
  const swapPlan = flowCard === 'swap' && flow.kind !== 'none' && isCoinPlan(flow.plan) ? flow.plan
    : flow.kind === 'none' && swapQuote.kind === 'ready' && swapQuote.key === swapKey ? swapQuote.plan : null;
  // A failure kept quiet (one-press.ts) is not said: the plan is being made again.
  const swapRefused = swapQuote.kind === 'refused' && swapQuote.key === swapKey && !swapQuote.quiet ? swapQuote.reason : null;
  let swapLabel: string = STEP_WORDS.swap;
  let swapAction: (() => void) | null = null;
  if (flowCard === 'swap' && flow.kind === 'sending') swapLabel = confirmLabel(wallet.signer?.confirmsInPage === true);
  else if (flowCard === 'swap' && flow.kind === 'mining') swapLabel = 'Waiting for the chain…';
  else if (flowCard === 'swap' && flow.kind === 'checking') swapLabel = CHECKING_LABEL;
  else if (flowCard === 'swap' && flow.kind === 'reconcile') { swapLabel = 'Check again'; const state = flow; swapAction = () => { void sends.reconcile(state); }; }
  // As the trade box: on another network a revocation on offer waits behind Switch network too.
  else if (wrongChain && (flow.kind === 'none' || flow.kind === 'revoke')) { swapLabel = 'Switch network'; swapAction = switchChain; }
  else if (flow.kind === 'revoke') {
    const { plan: spent, left } = flow;
    // The coin the plan's own record names (a box trade adopted from a box page names none here: no figure).
    swapLabel = isCoinPlan(spent) ? coinRevokeLabel(spent, left, pAmountV2) : 'Revoke approval';
    if (spent.revoke) { const revoke = spent.revoke; swapAction = () => { void sends.send('revoke', spent, revoke, left); }; }
  } else if (flow.kind === 'none' && swapPlan && swapKey !== null && amount.kind === 'ok' && tolerance !== null && (swapPlan.call || swapPlan.reason === 'approval_required')) {
    // One press (SH-ONE-PRESS-TRADE); a plan made after the approval past the person's limit comes back as the quote.
    const plan = swapPlan; const pressKey = swapKey; const amountIn = amount.raw; const toleranceBps = tolerance; const again = prepareSwap;
    const show = (next: SentPlan) => { if (isCoinPlan(next)) setSwapQuote({ kind: 'ready', key: pressKey, plan: next, at: Date.now() }); };
    swapAction = () => { void sends.press(plan, { amountIn, toleranceBps, recheck: again, show }); };
  }
  const typed = amount.kind === 'invalid' ? 'not_a_number' : amount.kind === 'too_precise' ? 'too_precise' : amount.kind === 'too_large' ? 'too_large' : null;
  const swapLine = flowCard === 'swap' || (flow.kind === 'none' && lineCard === 'swap') ? line : null;
  const swapShown = typed ?? swapLine ?? swapRefused ?? (tolerance === null ? 'invalid_tolerance' : null);
  const locked = busy || flow.kind === 'revoke';
  // A plan that needs its approval shows its figures too: the one press sends the swap they describe.
  const expectedOut = swapPlan && flow.kind !== 'revoke' ? swapPlan.expectedOutput : null;
  const partial = swapPlan && flow.kind !== 'revoke' && swapPlan.expectedInput !== null && amount.kind === 'ok' && swapPlan.expectedInput < amount.raw ? swapPlan.expectedInput : null;
  const inputBalance = input ? balanceOf(input) : null;

  return page(
    <>
      <section className="sh-panel sh-trade-box sh-coins__card" aria-label="Faucet" data-flow={flowCard === 'faucet' ? flow.kind : undefined}>
        <h2 className="sh-coins__title">Faucet</h2>
        <dl className="sh-trade-box__figures sh-coins__facts">
          <div><dt>tETH</dt><dd><strong className="sh-trade-box__out">{tethBalance === null ? NO_FIGURE : pAmountV2(tethBalance, 18)}</strong></dd></div>
          {listed && coinState ? (
            <>
              <div><dt>Next drip</dt><dd>{nextDrip === null || nextDrip <= coinState.blockTimestamp ? 'Now' : formatUtc(nextDrip, false)}</dd></div>
              <div><dt>Left today</dt><dd>{`${pAmountV2(faucet.dailyRemaining, 18)} tETH`}</dd></div>
            </>
          ) : null}
        </dl>
        {showDrip ? (
          <div className="sh-trade-box__actions">
            <button ref={button} type="button" className="sh-button sh-button--primary sh-trade-box__go" disabled={dripAction === null} aria-busy={flowCard === 'faucet' && busy ? true : undefined} onClick={() => dripAction?.()}>{dripLabel}</button>
          </div>
        ) : null}
        {state.isLoading ? <p className="sh-coins__line" aria-busy="true">Reading the chain…</p> : null}
        {stateLine ? <p className="sh-coins__line" role="status">{tradeLine(stateLine)}</p> : null}
        {lastOutcome ? <p className="sh-coins__line" data-line="last-send">{tradeLine(lastOutcome)}</p> : null}
        {faucetShown ? <p className="sh-coins__line" role="status">{faucetShown === 'gas_coming' && currentClaim ? claimLine(currentClaim) : tradeLine(faucetShown)}</p> : null}
        <Details name="Faucet">
          <p>{`One drip is ${pAmountV2(DRIP, 18)} tETH, a test coin with no value: one per wallet each cooldown, within a daily cap shared by every wallet.`}</p>
          {coinState ? <p>{`Read at block ${coinState.blockNumber}.`}</p> : null}
        </Details>
      </section>

      <section className="sh-panel sh-trade-box sh-coins__card" aria-label="Balances">
        <h2 className="sh-coins__title">Balances</h2>
        <dl className="sh-trade-box__figures sh-coins__balances">
          {[target.teth, ...target.pairs].map((c) => {
            const raw = balanceOf(c);
            return <div key={c.address}><dt>{c.symbol}</dt><dd>{raw === null ? NO_FIGURE : pAmountV2(raw, c.decimals)}</dd></div>;
          })}
        </dl>
      </section>

      {coin && input && output ? (
        <section className="sh-panel sh-trade-box sh-coins__card" aria-label="Swap" data-flow={flowCard === 'swap' ? flow.kind : undefined}>
          <h2 className="sh-coins__title">Swap</h2>
          <label className="sh-coins__pick">
            <span>Coin</span>
            <select value={coin.address} disabled={locked} onChange={(event) => { setCoinAddress(event.target.value as Address); setText(''); setLine(null); setSwapQuote(IDLE); sends.setProgress(null); }}>
              {target.pairs.map((c) => <option key={c.address} value={c.address}>{c.symbol}</option>)}
            </select>
          </label>
          <fieldset className="sh-trade-box__sides" disabled={locked}>
            <legend className="sh-visually-hidden">Buy or sell</legend>
            {(['buy', 'sell'] as const).map((s) => (
              <label key={s} className="sh-trade-box__side" data-checked={side === s || undefined}>
                <input type="radio" name="coin-side" value={s} checked={side === s} onChange={() => { setSide(s); setText(''); setLine(null); setSwapQuote(IDLE); sends.setProgress(null); }} />
                <span>{s === 'buy' ? `Buy ${coin.symbol}` : `Sell ${coin.symbol}`}</span>
              </label>
            ))}
          </fieldset>
          <label className="sh-trade-box__amount">
            <span className="sh-visually-hidden">{`Amount in ${input.symbol}`}</span>
            <input className="sh-trade-box__input" inputMode="decimal" autoComplete="off" spellCheck={false} placeholder="0" value={text} disabled={locked}
              onChange={(event) => { setText(event.target.value); setLine(null); sends.setProgress(null); }} />
            <span className="sh-trade-box__unit" aria-hidden="true">{input.symbol}</span>
          </label>
          {inputBalance !== null ? <p className="sh-trade-box__balance">{`Balance ${pAmountV2(inputBalance, input.decimals)} ${input.symbol}`}</p> : null}
          {flow.kind === 'revoke' ? null : (
            <dl className="sh-trade-box__figures">
              <div><dt>You get</dt><dd><strong className="sh-trade-box__out">{expectedOut === null ? NO_FIGURE : `≈ ${pAmountV2(expectedOut, output.decimals)}`}</strong> <span className="sh-trade-box__unit">{output.symbol}</span></dd></div>
              <div><dt>Pool fee</dt><dd>0.3%</dd></div>
            </dl>
          )}
          {partial !== null && amount.kind === 'ok' ? <p className="sh-trade-box__note">{partialFillLine(pAmountV2(partial, input.decimals), pAmountV2(amount.raw, input.decimals), input.symbol)}</p> : null}
          <div className="sh-trade-box__actions">
            <button type="button" className="sh-button sh-button--primary sh-trade-box__go" disabled={swapAction === null} aria-busy={flowCard === 'swap' && busy ? true : undefined} onClick={() => swapAction?.()}>{swapLabel}</button>
            {flow.kind === 'revoke' ? <button type="button" className="sh-button" onClick={sends.keep}>Keep</button> : null}
          </div>
          {sends.progress ? <Steps progress={sends.progress} trade={STEP_WORDS.swap} /> : null}
          {flow.kind !== 'revoke' && amount.kind === 'ok' ? <p className="sh-trade-box__warning">{PARTIAL_FILL_WARNING}</p> : null}
          {swapShown ? <p className="sh-trade-box__line" role="status">{lineFor(swapShown, tolerance)}</p> : null}
          <Details name="Swap">
            <label className="sh-trade-box__tolerance">
              <span>Tolerance</span>
              <input inputMode="decimal" autoComplete="off" spellCheck={false} value={toleranceText} disabled={busy} onChange={(event) => setToleranceText(event.target.value)} />
              <span aria-hidden="true">%</span>
            </label>
            <p>0.1% to 20%.</p>
            <p>Through the pool with a price limit only: no minimum and no deadline. It stops at the limit; what is not spent stays with you.</p>
            <p>{ONE_PRESS_NOTE}</p>
            <p>Approvals are exact. What a swap leaves approved can be revoked.</p>
            {swapPlan ? <p>{`Estimates at block ${swapPlan.blockNumber}.`}</p> : null}
          </Details>
        </section>
      ) : null}

      <Receipts receipts={sends.receipts} explorer={target.explorer} />
    </>,
  );
}

